import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const defaultHome = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "web-first-ask");
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

async function retryTransientFs(operation, {
  maxAttempts = 8,
  baseDelayMs = 10,
  maxDelayMs = 160,
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
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function getBrokerPaths(home = defaultHome()) {
  const resolved = path.resolve(home);
  return {
    home: resolved,
    brokerJson: path.join(resolved, "broker.json"),
    logDir: path.join(resolved, "logs"),
  };
}

export async function readBrokerRecord(home) {
  try {
    const value = JSON.parse(await fs.readFile(getBrokerPaths(home).brokerJson, "utf8"));
    return value?.schema === 1 && typeof value.instanceId === "string" &&
      Number.isInteger(value.pid) && value.pid > 0 &&
      value.host === "127.0.0.1" && Number.isInteger(value.port) &&
      value.port > 0 && value.port < 65536 && typeof value.token === "string"
      ? value : null;
  } catch {
    return null;
  }
}

export async function writeBrokerRecord(home, record) {
  const { home: dir, brokerJson } = getBrokerPaths(home);
  await fs.mkdir(dir, { recursive: true });
  const temp = `${brokerJson}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await retryTransientFs(() => fs.rename(temp, brokerJson));
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export async function clearBrokerRecord(home, expectedInstanceId) {
  const file = getBrokerPaths(home).brokerJson;
  if (expectedInstanceId !== undefined) {
    const current = await readBrokerRecord(home);
    if (!current || current.instanceId !== expectedInstanceId) return;
  }
  try {
    await retryTransientFs(() => fs.rm(file, { force: true }));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (expectedInstanceId !== undefined) {
    const after = await readBrokerRecord(home);
    if (after && after.instanceId !== expectedInstanceId) return;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function fetchStatusOnce(record, timeoutMs) {
  const response = await fetch(`http://127.0.0.1:${record.port}/status`, {
    headers: { "x-wfa-token": record.token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return { ok: false, retryable: false };
  const data = await response.json();
  return { ok: data.instanceId === record.instanceId && data.pid === record.pid, retryable: false };
}

export async function isInstanceAlive(record) {
  if (!record || !pidAlive(record.pid) || record.host !== "127.0.0.1" ||
      !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.token !== "string") return false;
  for (const timeoutMs of [300, 600]) {
    try {
      const result = await fetchStatusOnce(record, timeoutMs);
      return result.ok;
    } catch {
      if (timeoutMs === 600 || !pidAlive(record.pid)) return false;
    }
  }
  return false;
}

// Only ESRCH proves that the recorded process no longer exists.
// Permission failures and unexpected probe errors do not permit reclamation.
function instancePidConfirmedDead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// undefined: absent; null: malformed; object: valid owner record.
async function readInstanceOwner(lockPath) {
  let raw;

  try {
    raw = await retryTransientFs(() => fs.readFile(lockPath, "utf8"), { maxAttempts: 5 });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const record = JSON.parse(raw);
    if (!record ||
        !Number.isSafeInteger(record.pid) ||
        record.pid <= 0 ||
        typeof record.instanceId !== "string" ||
        !record.instanceId) {
      return null;
    }
    return record;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function canReplaceInstanceOwner(owner) {
  return owner === undefined ||
    (owner !== null && instancePidConfirmedDead(owner.pid));
}

export async function acquireInstanceLock(home) {
  const { home: dir } = getBrokerPaths(home);
  const lockPath = path.join(dir, "broker.lock");

  await fs.mkdir(dir, { recursive: true });

  // Fast rejection only. An observation made without the guard must
  // never authorize a write, rename, or removal of the shared pathname.
  const observed = await readInstanceOwner(lockPath);
  if (!canReplaceInstanceOwner(observed)) return null;

  // Reuse the existing crash-recoverable bakery protocol.
  // Import lazily because turn-lock.js imports getBrokerPaths from here.
  const { acquireTurnLock } = await import("./turn-lock.js");

  let guard;
  try {
    guard = await acquireTurnLock(dir, "broker-instance", {
      conversationId: "broker.lock",
      timeoutMs: 5000,
      pollIntervalMs: 10,
    });
  } catch (error) {
    if (error?.code === "CONCURRENT_TURN_BUSY") return null;
    throw error;
  }

  const instanceId = randomUUID();
  const temp = `${lockPath}.${process.pid}.${instanceId}.tmp`;
  const payload = JSON.stringify({ pid: process.pid, instanceId }) + "\n";

  try {
    // The guarded observation is authoritative. Another contender may
    // have published a live owner after our optimistic observation.
    const current = await readInstanceOwner(lockPath);
    if (!canReplaceInstanceOwner(current)) return null;

    // Every contender must hold the same guard before publication.
    // Therefore the absent/dead owner cannot be replaced by another
    // contender between this check and the atomic publication.
    await fs.writeFile(temp, payload, { flag: "wx", mode: 0o600 });
    await retryTransientFs(() => fs.rename(temp, lockPath));

    let released = false;

    return {
      instanceId,

      async release() {
        if (released) return;
        released = true;

        try {
          const stored = await readInstanceOwner(lockPath);
          if (stored?.instanceId !== instanceId ||
              stored?.pid !== process.pid) {
            return;
          }

          // A conforming contender cannot replace a live owner's record.
          // Until this unlink completes, our PID prevents reclamation.
          // Once it completes, this release never touches lockPath again.
          await retryTransientFs(() => fs.rm(lockPath, { force: true }));
        } catch (error) {
          // Permit an explicit retry after an actual filesystem failure.
          released = false;
          throw error;
        }
      },
    };
  } finally {
    try {
      await fs.rm(temp, { force: true }).catch(() => {});
    } finally {
      await guard.release();
    }
  }
}
