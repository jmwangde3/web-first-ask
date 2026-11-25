import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { clearBrokerRecord, getBrokerPaths, isInstanceAlive, readBrokerRecord } from "./lifecycle.js";
import { readCommit } from "./journal.js";
import { readTurn } from "./turn-store.js";
import { readResult } from "./result-store.js";
import { getBrowserPaths } from "../browser/paths.js";
import { readDevToolsActivePort } from "../browser/launch.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";

const ADAPTERS = Object.freeze({ chatgpt: chatgptAdapter, gemini: geminiAdapter });

function coded(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WAIT_DONE_STATES = new Set(["completed", "failed", "stalled", "needs_human", "takeover"]);
const START_LOCK_STALE_MS = 30000;
const START_LOCK_CORRUPT_GRACE_MS = 1000;
const DEFAULT_SUBMISSION_TIMEOUT_MS = 60000;
const DEFAULT_SUBMISSION_POLL_INTERVAL_MS = 100;
const LIVE_PAGE_PROBE_TIMEOUT_MS = 2000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isValidStartLockEntry(entry) {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    Number.isSafeInteger(entry.pid) &&
    entry.pid > 0 &&
    Number.isFinite(entry.createdAt) &&
    (entry.lockId === undefined || (typeof entry.lockId === "string" && entry.lockId.length > 0))
  );
}

function isStartLockStale(entry, now = Date.now()) {
  if (!isValidStartLockEntry(entry)) return false;
  if (!pidAlive(entry.pid)) return true;
  return now - entry.createdAt > START_LOCK_STALE_MS;
}

async function readStartLockStatus(lockPath) {
  let raw;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", entry: null };
    return { status: "corrupt", entry: null };
  }
  try {
    const parsed = JSON.parse(raw);
    return isValidStartLockEntry(parsed)
      ? { status: "ok", entry: parsed }
      : { status: "corrupt", entry: null };
  } catch {
    return { status: "corrupt", entry: null };
  }
}

async function acquireStartLock(home) {
  const { home: dir } = getBrokerPaths(home);
  const lockPath = path.join(dir, "broker-start.lock");
  await fs.mkdir(dir, { recursive: true });
  const lockId = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now(), lockId }) + "\n";

  for (let attempt = 0; attempt < 4; attempt++) {
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

      let lockState = await readStartLockStatus(lockPath);
      if (lockState.status === "missing") {
        if (attempt < 3) continue;
        return null;
      }
      if (lockState.status === "corrupt") {
        await sleep(25);
        lockState = await readStartLockStatus(lockPath);
        if (lockState.status === "missing") {
          if (attempt < 3) continue;
          return null;
        }
        if (lockState.status === "corrupt") {
          let st;
          try {
            st = await fs.stat(lockPath);
          } catch (statErr) {
            if (statErr?.code === "ENOENT") {
              if (attempt < 3) continue;
              return null;
            }
            const err = coded("BROKER_LOCK_CORRUPT", statErr);
            err.lockPath = lockPath;
            err.message = `BROKER_LOCK_CORRUPT: ${lockPath}`;
            throw err;
          }
          if (Date.now() - st.mtimeMs <= START_LOCK_CORRUPT_GRACE_MS) {
            const err = coded("BROKER_LOCK_CORRUPT");
            err.lockPath = lockPath;
            err.message = `BROKER_LOCK_CORRUPT: corrupt start lock at ${lockPath}`;
            throw err;
          }
          if (await discoverBroker(home)) return null;
          const archived = `${lockPath}.archive-${Date.now()}-${randomUUID()}`;
          try {
            await fs.rename(lockPath, archived);
          } catch (archiveErr) {
            if (archiveErr?.code !== "ENOENT") throw archiveErr;
          }
          if (attempt < 3) continue;
          return null;
        }
      }

      const old = lockState.entry;
      if (!isStartLockStale(old)) return null;

      const latestState = await readStartLockStatus(lockPath);
      if (latestState.status === "ok") {
        const latest = latestState.entry;
        if (!isStartLockStale(latest) || latest.pid !== old.pid ||
            latest.createdAt !== old.createdAt || latest.lockId !== old.lockId) {
          return null;
        }
        await fs.rm(lockPath, { force: true }).catch(() => {});
      } else if (latestState.status === "corrupt") {
        if (attempt < 3) continue;
        return null;
      }
    }
  }
  return null;
}

function normalizeUrlForMatch(value, provider) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const actualProvider = (host === "chatgpt.com" || host === "www.chatgpt.com")
    ? "chatgpt"
    : (host === "gemini.google.com" ? "gemini" : null);
  if (!actualProvider || (provider && actualProvider !== provider)) return null;
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${host}${pathname}${parsed.hash}`;
}

function findMatchingLiveTarget(targets, targetId, conversationUrl, provider) {
  if (targetId) {
    const exact = targets.find((target) => target.targetId === targetId);
    if (exact) return exact;
  }
  const expected = normalizeUrlForMatch(conversationUrl, provider);
  if (!expected) return null;
  return targets.find((target) =>
    normalizeUrlForMatch(target.url, provider) === expected
  ) || null;
}

async function probeLivePage({ home, provider, conversationUrl, targetId, deps = {} } = {}) {
  if (typeof deps.probeLivePage === "function") {
    try {
      return await deps.probeLivePage({ home, provider, conversationUrl, targetId });
    } catch {
      return null;
    }
  }
  const normalizedProvider = typeof provider === "string" ? provider.toLowerCase() : null;
  const adapter = normalizedProvider ? ADAPTERS[normalizedProvider] : null;
  if (!adapter || (!targetId && !conversationUrl)) return null;

  let port = Number.isInteger(deps.chromePort) ? deps.chromePort : null;
  if (!port && home) {
    const readActivePort = deps.readDevToolsActivePort || readDevToolsActivePort;
    const active = await readActivePort(getBrowserPaths(home).profileDir, { timeoutMs: 0 }).catch(() => null);
    port = active?.port ?? null;
  }
  if (!port) return null;

  const connectFn = deps.connectCdp || connectCdp;
  const driver = deps.driver || defaultDriver;
  const listTargetsFn = driver.listPageTargets || defaultDriver.listPageTargets;
  const attachTabFn = driver.attachTab || defaultDriver.attachTab;
  const readStateFn = driver.readTurnState || defaultDriver.readTurnState;

  let cdp = null;
  let timer = null;
  const runProbe = async () => {
    cdp = await connectFn(port);
    const targets = await listTargetsFn(cdp);
    const target = findMatchingLiveTarget(targets, targetId, conversationUrl, normalizedProvider);
    if (!target) return null;
    const attached = await attachTabFn(cdp, target.targetId, { timeoutMs: LIVE_PAGE_PROBE_TIMEOUT_MS });
    const pageState = await readStateFn(cdp, attached.sessionId, adapter);
    return {
      targetId: target.targetId,
      url: target.url || conversationUrl || null,
      answerChars: (pageState?.answerText || "").length,
      answerActionsVisible: pageState?.answerActionsVisible ?? null,
      pendingCount: Number.isInteger(pageState?.pendingCount) ? pageState.pendingCount : 0,
      stopVisible: Boolean(pageState?.stopVisible),
      editorEmpty: pageState?.editorEmpty ?? null,
    };
  };

  try {
    return await Promise.race([
      runProbe(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), LIVE_PAGE_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (cdp && typeof cdp.close === "function") {
      try { cdp.close(); } catch {}
    }
  }
}

export async function diagnoseBrokerUnreachable({ home, turnId, lastTurn = null, deps = {} } = {}) {
  const readCommitFn = deps.readCommit || deps.journal?.readCommit || readCommit;
  const readTurnFn = deps.readTurn || deps.turnStore?.readTurn || readTurn;
  const readResultFn = deps.readResult || deps.resultStore?.readResult || readResult;

  const [journalRecord, turnRecord, resultRecord] = (home && turnId)
    ? await Promise.all([
        Promise.resolve().then(() => readCommitFn(home, turnId)).catch(() => null),
        Promise.resolve().then(() => readTurnFn(home, turnId)).catch(() => null),
        Promise.resolve().then(() => readResultFn(home, turnId)).catch(() => null),
      ])
    : [null, null, null];

  const effectiveTurn = lastTurn || turnRecord || resultRecord || null;
  const hasSendCommitted = Boolean(
    journalRecord != null ||
    lastTurn?.sendCommittedAt != null ||
    turnRecord?.sendCommittedAt != null ||
    resultRecord?.sendCommittedAt != null
  );

  let submissionState;
  let safeToResend;
  if (hasSendCommitted) {
    submissionState = "committed";
    safeToResend = false;
  } else if (effectiveTurn?.state === "queued") {
    submissionState = "not_submitted";
    safeToResend = true;
  } else {
    submissionState = "uncertain";
    safeToResend = false;
  }

  const livePage = await probeLivePage({
    home,
    provider: effectiveTurn?.provider || journalRecord?.provider || null,
    conversationUrl: effectiveTurn?.conversationUrl || turnRecord?.conversationUrl || resultRecord?.conversationUrl || null,
    targetId: effectiveTurn?.targetId || turnRecord?.targetId || resultRecord?.targetId || null,
    deps,
  });

  return { submissionState, safeToResend, livePage };
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

/**
 * Wait only until the browser submission signal is visible through the broker.
 * This is intentionally separate from waitForTurn: no-wait callers must not
 * wait for answer generation or alter the completion-state contract.
 */
export async function waitForSubmission({
  record,
  turnId,
  home,
  timeoutMs = DEFAULT_SUBMISSION_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_SUBMISSION_POLL_INTERVAL_MS,
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
  const effectiveHome = home ?? deps.home;
  const deadline = nowFn() + timeoutMs;

  let currentRecord = record;
  let lastConnError = null;
  let lastTurn = null;

  while (nowFn() < deadline) {
    if (!currentRecord) {
      currentRecord = await discoverBrokerFn(effectiveHome).catch(() => null);
    }

    if (currentRecord) {
      try {
        const response = await getTurnFn(currentRecord, turnId);

        if (response?.status === 404) {
          const error = coded("TURN_NOT_FOUND");
          error.message = `Turn ${turnId} was not found by the broker`;
          error.turnId = turnId;
          throw error;
        }

        if (response?.status === 401 ||
            (Number.isFinite(response?.status) && response.status >= 500)) {
          throw coded("BROKER_UNREACHABLE");
        }

        if (Number.isFinite(response?.status) && response.status >= 400) {
          throw coded("BROKER_ERROR");
        }

        const turn = response?.json;
        if (response?.status === 200 && turn && typeof turn === "object") {
          lastTurn = turn;

          if (turn.sendCommittedAt != null) {
            return turn;
          }

          if (WAIT_DONE_STATES.has(turn.state)) {
            const error = coded("SUBMISSION_NOT_CONFIRMED");
            error.message =
              `Turn ${turnId} ended with state=${turn.state} before sendCommittedAt was recorded`;
            error.turnId = turnId;
            error.turn = turn;
            throw error;
          }
        }

        lastConnError = null;
      } catch (error) {
        if (["TURN_NOT_FOUND", "BROKER_ERROR", "SUBMISSION_NOT_CONFIRMED", "INVALID_ARGUMENT"].includes(error?.code)) {
          throw error;
        }

        if (error?.code !== "BROKER_TIMEOUT" && error?.code !== "BROKER_UNREACHABLE") {
          throw error;
        }

        lastConnError = error;
        currentRecord = await discoverBrokerFn(effectiveHome).catch(() => null);
      }
    }

    const remaining = deadline - nowFn();
    if (remaining <= 0) break;
    await sleepFn(Math.min(pollIntervalMs, remaining));
  }

  const isUnreachable = lastConnError?.code === "BROKER_UNREACHABLE";
  const error = coded(
    isUnreachable ? "BROKER_UNREACHABLE" : "SUBMISSION_TIMEOUT",
    lastConnError
  );

  error.turnId = turnId;
  if (lastTurn) error.turn = lastTurn;

  if (isUnreachable) {
    const diag = await diagnoseBrokerUnreachable({
      home: effectiveHome,
      turnId,
      lastTurn,
      deps,
    });
    error.submissionState = diag.submissionState;
    error.safeToResend = diag.safeToResend;
    error.livePage = diag.livePage;
    error.message = `BROKER_UNREACHABLE: broker connection was lost while confirming submission for turn ${turnId} (submissionState=${diag.submissionState}, safeToResend=${diag.safeToResend})`;
  } else {
    error.message = `SUBMISSION_TIMEOUT: turn ${turnId} did not expose sendCommittedAt within ${timeoutMs}ms`;
  }

  throw error;
}

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
  let lastTurn = null;

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
      if (turn && typeof turn === "object") {
        lastTurn = turn;
      }
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
    const diag = await diagnoseBrokerUnreachable({
      home: effectiveHome,
      turnId,
      lastTurn,
      deps,
    });
    const err = coded("BROKER_UNREACHABLE", lastConnError);
    err.turnId = turnId;
    if (lastTurn) err.turn = lastTurn;
    err.submissionState = diag.submissionState;
    err.safeToResend = diag.safeToResend;
    err.livePage = diag.livePage;
    err.message = `BROKER_UNREACHABLE: lost connection while waiting for turn ${turnId} (submissionState=${diag.submissionState}, safeToResend=${diag.safeToResend})`;
    throw err;
  }
  throw coded("TIMEOUT");
}
