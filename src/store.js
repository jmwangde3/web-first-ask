import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { getPaths } from "./paths.js";
import { readJson, sleep, writeJsonAtomic } from "./util.js";
import { WfaError } from "./errors.js";

const EMPTY_TASKS = { version: 1, tasks: {}, requestIndex: {} };
const EMPTY_SESSIONS = { version: 1, workspaces: {} };

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

function lockTimeout() {
  return new WfaError("STORE_LOCK_TIMEOUT", "Timed out waiting for the local task-store lock. Do not start a duplicate request; retry the status command.");
}

export class Store {
  constructor(home) { this.paths = getPaths(home); }

  async withLock(callback, timeoutMs = 15000) {
    await mkdir(this.paths.home, { recursive: true });
    const started = Date.now();
    const token = randomUUID();
    let handle;

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
        // Windows can return EPERM for an existing lock. Do not swallow an
        // unrelated permission failure when the lock path does not exist.
        const info = await stat(this.paths.lock).catch(() => null);
        if (!info) {
          // EEXIST followed by a missing file means the holder released the
          // lock between open() and stat(). That is the normal race, not an
          // error: retry immediately instead of surfacing EEXIST to the caller.
          if (error?.code === "EEXIST") {
            if (Date.now() - started > timeoutMs) throw lockTimeout();
            continue;
          }
          throw error;
        }
        const owner = await lockOwner(this.paths.lock);
        const knownLocalPid = owner?.host === os.hostname() && Number.isInteger(owner.pid);
        // Never reclaim a lock held by a live PID, even when it is old.
        // Doing so would weaken mutual exclusion during long transactions.
        const deadOwner = knownLocalPid && !pidAlive(owner.pid);
        const unknownOldOwner = !knownLocalPid && Date.now() - info.mtimeMs > timeoutMs;
        if (deadOwner || unknownOldOwner) {
          await unlink(this.paths.lock).catch(() => {});
          if (!await stat(this.paths.lock).catch(() => null)) continue;
        }
        if (Date.now() - started > timeoutMs) throw lockTimeout();
        await sleep(50);
      }
    }

    try { return await callback(); }
    finally {
      await handle.close().catch(() => {});
      // Do not delete a newer owner's file if the lock was externally replaced.
      if ((await lockOwner(this.paths.lock))?.token === token) {
        await unlink(this.paths.lock).catch(() => {});
      }
    }
  }

  async transaction(callback, timeoutMs) {
    return this.withLock(async () => {
      const tasks = await readJson(this.paths.tasks, EMPTY_TASKS);
      const sessions = await readJson(this.paths.sessions, EMPTY_SESSIONS);
      const state = { tasks, sessions };
      const result = await callback(state);
      await writeJsonAtomic(this.paths.tasks, state.tasks);
      await writeJsonAtomic(this.paths.sessions, state.sessions);
      return result;
    }, timeoutMs);
  }

  async snapshot() {
    return this.withLock(async () => ({
      tasks: await readJson(this.paths.tasks, EMPTY_TASKS),
      sessions: await readJson(this.paths.sessions, EMPTY_SESSIONS),
    }));
  }
}
