// 滑动窗口密度保护：允许并发运行多个长任务，但防止同一 provider 在短时间窗口内出现
// 人类不可能完成的高密度操作脉冲（burst density）。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "../paths.js";

export const DEFAULT_DENSITY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_DENSITY_MAX_PER_WINDOW = 12; // max 12 submissions per provider per 5 min
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function makeCancelledError() {
  const err = new Error("Operation cancelled during density wait");
  err.code = "CANCELLED";
  return err;
}

function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(makeCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeCancelledError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isNodeTestRunner() {
  return Boolean(process.env.NODE_TEST_CONTEXT) ||
    (Array.isArray(process.execArgv) && process.execArgv.includes("--test"));
}

export function getDensityStorePath(home) {
  return path.join(home || getHomeDir(), "density-window.json");
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function resolveDensityConfig({ windowMs, maxPerWindow } = {}) {
  const effectiveWindowMs = parseNonNegativeInt(
    windowMs ?? process.env.WFA_DENSITY_WINDOW_MS,
    DEFAULT_DENSITY_WINDOW_MS,
  );
  const effectiveMax = parseNonNegativeInt(
    maxPerWindow ?? process.env.WFA_DENSITY_MAX_PER_WINDOW,
    DEFAULT_DENSITY_MAX_PER_WINDOW,
  );
  return {
    windowMs: effectiveWindowMs,
    maxPerWindow: effectiveMax,
  };
}

export function isDensityGuardEnabled(options = {}) {
  if (options.enabled === false) return false;
  if (options.enabled === true) return true;
  if (process.env.WFA_NO_PACE === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  if (isNodeTestRunner()) return false;
  return true;
}

async function readDensityMap(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}

async function writeDensityMap(filePath, map) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const temp = path.join(dir, `density-window.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rename(temp, filePath);
        return;
      } catch (err) {
        if (!TRANSIENT_FS_CODES.has(err?.code) || attempt === 4) throw err;
        await abortableSleep(15 * (2 ** attempt));
      }
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function pruneWindow(timestamps, cutoff) {
  if (!Array.isArray(timestamps)) return [];
  return timestamps
    .map(Number)
    .filter((ts) => Number.isFinite(ts) && ts > cutoff)
    .sort((a, b) => a - b);
}

export async function enforceDensityBudget(home, provider, {
  windowMs,
  maxPerWindow,
  enabled,
  now = Date.now,
  sleep,
  random = Math.random,
  signal,
  onWait,
} = {}) {
  if (!isDensityGuardEnabled({ enabled })) return { sleptMs: 0, countInWindow: 0 };
  const cfg = resolveDensityConfig({ windowMs, maxPerWindow });
  if (cfg.windowMs <= 0 || cfg.maxPerWindow <= 0) {
    return { sleptMs: 0, countInWindow: 0 };
  }

  const key = String(provider || "default").toLowerCase();
  const filePath = getDensityStorePath(home);
  const currentNow = now();
  const map = await readDensityMap(filePath);
  const active = pruneWindow(map[key], currentNow - cfg.windowMs);

  if (active.length < cfg.maxPerWindow) {
    return { sleptMs: 0, countInWindow: active.length };
  }

  if (signal?.aborted) {
    throw makeCancelledError();
  }

  // Wait until the oldest action in the sliding window ages out, plus 1-3s jitter.
  const oldestIdx = active.length - cfg.maxPerWindow;
  const oldestTs = active[oldestIdx];
  const jitter = 1000 + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 2001);
  const waitMs = Math.max(0, (oldestTs + cfg.windowMs) - currentNow) + jitter;

  if (typeof onWait === "function") {
    try { onWait(waitMs); } catch {}
  }

  if (waitMs > 0) {
    if (typeof sleep === "function") {
      await sleep(waitMs, { signal });
    } else {
      await abortableSleep(waitMs, signal);
    }
    if (signal?.aborted) {
      throw makeCancelledError();
    }
  }

  return { sleptMs: waitMs, countInWindow: active.length };
}

export async function recordDensityAction(home, provider, {
  windowMs,
  maxPerWindow,
  enabled,
  now = Date.now,
} = {}) {
  if (!isDensityGuardEnabled({ enabled })) return [];
  const cfg = resolveDensityConfig({ windowMs, maxPerWindow });
  if (cfg.windowMs <= 0 || cfg.maxPerWindow <= 0) return [];

  const key = String(provider || "default").toLowerCase();
  const filePath = getDensityStorePath(home);
  const ts = now();
  const map = await readDensityMap(filePath);
  const pruned = pruneWindow(map[key], ts - cfg.windowMs);
  pruned.push(ts);
  // Keep at most maxPerWindow * 2 recent entries bounded on disk
  map[key] = pruned.slice(-Math.max(cfg.maxPerWindow * 2, 32));
  await writeDensityMap(filePath, map);
  return map[key];
}
