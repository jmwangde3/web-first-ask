import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getHomeDir } from "../paths.js";

export const RESULT_SCHEMA = 1;
export const RESULT_KIND = "wfa-turn-result";
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COUNT = 500;

export function getResultsDir(home) {
  return path.join(home || getHomeDir(), "turns", "results");
}

function assertValidTurnId(turnId) {
  if (!turnId || typeof turnId !== "string" || !turnId.trim() ||
      turnId.includes("/") || turnId.includes("\\") || turnId.includes("..")) {
    throw new Error("INVALID_TURN_ID");
  }
}

function isValidResultRecord(record) {
  return Boolean(
    record &&
    typeof record === "object" &&
    record.schema === RESULT_SCHEMA &&
    record.kind === RESULT_KIND &&
    typeof record.turnId === "string" &&
    record.turnId.trim() &&
    typeof record.state === "string" &&
    record.state.trim()
  );
}

function buildPromptPreview(turn) {
  if (typeof turn?.promptPreview === "string") return turn.promptPreview;
  if (typeof turn?.prompt === "string") return Array.from(turn.prompt).slice(0, 120).join("");
  return "";
}

export async function recordResult(home, turn) {
  const turnId = turn?.id ?? turn?.turnId;
  assertValidTurnId(turnId);
  if (typeof turn?.state !== "string" || !turn.state.trim()) {
    throw new Error("INVALID_TURN_STATE");
  }

  const dir = getResultsDir(home);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${turnId}.json`);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const record = {
    schema: RESULT_SCHEMA,
    kind: RESULT_KIND,
    turnId,
    requestId: turn.requestId ?? null,
    provider: turn.provider ?? null,
    conversationId: turn.conversationId ?? null,
    conversationUrl: turn.conversationUrl ?? null,
    createdByWfa: typeof turn.createdByWfa === "boolean" ? turn.createdByWfa : null,
    targetId: turn.targetId ?? null,
    state: turn.state,
    text: turn.text ?? null,
    reason: turn.reason ?? null,
    evidence: turn.evidence ?? null,
    sendCommittedAt: turn.sendCommittedAt ?? null,
    createdAt: turn.createdAt ?? null,
    startedAt: turn.startedAt ?? null,
    finishedAt: turn.finishedAt ?? null,
    promptPreview: buildPromptPreview(turn),
    downloads: turn.downloads ?? null,
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

export async function readResult(home, turnId) {
  try {
    assertValidTurnId(turnId);
  } catch {
    return null;
  }
  const target = path.join(getResultsDir(home), `${turnId}.json`);
  try {
    const content = await readFile(target, "utf8");
    const record = JSON.parse(content);
    return isValidResultRecord(record) ? record : null;
  } catch {
    return null;
  }
}

export async function readResults(home) {
  const dir = getResultsDir(home);
  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const results = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      const record = JSON.parse(content);
      if (isValidResultRecord(record)) {
        results.push(record);
      }
    } catch {
      // Skip corrupted or truncated result files.
    }
  }
  results.sort((a, b) => {
    const tA = Date.parse(a.finishedAt || a.createdAt || "") || 0;
    const tB = Date.parse(b.finishedAt || b.createdAt || "") || 0;
    return tA - tB;
  });
  return results;
}

export async function pruneResults(home, {
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxCount = DEFAULT_MAX_COUNT,
  now = Date.now(),
} = {}) {
  try {
    const results = await readResults(home);
    if (!results.length) return 0;
    const dir = getResultsDir(home);
    // Sort newest first so we retain up to maxCount newest entries.
    const sortedDesc = [...results].sort((a, b) => {
      const tA = Date.parse(a.finishedAt || a.createdAt || "") || 0;
      const tB = Date.parse(b.finishedAt || b.createdAt || "") || 0;
      return tB - tA;
    });
    let removed = 0;
    for (let i = 0; i < sortedDesc.length; i++) {
      const item = sortedDesc[i];
      const ts = Date.parse(item.finishedAt || item.createdAt || "");
      const expired = Number.isFinite(ts) && (now - ts > maxAgeMs);
      const overLimit = i >= maxCount;
      if (expired || overLimit) {
        await rm(path.join(dir, `${item.turnId}.json`), { force: true }).catch(() => {});
        removed++;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
