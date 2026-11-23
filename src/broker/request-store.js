import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getHomeDir } from "../paths.js";

export const REQUEST_SCHEMA = 1;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COUNT = 500;

export function getRequestsDir(home) {
  return path.join(home || getHomeDir(), "turns", "requests");
}

export function hashRequestId(requestId) {
  return createHash("sha256").update(String(requestId)).digest("hex");
}

function isValidRequestRecord(record) {
  return Boolean(
    record &&
    typeof record === "object" &&
    record.schema === REQUEST_SCHEMA &&
    typeof record.requestId === "string" &&
    record.requestId.trim() &&
    typeof record.requestHash === "string" &&
    record.requestHash.trim() &&
    typeof record.turnId === "string" &&
    record.turnId.trim()
  );
}

export async function recordRequest(home, { requestId, requestHash, turnId, createdAt } = {}) {
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new Error("INVALID_REQUEST_ID");
  }
  if (typeof requestHash !== "string" || !requestHash.trim()) {
    throw new Error("INVALID_REQUEST_HASH");
  }
  if (typeof turnId !== "string" || !turnId.trim()) {
    throw new Error("INVALID_TURN_ID");
  }

  const dir = getRequestsDir(home);
  await mkdir(dir, { recursive: true });
  const key = hashRequestId(requestId);
  const target = path.join(dir, `${key}.json`);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const record = {
    schema: REQUEST_SCHEMA,
    requestId,
    requestHash,
    turnId,
    createdAt: createdAt ?? new Date().toISOString(),
  };

  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await rename(temporary, target);
        return record;
      } catch (err) {
        if (attempt || !["EPERM", "EBUSY"].includes(err?.code)) throw err;
        await sleep(50);
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readRequest(home, requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) return null;
  const target = path.join(getRequestsDir(home), `${hashRequestId(requestId)}.json`);
  try {
    const content = await readFile(target, "utf8");
    const record = JSON.parse(content);
    if (!isValidRequestRecord(record) || record.requestId !== requestId) return null;
    return record;
  } catch {
    return null;
  }
}

export async function readRequests(home) {
  const dir = getRequestsDir(home);
  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const records = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      const record = JSON.parse(content);
      if (isValidRequestRecord(record)) {
        records.push(record);
      }
    } catch {
      // Skip corrupted or truncated request index files.
    }
  }
  return records;
}

export async function pruneRequests(home, {
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxCount = DEFAULT_MAX_COUNT,
  now = Date.now(),
} = {}) {
  try {
    const records = await readRequests(home);
    if (!records.length) return 0;
    const dir = getRequestsDir(home);
    const sortedDesc = [...records].sort((a, b) => {
      const tA = Date.parse(a.createdAt || "") || 0;
      const tB = Date.parse(b.createdAt || "") || 0;
      return tB - tA;
    });
    let removed = 0;
    for (let i = 0; i < sortedDesc.length; i++) {
      const item = sortedDesc[i];
      const ts = Date.parse(item.createdAt || "");
      const expired = Number.isFinite(ts) && (now - ts > maxAgeMs);
      const overLimit = i >= maxCount;
      if (expired || overLimit) {
        await rm(path.join(dir, `${hashRequestId(item.requestId)}.json`), { force: true }).catch(() => {});
        removed++;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
