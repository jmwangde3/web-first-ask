import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getHomeDir } from "../paths.js";
import { Store } from "../store.js";

export const DEFAULT_MIN_INTERVAL_MS = {
  chatgpt: 5000,
  gemini: 2000,
};

// F6：从配置解析某 provider 的最小间隔。接受：
//   - 数字：所有 provider 共用；
//   - { chatgpt: ms, gemini: ms } 按 provider 的映射；
//   - { cooldown: {...} | 数字 } 或 { minIntervalMs: 数字 }。
// 非法/缺失值回退到 DEFAULT_MIN_INTERVAL_MS。
export function resolveMinIntervalMs(provider, config) {
  const normalized = String(provider || "").toLowerCase();
  const fallback = DEFAULT_MIN_INTERVAL_MS[normalized] ?? 2000;
  if (config === undefined || config === null) return fallback;
  if (typeof config === "number") {
    return Number.isFinite(config) && config >= 0 ? Math.floor(config) : fallback;
  }
  if (typeof config !== "object") return fallback;
  const inner = config.cooldown !== undefined ? config.cooldown : config;
  if (typeof inner === "number") {
    return Number.isFinite(inner) && inner >= 0 ? Math.floor(inner) : fallback;
  }
  if (inner && typeof inner === "object") {
    const perProvider = inner[normalized];
    if (perProvider !== undefined) {
      return Number.isFinite(perProvider) && perProvider >= 0 ? Math.floor(perProvider) : fallback;
    }
    if (inner.minIntervalMs !== undefined) {
      const v = inner.minIntervalMs;
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
    }
  }
  return fallback;
}

export function getLastTurnPath(home) {
  return path.join(home || getHomeDir(), "last-turn.json");
}

async function readLastTurnMap(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}

export async function enforceCooldown(home, provider, {
  minIntervalMs,
  config,
  now = Date.now,
  sleep: sleepFn = sleep,
  onWait,
} = {}) {
  const normalized = String(provider || "").toLowerCase();
  const targetInterval = minIntervalMs !== undefined
    ? Number(minIntervalMs)
    : resolveMinIntervalMs(normalized, config);

  if (targetInterval <= 0) {
    return { sleptMs: 0 };
  }

  const filePath = getLastTurnPath(home);
  const map = await readLastTurnMap(filePath);

  const entry = map[normalized];
  const raw = entry?.cooldownFinishedAt !== undefined
    ? entry.cooldownFinishedAt
    : entry?.finishedAt;
  const lastFinished = Number(raw) || 0;

  if (lastFinished > 0) {
    const elapsed = now() - lastFinished;
    if (elapsed < targetInterval) {
      const remaining = targetInterval - elapsed;
      if (typeof onWait === "function") {
        try {
          onWait(remaining);
        } catch {}
      }
      await sleepFn(remaining);
      return { sleptMs: remaining };
    }
  }

  return { sleptMs: 0 };
}

export async function recordLastTurn(home, provider, {
  finishedAt = Date.now(),
  status = "completed",
  countsForCooldown = false,
} = {}) {
  const normalized = String(provider || "").toLowerCase();
  const effectiveHome = home || getHomeDir();
  const filePath = getLastTurnPath(effectiveHome);
  const dir = path.dirname(filePath);
  const store = new Store(effectiveHome);
  store.paths.lock = path.join(dir, "last-turn.lock");

  return store.withLock(async () => {
    const map = await readLastTurnMap(filePath);
    const prev = map[normalized] || {};
    const fin = Number(finishedAt) || Date.now();
    const priorCooldown = prev.cooldownFinishedAt !== undefined
      ? (Number(prev.cooldownFinishedAt) || 0)
      : (Number(prev.finishedAt) || 0);

    map[normalized] = {
      finishedAt: fin,
      status: String(status || "unknown"),
      cooldownFinishedAt: countsForCooldown ? Math.max(priorCooldown, fin) : priorCooldown,
    };

    const temporary = path.join(dir, `last-turn.json.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await mkdir(dir, { recursive: true }).catch(() => {});
    try {
      await writeFile(temporary, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await rename(temporary, filePath);
          return map;
        } catch (err) {
          if (attempt === 2 || !["EPERM", "EBUSY"].includes(err?.code)) throw err;
          await sleep(50);
        }
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  });
}
