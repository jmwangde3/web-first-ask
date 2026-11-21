import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const uuid = () => randomUUID();

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(tempPath, 0o600);
  } catch {
    // Windows ACL inheritance is used when POSIX mode bits are unavailable.
  }
  await rename(tempPath, filePath);
}

export function truncate(value, max = 2000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

export function slug(value, label = "value") {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`${label} must be 1–64 characters: letters, digits, dot, underscore or hyphen; it must start with a letter or digit.`);
  }
  if (normalized === "." || normalized === "..") throw new Error(`Invalid ${label}.`);
  return normalized;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Windows and Linux both recycle pids, so `isPidAlive(task.parentPid)` alone can
// report a dead owner as alive and lock a task forever. A task that records a
// heartbeat is only considered owned while that heartbeat is fresh; legacy tasks
// without a heartbeat keep the previous pid-only behaviour.
export const OWNER_HEARTBEAT_STALE_MS = 180000;

export function owningProcessAlive(task, { now = Date.now(), staleMs = OWNER_HEARTBEAT_STALE_MS } = {}) {
  if (!task?.parentPid) return false;
  if (!isPidAlive(task.parentPid)) return false;
  if (!task.heartbeatAt) return true;
  const beat = Date.parse(task.heartbeatAt);
  return Number.isFinite(beat) && now - beat < staleMs;
}

export function startHeartbeat({ taskId, store, intervalMs = 45000 }) {
  let stopped = false;
  const beat = () => {
    if (stopped) return;
    store.transaction(({ tasks }) => {
      const task = tasks.tasks[taskId];
      if (task) task.heartbeatAt = new Date().toISOString();
    }).catch(() => {});
  };
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function safeError(error) {
  return truncate(error instanceof Error ? error.message : String(error), 1500);
}
