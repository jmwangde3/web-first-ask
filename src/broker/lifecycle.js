import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const defaultHome = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "web-first-ask");

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
    await fs.rename(temp, brokerJson);
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
    await fs.rm(file, { force: true });
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

export async function acquireInstanceLock(home) {
  const { home: dir } = getBrokerPaths(home);
  const lockPath = path.join(dir, "broker.lock");
  await fs.mkdir(dir, { recursive: true });
  const instanceId = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, instanceId }) + "\n";

  for (let attempt = 0; attempt < 2; attempt++) {
    const temp = `${lockPath}.${process.pid}.${instanceId}.tmp`;
    try {
      await fs.writeFile(temp, payload, { flag: "wx", mode: 0o600 });
      await fs.link(temp, lockPath);
      let released = false;
      return {
        instanceId,
        async release() {
          if (released) return;
          released = true;
          try {
            const stored = JSON.parse(await fs.readFile(lockPath, "utf8"));
            if (stored.instanceId === instanceId) await fs.rm(lockPath, { force: true });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 1) return null;
      let old;
      try { old = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch { old = null; }
      if (old && pidAlive(old.pid)) return null;
      // A second process may recover the stale lock first; never remove a live successor.
      let latest;
      try { latest = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch { latest = null; }
      if (latest && pidAlive(latest.pid)) return null;
      await fs.rm(lockPath, { force: true }).catch(() => {});
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  return null;
}
