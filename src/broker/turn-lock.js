import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getBrokerPaths } from "./lifecycle.js";

const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A permission or unexpected probe error is not proof of death.
    return error?.code !== "ESRCH";
  }
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

async function retryTransientFs(operation, {
  maxAttempts = 8,
  baseDelayMs = 10,
  maxDelayMs = 160,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_FS_CODES.has(error?.code) || attempt + 1 >= maxAttempts) {
        throw error;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      await sleep(delay);
    }
  }
  throw lastError;
}

async function removeClaimFiles(lockPath, sleep) {
  for (const target of [lockPath, `${lockPath}.choosing`, `${lockPath}.ready`]) {
    await retryTransientFs(() => fs.rm(target, { force: true }), { sleep }).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

// Each contender owns a unique claim basename (<prefix><pid>-<lockId>.lock)
// for its entire lifetime. Choosing is advertised via a separate `.choosing`
// marker file; the complete JSON ticket is published by renaming `.ready` to
// the brand-new `.lock` path (never overwriting an existing `.lock` that
// concurrent contenders may be reading, avoiding Windows MoveFileExW EPERM).
// This is a filesystem-backed bakery lock on a local filesystem. No contender
// ever deletes a reusable shared pathname based on a stale read.
async function readClaim(dir, claim, sleep) {
  const file = path.join(dir, claim.name);
  if (!pidAlive(claim.pid)) {
    await removeClaimFiles(file, sleep);
    return null;
  }
  if (!claim.hasLock) {
    return { choosing: true };
  }
  let raw;
  try {
    raw = await retryTransientFs(() => fs.readFile(file, "utf8"), { maxAttempts: 5, sleep });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!raw.trim()) return { choosing: true };
  const record = JSON.parse(raw);
  if (record.pid !== claim.pid || !Number.isSafeInteger(record.ticket) || record.ticket < 1) {
    throw coded("TURN_LOCK_CORRUPT", `Invalid lock claim ${claim.name}`);
  }
  return record;
}

export async function acquireTurnLock(home, provider = "default", {
  timeoutMs = 900000,
  pollIntervalMs = 200,
  turnId = null,
  conversationId = null,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw coded("INVALID_ARGUMENT", "Invalid turn lock timing");
  }
  const providerKey = String(provider).toLowerCase();
  const convId = typeof conversationId === "string" && conversationId.trim()
    ? conversationId : null;
  const lockId = randomUUID();
  const identity = convId === null
    ? [providerKey, "anonymous", lockId]
    : [providerKey, "named", convId];
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const dir = path.join(getBrokerPaths(home).home, "cdp-turn-locks-v2");
  const prefix = `${key}-`;
  const ownName = `${prefix}${process.pid}-${lockId}.lock`;
  const lockPath = path.join(dir, ownName);
  const choosingPath = `${lockPath}.choosing`;
  const readyPath = `${lockPath}.ready`;
  const deadline = now() + timeoutMs;
  let created = false;
  let acquired = false;

  function check() {
    if (signal?.aborted) throw coded("CANCELLED", "Operation cancelled while acquiring turn lock");
    if (now() >= deadline) {
      throw coded("CONCURRENT_TURN_BUSY", `Conversation ${convId || "new"} on provider ${providerKey} is busy executing another turn`);
    }
  }

  async function contenders({ reapOtherKeys = false } = {}) {
    const names = await fs.readdir(dir);
    const byBase = new Map();
    const otherDeadBases = new Set();

    for (const entry of names) {
      const match = /^(([0-9a-f]{64})-(\d+)-[0-9a-f-]{36}\.lock)(\.choosing)?$/i.exec(entry);
      if (!match) continue;
      const baseName = match[1];
      const pid = Number(match[3]);
      const isChoosing = Boolean(match[4]);
      if (baseName === ownName) continue;

      if (baseName.startsWith(prefix)) {
        const existing = byBase.get(baseName) || { name: baseName, pid, hasLock: false, hasChoosing: false };
        if (isChoosing) existing.hasChoosing = true;
        else existing.hasLock = true;
        byBase.set(baseName, existing);
      } else if (reapOtherKeys && !pidAlive(pid)) {
        otherDeadBases.add(baseName);
      }
    }

    for (const deadBase of otherDeadBases) {
      // Also reap dead anonymous/retired keys that may never recur.
      await removeClaimFiles(path.join(dir, deadBase), sleep);
    }

    return [...byBase.values()];
  }

  try {
    check();
    await fs.mkdir(dir, { recursive: true });
    // Phase 1: advertise "choosing" via a dedicated marker file that is never
    // overwritten by rename.
    const handle = await fs.open(choosingPath, "wx", 0o600);
    created = true;
    await handle.close();

    // Publish choosing before taking a ticket. Ties are broken by the
    // immutable contender name, not clock time or filesystem timestamps.
    let highest = 0;
    for (const claim of await contenders({ reapOtherKeys: true })) {
      check();
      const record = await readClaim(dir, claim, sleep);
      if (record && !record.choosing) highest = Math.max(highest, record.ticket);
    }
    if (highest >= Number.MAX_SAFE_INTEGER) {
      throw coded("TURN_LOCK_CORRUPT", "Turn lock ticket exhausted");
    }
    const ticket = highest + 1;
    // Phase 2: write complete JSON to .ready and atomically create .lock via
    // rename onto a non-existent destination (no overwrite contention on Windows).
    await fs.writeFile(readyPath, JSON.stringify({
      pid: process.pid, lockId, turnId, conversationId: convId,
      provider: providerKey, ticket, acquiredAt: Date.now(),
    }) + "\n", { flag: "wx", mode: 0o600 });
    await retryTransientFs(() => fs.rename(readyPath, lockPath), { sleep });
    // Phase 3: remove .choosing marker after .lock is published.
    await retryTransientFs(() => fs.rm(choosingPath, { force: true }), { sleep });

    for (;;) {
      check();
      let blocked = false;
      for (const claim of await contenders()) {
        check();
        const record = await readClaim(dir, claim, sleep);
        if (!record) continue;
        if (record.choosing || record.ticket < ticket ||
            (record.ticket === ticket && claim.name < ownName)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
    check();
    acquired = true;
    let released = false;
    return {
      lockId,
      lockPath,
      async release() {
        if (released) return;
        // The pathname is unique to this acquisition, even after release.
        await removeClaimFiles(lockPath, sleep);
        released = true;
      },
    };
  } finally {
    if (created && !acquired) {
      await removeClaimFiles(lockPath, sleep).catch(() => {});
    }
  }
}
