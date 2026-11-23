import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { clearBrokerRecord, getBrokerPaths, isInstanceAlive, readBrokerRecord } from "./lifecycle.js";

function coded(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WAIT_DONE_STATES = new Set(["completed", "failed", "stalled", "needs_human", "takeover"]);
const START_LOCK_STALE_MS = 30000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isStartLockStale(entry, now = Date.now()) {
  if (!entry || typeof entry !== "object") return false;
  if (!pidAlive(entry.pid)) return true;
  return !Number.isFinite(entry.createdAt) || (now - entry.createdAt > START_LOCK_STALE_MS);
}

async function readStartLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function acquireStartLock(home) {
  const { home: dir } = getBrokerPaths(home);
  const lockPath = path.join(dir, "broker-start.lock");
  await fs.mkdir(dir, { recursive: true });
  const lockId = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now(), lockId }) + "\n";

  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const stored = JSON.parse(await fs.readFile(lockPath, "utf8"));
            if (stored.lockId === lockId) {
              await fs.rm(lockPath, { force: true }).catch(() => {});
            }
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        if (error?.code !== "EEXIST") await fs.rm(lockPath, { force: true }).catch(() => {});
      }
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 2) return null;

      let old = await readStartLock(lockPath);
      if (!old) {
        await sleep(25);
        old = await readStartLock(lockPath);
        if (!old) {
          try {
            const st = await fs.stat(lockPath);
            if (Date.now() - st.mtimeMs <= START_LOCK_STALE_MS) return null;
          } catch (statErr) {
            if (statErr?.code === "ENOENT") continue;
            return null;
          }
          await fs.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
      }
      if (!isStartLockStale(old)) return null;

      const latest = await readStartLock(lockPath);
      if (latest && (!isStartLockStale(latest) || latest.pid !== old.pid ||
          latest.createdAt !== old.createdAt || latest.lockId !== old.lockId)) {
        return null;
      }
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }
  return null;
}

export async function discoverBroker(home) {
  const record = await readBrokerRecord(home);
  return record && await isInstanceAlive(record) ? record : null;
}

export async function ensureBroker({ home, spawnBroker, timeoutMs = 30000 } = {}) {
  if (typeof spawnBroker !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw coded("INVALID_ARGUMENT");
  }
  const existing = await discoverBroker(home);
  if (existing) return existing;

  const deadline = Date.now() + timeoutMs;
  const startLock = await acquireStartLock(home);
  if (startLock) {
    try {
      const rechecked = await discoverBroker(home);
      if (rechecked) return rechecked;

      const stale = await readBrokerRecord(home);
      if (stale && !pidAlive(stale.pid)) {
        await clearBrokerRecord(home, stale.instanceId);
      }

      const remaining = Math.max(1, deadline - Date.now());
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => spawnBroker()),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(coded("BROKER_TIMEOUT")), remaining);
          }),
        ]);
      } catch (error) {
        // Another caller may have won the instance lock and be starting the broker.
        if (error?.code !== "BROKER_LOCKED") throw error;
      } finally {
        clearTimeout(timer);
      }

      while (Date.now() < deadline) {
        const record = await discoverBroker(home);
        if (record) return record;
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      }
      throw coded("BROKER_TIMEOUT");
    } finally {
      await startLock.release().catch(() => {});
    }
  }

  while (Date.now() < deadline) {
    const record = await discoverBroker(home);
    if (record) return record;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw coded("BROKER_TIMEOUT");
}

export async function request(record, method, route, body) {
  if (!record || record.host !== "127.0.0.1" || !Number.isInteger(record.port) ||
      record.port < 1 || record.port > 65535 || typeof record.token !== "string" ||
      typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) {
    throw coded("INVALID_ARGUMENT");
  }
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}${route}`, {
      method,
      headers: { "x-wfa-token": record.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    let json;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw coded("BROKER_TIMEOUT", error);
    }
    throw coded("BROKER_UNREACHABLE", error);
  }
}

export const getStatus = record => request(record, "GET", "/status");
export const createTurn = (record, payload) => request(record, "POST", "/turns", payload);
export const getTurn = (record, id) => request(record, "GET", `/turns/${encodeURIComponent(id)}`);
export const cancelTurn = (record, id) => request(record, "POST", `/turns/${encodeURIComponent(id)}/cancel`);

export async function waitForTurn({
  record,
  turnId,
  home,
  timeoutMs = 900000,
  pollIntervalMs = 1000,
  onProgress,
  deps = {},
} = {}) {
  if (!record || typeof turnId !== "string" || !turnId.trim() ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw coded("INVALID_ARGUMENT");
  }
  const getTurnFn = deps.getTurn || getTurn;
  const discoverBrokerFn = deps.discoverBroker || discoverBroker;
  const sleepFn = deps.sleep || sleep;
  const nowFn = deps.now || (() => Date.now());
  const onProgressFn = onProgress || deps.onProgress;
  const effectiveHome = home ?? deps.home;
  const deadline = nowFn() + timeoutMs;

  let currentRecord = record;
  let consecutiveFailures = 0;
  let backoffMs = 500;
  let lastConnError = null;

  while (nowFn() < deadline) {
    // After an UNREACHABLE error, re-discover before polling again: the old
    // record's port is likely dead. Never re-submit the turn, only re-discover.
    if (lastConnError?.code === "BROKER_UNREACHABLE") {
      const reconnected = await discoverBrokerFn(effectiveHome).catch(() => null);
      if (reconnected) currentRecord = reconnected;
    }
    try {
      const res = await getTurnFn(currentRecord, turnId);
      if (res?.status === 401) {
        const refreshed = await discoverBrokerFn(effectiveHome).catch(() => null);
        if (refreshed) {
          currentRecord = refreshed;
          continue;
        }
      }
      consecutiveFailures = 0;
      backoffMs = 500;
      lastConnError = null;

      const turn = res?.json;
      if (turn && WAIT_DONE_STATES.has(turn.state)) {
        return turn;
      }
      if (turn && typeof onProgressFn === "function") {
        onProgressFn(turn);
      }
      const remaining = deadline - nowFn();
      if (remaining <= 0) break;
      await sleepFn(Math.min(pollIntervalMs, remaining));
    } catch (error) {
      if (error?.code !== "BROKER_TIMEOUT" && error?.code !== "BROKER_UNREACHABLE") {
        throw error;
      }
      consecutiveFailures += 1;
      lastConnError = error;

      if (error.code === "BROKER_UNREACHABLE" || consecutiveFailures >= 2) {
        const discovered = await discoverBrokerFn(effectiveHome).catch(() => null);
        if (discovered) {
          currentRecord = discovered;
        }
      }

      const remaining = deadline - nowFn();
      if (remaining <= 0) break;
      await sleepFn(Math.min(backoffMs, remaining));
      backoffMs = Math.min(5000, backoffMs * 2);
    }
  }

  if (lastConnError) {
    const err = coded("BROKER_UNREACHABLE", lastConnError);
    err.message = `BROKER_UNREACHABLE: lost connection while waiting for turn ${turnId}`;
    throw err;
  }
  throw coded("TIMEOUT");
}
