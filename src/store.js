import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { getPaths } from "./paths.js";
import { readJson, sleep, writeJsonAtomic } from "./util.js";
import { WfaError } from "./errors.js";

const EMPTY_TASKS = { version: 1, tasks: {}, requestIndex: {} };
const EMPTY_SESSIONS = { version: 1, workspaces: {} };

// A store write can take 15-30 s on Windows where a filesystem filter, an
// antivirus scanner or a network redirector intercepts every write to an
// existing file (measured on a real host: 15.6 s, then 30.1 s ending in EPERM,
// while creating a file took 1 ms). Two sessions then deadlock on the 15 s wait
// that used to be the default, so the wait has to cover one holder's writes.
const DEFAULT_LOCK_WAIT_MS = 60000;
const LOCK_NOTICE_AFTER_MS = 750;
const SLOW_WRITE_MS = 2000;
// A lock whose owner is unknown (no pid, or another host) cannot be proven
// dead, so it is only treated as abandoned after this long. Deliberately a
// separate constant from the wait budget: raising one must not change the other.
const UNKNOWN_OWNER_STALE_MS = 10000;
// A reclaim claim is held for milliseconds. One this old belongs to a
// reclaimer that died mid-way, and staleness here is cheap to recover from
// because the lock generation is re-verified after the claim is taken.
const RECLAIM_CLAIM_STALE_MS = 5000;
const RECLAIM_ATTEMPTS = 3;
const RELEASE_GRACE_MS = 1500;

let warnedSlowStore = false;

async function lockOwner(lockPath) {
  try { return JSON.parse(await readFile(lockPath, "utf8")); }
  catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

export function isLockCollision(error) {
  return error?.code === "EEXIST" || error?.code === "EPERM";
}

function lockWaitMs() {
  const raw = Number(process.env.WFA_LOCK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_LOCK_WAIT_MS;
}

function note(message) {
  process.stderr.write(`wfa: ${message}\n`);
}

function describeOwner(owner, info) {
  if (!Number.isInteger(owner?.pid)) {
    const since = info ? new Date(info.mtimeMs).toISOString() : "unknown";
    return `an owner that left no pid (lock last written ${since})`;
  }
  const host = owner.host ? ` on ${owner.host}` : "";
  const age = Number.isFinite(owner.createdAt)
    ? `, acquired ${Math.max(0, Math.round((Date.now() - owner.createdAt) / 1000))}s ago`
    : "";
  return `pid ${owner.pid}${host}${age}`;
}

function sameGeneration(owner, seen) {
  if (!owner || !seen) return false;
  return owner.token === seen.token && owner.pid === seen.pid && owner.createdAt === seen.createdAt;
}

function lockTimeout(lockPath, owner, info, waitedMs) {
  return new WfaError("STORE_LOCK_TIMEOUT",
    `Waited ${Math.round(waitedMs / 1000)}s for the task-store lock ${lockPath}, held by ${describeOwner(owner, info)}. Nothing was sent. If that process is gone, run \`wfa unlock\`; if the file cannot be removed at all, point WFA_HOME at another directory.`,
    { details: { lockPath, owner: owner ?? null } });
}

function lockUnreclaimable(lockPath, owner, error) {
  return new WfaError("STORE_LOCK_UNRECLAIMABLE",
    `The task-store lock ${lockPath} belongs to ${describeOwner(owner)}, which is gone, but the file can be neither renamed nor deleted (${error?.code ?? "unknown error"}). Something still holds a handle on it. Nothing was sent. Run \`wfa unlock\` for the details, point WFA_HOME at another directory, or delete that file by hand.`,
    { details: { lockPath, owner: owner ?? null, code: error?.code ?? null } });
}

function lockUnwritable(lockPath, error) {
  return new WfaError("STORE_LOCK_UNWRITABLE", `Cannot create the task-store lock at ${lockPath} (${error?.code ?? "unknown error"}). Check that the directory is writable.`, { details: { code: error?.code ?? null, path: lockPath } });
}

async function ensureDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    // Windows surfaces a transient EPERM from mkdir(recursive) when another
    // process is creating the same directory or a filter driver is watching it.
    // If the directory is there, the call did its job.
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) throw error;
  }
}

// Waiting on a promise that a filter driver may hold for half a minute is not
// worth blocking shutdown for: the next run reclaims the lock whose owner is
// dead, and this call is only ever a best-effort cleanup.
async function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); });
  await Promise.race([promise.catch(() => {}), timeout]);
  clearTimeout(timer);
}

function noteStoreLatency(elapsedMs, home) {
  if (warnedSlowStore || elapsedMs < SLOW_WRITE_MS) return;
  warnedSlowStore = true;
  note(`a single task-store write took ${(elapsedMs / 1000).toFixed(1)}s (${home}). If every command is slow, a filter driver, antivirus scanner or network redirector is throttling that directory — point WFA_HOME at a fast local volume.`);
}

async function timedWrite(file, value) {
  const started = Date.now();
  await writeJsonAtomic(file, value);
  return Date.now() - started;
}

export class Store {
  constructor(home) { this.paths = getPaths(home); }

  async withLock(callback, timeoutMs = lockWaitMs()) {
    await ensureDirectory(this.paths.home);
    const started = Date.now();
    const token = randomUUID();
    let handle;
    let noticed = false;
    let reclaimFailures = 0;
    let lastError = null;

    while (!handle) {
      try {
        handle = await open(this.paths.lock, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({
            pid: process.pid, host: os.hostname(), createdAt: Date.now(), token,
          }));
        } catch (error) {
          await handle.close().catch(() => {});
          handle = null;
          await unlink(this.paths.lock).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (!isLockCollision(error)) throw error;
        lastError = error;
        // Windows can return EPERM for an existing lock. Do not swallow an
        // unrelated permission failure when the lock path does not exist.
        const info = await stat(this.paths.lock).catch(() => null);
        if (!info) {
          // A missing lock after a collision means the holder released it
          // between open() and stat(). That is the normal hand-off, not an
          // error: retry instead of surfacing EEXIST/EPERM to the caller. On
          // Windows the release also shows up as EPERM while the file sits in
          // delete-pending state, so both codes land here. A genuinely
          // unwritable directory keeps failing and is reported at the timeout.
          if (Date.now() - started > timeoutMs) {
            throw error?.code === "EPERM" ? lockUnwritable(this.paths.lock, error) : lockTimeout(this.paths.lock, null, null, Date.now() - started);
          }
          if (error?.code === "EPERM") await sleep(10);
          continue;
        }
        const owner = await lockOwner(this.paths.lock);
        const knownLocalPid = owner?.host === os.hostname() && Number.isInteger(owner.pid);
        // Never reclaim a lock held by a live PID, even when it is old.
        // Doing so would weaken mutual exclusion during long transactions.
        const deadOwner = knownLocalPid && !pidAlive(owner.pid);
        const unknownOldOwner = !knownLocalPid && Date.now() - info.mtimeMs > UNKNOWN_OWNER_STALE_MS;
        if (deadOwner || unknownOldOwner) {
          if (await this.reclaimLock(owner)) { reclaimFailures = 0; continue; }
          // A dead owner whose file can be neither renamed nor deleted is held
          // open by something else. Waiting the full timeout cannot help.
          reclaimFailures += 1;
          if (reclaimFailures >= RECLAIM_ATTEMPTS) throw lockUnreclaimable(this.paths.lock, owner, lastError);
          await sleep(50);
          continue;
        }
        if (!noticed && Date.now() - started > LOCK_NOTICE_AFTER_MS) {
          noticed = true;
          note(`waiting for the task-store lock ${this.paths.lock} (${describeOwner(owner, info)}).`);
        }
        if (Date.now() - started > timeoutMs) throw lockTimeout(this.paths.lock, owner, info, Date.now() - started);
        await sleep(50);
      }
    }

    try { return await callback(); }
    finally {
      await handle.close().catch(() => {});
      // Do not delete a newer owner's file if the lock was externally replaced.
      if ((await lockOwner(this.paths.lock))?.token === token) {
        await within(unlink(this.paths.lock), RELEASE_GRACE_MS);
      }
    }
  }

  // Reclaiming a dead owner's lock has to be serialized: two waiters that both
  // observed the same dead generation could otherwise rename the *next* lock
  // (the one the other waiter just created) and both enter the critical
  // section. A separate claim file gives exactly one reclaimer, which then
  // re-verifies the generation before touching the file. The generation check
  // is what makes this safe without a compare-and-rename primitive: only the
  // reclaimer renames, and it renames only the file it observed.
  async reclaimLock(seenOwner = null) {
    const claim = `${this.paths.lock}.reclaim`;
    const claimHandle = await this.takeReclaimClaim(claim);
    if (!claimHandle) return false;
    try {
      const current = await lockOwner(this.paths.lock);
      const currentInfo = await stat(this.paths.lock).catch(() => null);
      if (!currentInfo) return true;
      const localOwner = current?.host === os.hostname() && Number.isInteger(current.pid);
      if (localOwner && pidAlive(current.pid)) return false;
      if (seenOwner && current && !sameGeneration(current, seenOwner)) return false;
      if (!localOwner && Date.now() - currentInfo.mtimeMs <= UNKNOWN_OWNER_STALE_MS) return false;
      const stale = `${this.paths.lock}.stale-${current?.token ?? "unknown"}-${Date.now()}`;
      try {
        await rename(this.paths.lock, stale);
      } catch {
        try {
          await unlink(this.paths.lock);
        } catch {
          return false;
        }
        return true;
      }
      await within(unlink(stale), RELEASE_GRACE_MS);
      return true;
    } finally {
      await claimHandle.close().catch(() => {});
      await within(unlink(claim), RELEASE_GRACE_MS);
    }
  }

  async takeReclaimClaim(claim) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await open(claim, "wx", 0o600);
      } catch (error) {
        if (!isLockCollision(error)) return null;
        // A reclaimer that died leaves the claim behind. It is only ever held
        // for milliseconds, so an old one is safe to drop -- and if it cannot
        // be dropped, reclaiming is impossible and the caller stays blocked.
        const info = await stat(claim).catch(() => null);
        if (!info) continue;
        if (Date.now() - info.mtimeMs < RECLAIM_CLAIM_STALE_MS) return null;
        await within(unlink(claim), RELEASE_GRACE_MS);
      }
    }
    return null;
  }

  async unlock() {
    const info = await stat(this.paths.lock).catch(() => null);
    if (!info) return { removed: false, owner: null, reason: "no lock file", path: this.paths.lock };
    const owner = await lockOwner(this.paths.lock);
    const localOwner = owner?.host === os.hostname() && Number.isInteger(owner.pid);
    if (localOwner && pidAlive(owner.pid)) {
      return { removed: false, owner, reason: `held by live pid ${owner.pid}; not stealing it`, path: this.paths.lock };
    }
    const removed = await this.reclaimLock(owner);
    return { removed, owner, path: this.paths.lock,
      reason: removed ? "stale lock cleared" : "the file can be neither renamed nor deleted; something still holds a handle on it" };
  }

  async transaction(callback, timeoutMs) {
    return this.withLock(async () => {
      const tasks = await readJson(this.paths.tasks, EMPTY_TASKS);
      const sessions = await readJson(this.paths.sessions, EMPTY_SESSIONS);
      const before = { tasks: JSON.stringify(tasks), sessions: JSON.stringify(sessions) };
      const hadSessions = Boolean(await stat(this.paths.sessions).catch(() => null));
      const state = { tasks, sessions };
      const result = await callback(state);
      // Only rewrite what changed: on a throttled volume every avoided write is
      // 15-30 s the next lock holder does not have to wait for.
      if (JSON.stringify(state.tasks) !== before.tasks) {
        noteStoreLatency(await timedWrite(this.paths.tasks, state.tasks), this.paths.home);
      }
      if (!hadSessions || JSON.stringify(state.sessions) !== before.sessions) {
        noteStoreLatency(await timedWrite(this.paths.sessions, state.sessions), this.paths.home);
      }
      return result;
    }, timeoutMs);
  }

  // Reads do not take the write lock. Each file is replaced atomically, so a
  // reader sees either the old or the new tasks.json; taking an exclusive lock
  // for a read is what made `wfa list` unusable while another session held it.
  // The trade-off is that tasks.json and sessions.json can briefly disagree,
  // which is why a snapshot is a preview, never the basis for a commit.
  async snapshot() {
    return {
      tasks: await readJson(this.paths.tasks, EMPTY_TASKS),
      sessions: await readJson(this.paths.sessions, EMPTY_SESSIONS),
    };
  }
}
