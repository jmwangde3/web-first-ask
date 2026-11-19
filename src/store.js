import os from "node:os";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { getPaths } from "./paths.js";
import { readJson, sleep, writeJsonAtomic } from "./util.js";
import { WfaError } from "./errors.js";

const EMPTY_TASKS = { version: 1, tasks: {}, requestIndex: {} };
const EMPTY_SESSIONS = { version: 1, workspaces: {} };

async function lockOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

export class Store {
  constructor(home) {
    this.paths = getPaths(home);
  }

  async withLock(callback, timeoutMs = 15000) {
    await mkdir(this.paths.home, { recursive: true });
    const started = Date.now();
    let handle;

    while (!handle) {
      try {
        handle = await open(this.paths.lock, "wx", 0o600);
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          createdAt: Date.now(),
        }));
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;

        const owner = await lockOwner(this.paths.lock);
        if (owner?.host === os.hostname() && Number.isInteger(owner.pid)) {
          let alive = true;
          try {
            process.kill(owner.pid, 0);
          } catch (probeError) {
            alive = probeError?.code === "EPERM";
          }
          if (!alive) {
            await unlink(this.paths.lock).catch(() => {});
            continue;
          }
        } else if (!owner) {
          try {
            const info = await stat(this.paths.lock);
            if (Date.now() - info.mtimeMs > 30000) {
              await unlink(this.paths.lock).catch(() => {});
              continue;
            }
          } catch {
            continue;
          }
        }

        if (Date.now() - started > timeoutMs) {
          throw new WfaError("STORE_LOCK_TIMEOUT", "Timed out waiting for the local task-store lock. Do not start a duplicate request; retry the status command.");
        }
        await sleep(50);
      }
    }

    try {
      return await callback();
    } finally {
      await handle.close().catch(() => {});
      await unlink(this.paths.lock).catch(() => {});
    }
  }

  async transaction(callback) {
    return this.withLock(async () => {
      const tasks = await readJson(this.paths.tasks, EMPTY_TASKS);
      const sessions = await readJson(this.paths.sessions, EMPTY_SESSIONS);
      const state = { tasks, sessions };
      const result = await callback(state);
      await writeJsonAtomic(this.paths.tasks, state.tasks);
      await writeJsonAtomic(this.paths.sessions, state.sessions);
      return result;
    });
  }

  async snapshot() {
    return this.withLock(async () => ({
      tasks: await readJson(this.paths.tasks, EMPTY_TASKS),
      sessions: await readJson(this.paths.sessions, EMPTY_SESSIONS),
    }));
  }
}
