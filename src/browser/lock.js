
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

function validLock(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== 1) return false;
  if (value.phase !== "launching" && value.phase !== "ready") return false;
  if (!Number.isSafeInteger(value.brokerPid) || value.brokerPid <= 0) return false;
  if (typeof value.brokerInstanceId !== "string" || !value.brokerInstanceId) return false;
  if (!Number.isFinite(Date.parse(value.brokerStartedAt))) return false;
  if (typeof value.userDataDir !== "string" || !value.userDataDir) return false;
  if (value.chromePath != null && typeof value.chromePath !== "string") return false;
  if (value.phase === "launching") {
    if (value.chromePid !== null || value.chromeStartedAt !== null || value.actualDebugPort !== null) return false;
  } else if (!Number.isSafeInteger(value.chromePid) || value.chromePid <= 0) {
    return false;
  }
  if (value.chromeStartedAt != null && !Number.isFinite(Date.parse(value.chromeStartedAt))) return false;
  if (value.actualDebugPort != null && (!Number.isInteger(value.actualDebugPort) || value.actualDebugPort < 1 || value.actualDebugPort > 65535)) return false;
  return true;
}

export async function readLock(lockPath) {
  let body;
  try {
    body = await readFile(lockPath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? { status: "missing", lock: null }
      : { status: "corrupt", lock: null, error: error?.code ?? String(error) };
  }
  try {
    const lock = JSON.parse(body);
    if (!validLock(lock)) throw new Error("INVALID_LOCK_SCHEMA");
    return { status: "ok", lock };
  } catch (error) {
    return { status: "corrupt", lock: null, error: error?.message ?? String(error) };
  }
}

export async function writeLockAtomic(lockPath, lock) {
  if (!validLock(lock)) throw new Error("INVALID_LOCK_SCHEMA");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const temporary = `${lockPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await rename(temporary, lockPath);
        return;
      } catch (error) {
        if (attempt || !["EPERM", "EBUSY"].includes(error?.code)) throw error;
        await sleep(50);
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function archiveLock(lockPath) {
  const archived = `${lockPath}.archive-${Date.now()}-${randomUUID()}`;
  try {
    await rename(lockPath, archived);
    return archived;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
