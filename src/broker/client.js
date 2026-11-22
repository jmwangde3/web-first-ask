import { clearBrokerRecord, isInstanceAlive, readBrokerRecord } from "./lifecycle.js";

function coded(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function discoverBroker(home) {
  const record = await readBrokerRecord(home);
  return record && await isInstanceAlive(record) ? record : null;
}

export async function ensureBroker({ home, spawnBroker, timeoutMs = 15000 } = {}) {
  if (typeof spawnBroker !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw coded("INVALID_ARGUMENT");
  }
  const existing = await discoverBroker(home);
  if (existing) return existing;
  const stale = await readBrokerRecord(home);
  if (stale) {
    let dead = false;
    try { process.kill(stale.pid, 0); } catch (error) { dead = error?.code === "ESRCH"; }
    if (dead) await clearBrokerRecord(home, stale.instanceId);
  }
  const deadline = Date.now() + timeoutMs;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => spawnBroker()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(coded("BROKER_TIMEOUT")), timeoutMs);
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
