import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getHomeDir } from "../paths.js";
import { TURN_STATES } from "./turns.js";

export const TURN_SCHEMA = 1;
export const TURN_KIND = "wfa-turn";
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COUNT = 500;

export function getTurnRecordsDir(home) {
  return path.join(home || getHomeDir(), "turns", "records");
}

function assertValidTurnId(turnId) {
  if (!turnId || typeof turnId !== "string" || !turnId.trim() ||
      turnId.includes("/") || turnId.includes("\\") || turnId.includes("..")) {
    throw new Error("INVALID_TURN_ID");
  }
}

function buildPromptPreview(turn) {
  if (typeof turn?.promptPreview === "string") return turn.promptPreview;
  if (typeof turn?.prompt === "string") {
    return Array.from(turn.prompt).slice(0, 120).join("");
  }
  return "";
}

function isValidTurnRecord(record) {
  return Boolean(
    record &&
    typeof record === "object" &&
    record.schema === TURN_SCHEMA &&
    record.kind === TURN_KIND &&
    typeof record.turnId === "string" &&
    record.turnId.trim() &&
    ["chatgpt", "gemini", "claude"].includes(record.provider) &&
    TURN_STATES.includes(record.state) &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt))
  );
}

export async function recordTurn(home, turn) {
  const turnId = turn?.id ?? turn?.turnId;
  assertValidTurnId(turnId);

  if (!turn || !["chatgpt", "gemini", "claude"].includes(turn.provider) ||
      !TURN_STATES.includes(turn.state)) {
    throw new Error("INVALID_TURN_RECORD");
  }

  const dir = getTurnRecordsDir(home);
  await mkdir(dir, { recursive: true });

  const target = path.join(dir, `${turnId}.json`);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;

  const record = {
    schema: TURN_SCHEMA,
    kind: TURN_KIND,
    turnId,
    requestId: turn.requestId ?? null,
    provider: turn.provider,
    conversationId: turn.conversationId ?? null,
    mode: turn.mode ?? "background",
    state: turn.state,
    conversationUrl: turn.conversationUrl ?? null,
    targetId: turn.targetId ?? null,
    reason: turn.reason ?? null,
    evidence: turn.evidence ?? null,
    // F1/F4: persisted so a broker restart restores a queued turn with its
    // mode/download target intact instead of silently dropping them.
    geminiMode: turn.geminiMode ?? null,
    downloadDir: turn.downloadDir ?? null,
    sendCommittedAt: turn.sendCommittedAt ?? null,
    createdAt: turn.createdAt ?? new Date().toISOString(),
    startedAt: turn.startedAt ?? null,
    finishedAt: turn.finishedAt ?? null,
    cooldownWaitMs: turn.cooldownWaitMs ?? null,
    cooldownWaitAt: turn.cooldownWaitAt ?? null,
    promptPreview: buildPromptPreview(turn),
    downloads: turn.downloads ?? null,
    updatedAt: new Date().toISOString(),
  };

  if (!isValidTurnRecord(record)) {
    throw new Error("INVALID_TURN_RECORD");
  }

  await writeFile(
    temporary,
    `${JSON.stringify(record, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await rename(temporary, target);
        return record;
      } catch (error) {
        if (attempt || !["EPERM", "EBUSY"].includes(error?.code)) {
          throw error;
        }
        await sleep(50);
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readTurn(home, turnId) {
  try {
    assertValidTurnId(turnId);
  } catch {
    return null;
  }

  const target = path.join(getTurnRecordsDir(home), `${turnId}.json`);

  try {
    const content = await readFile(target, "utf8");
    const record = JSON.parse(content);
    return isValidTurnRecord(record) ? record : null;
  } catch {
    return null;
  }
}

export async function readTurns(home) {
  const dir = getTurnRecordsDir(home);
  let files;

  try {
    files = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const records = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const content = await readFile(path.join(dir, file), "utf8");
      const record = JSON.parse(content);

      if (isValidTurnRecord(record)) {
        records.push(record);
      }
    } catch {
      // Ignore corrupted or truncated turn records.
    }
  }

  records.sort((a, b) => {
    const timeA = Date.parse(a.createdAt) || 0;
    const timeB = Date.parse(b.createdAt) || 0;
    return timeA - timeB;
  });

  return records;
}

export async function pruneTurns(home, {
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxCount = DEFAULT_MAX_COUNT,
  now = Date.now(),
} = {}) {
  try {
    const records = await readTurns(home);
    if (!records.length) return 0;

    const dir = getTurnRecordsDir(home);
    const sortedDesc = [...records].sort((a, b) => {
      const timeA = Date.parse(a.updatedAt || a.createdAt) || 0;
      const timeB = Date.parse(b.updatedAt || b.createdAt) || 0;
      return timeB - timeA;
    });

    let removed = 0;

    for (let i = 0; i < sortedDesc.length; i += 1) {
      const record = sortedDesc[i];
      const timestamp = Date.parse(record.updatedAt || record.createdAt);
      const expired = Number.isFinite(timestamp) && now - timestamp > maxAgeMs;
      const overLimit = i >= maxCount;

      if (expired || overLimit) {
        await rm(path.join(dir, `${record.turnId}.json`), { force: true })
          .catch(() => {});
        removed += 1;
      }
    }

    return removed;
  } catch {
    return 0;
  }
}
