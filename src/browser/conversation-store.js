import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "../paths.js";

export const CONVERSATION_SCHEMA = 1;

const PROVIDERS = new Set(["chatgpt", "gemini"]);
const CHATGPT_CONVERSATION_PATH = /^\/c\/[a-zA-Z0-9-]+\/?$/;
const GEMINI_CONVERSATION_PATH = /^\/app\/[a-zA-Z0-9_-]+\/?$/;

function assertIdentity(provider, conversationId) {
  if (!PROVIDERS.has(provider)) {
    throw new Error("INVALID_CONVERSATION_PROVIDER");
  }
  if (typeof conversationId !== "string" || !conversationId.trim()) {
    throw new Error("INVALID_CONVERSATION_ID");
  }
}

export function isValidConversationUrl(provider, value) {
  if (typeof value !== "string" || !value.trim()) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return false;
  }

  if (provider === "chatgpt") {
    return parsed.hostname === "chatgpt.com" &&
      CHATGPT_CONVERSATION_PATH.test(parsed.pathname);
  }

  if (provider === "gemini") {
    return parsed.hostname === "gemini.google.com" &&
      GEMINI_CONVERSATION_PATH.test(parsed.pathname);
  }

  return false;
}

export function getConversationSessionPath(home, provider, conversationId) {
  assertIdentity(provider, conversationId);
  const root = home || getHomeDir();
  const key = createHash("sha256").update(conversationId).digest("hex");
  return path.join(root, "conversations", provider, `${key}.json`);
}

function isValidRetiredEntry(item, provider) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (!isValidConversationUrl(provider, item.conversationUrl)) return false;
  if (item.invalidatedReason !== null && typeof item.invalidatedReason !== "string") return false;
  if (item.deletedAt !== null && (typeof item.deletedAt !== "string" || !Number.isFinite(Date.parse(item.deletedAt)))) return false;
  if (item.cleanupStatus !== null && typeof item.cleanupStatus !== "string") return false;
  if (item.cleanupAttemptedAt !== null && (typeof item.cleanupAttemptedAt !== "string" || !Number.isFinite(Date.parse(item.cleanupAttemptedAt)))) return false;
  return true;
}

function isValidStoredSession(record, provider, conversationId) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schema !== CONVERSATION_SCHEMA ||
    record.provider !== provider ||
    record.conversationId !== conversationId ||
    !Number.isSafeInteger(record.turnCount) ||
    record.turnCount < 0 ||
    typeof record.invalidated !== "boolean" ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    return false;
  }

  if (
    record.invalidatedReason !== null &&
    typeof record.invalidatedReason !== "string"
  ) {
    return false;
  }

  if (record.conversationUrl === null) {
    if (!record.invalidated) return false;
  } else if (!isValidConversationUrl(provider, record.conversationUrl)) {
    return false;
  }

  if (record.retired !== undefined) {
    if (!Array.isArray(record.retired)) return false;
    for (const item of record.retired) {
      if (!isValidRetiredEntry(item, provider)) return false;
    }
  }

  return true;
}

export async function loadSession(home, provider, conversationId) {
  assertIdentity(provider, conversationId);
  const target = getConversationSessionPath(home, provider, conversationId);

  try {
    const content = await readFile(target, "utf8");
    const record = JSON.parse(content);
    if (!isValidStoredSession(record, provider, conversationId)) {
      return null;
    }
    if (!Array.isArray(record.retired)) {
      record.retired = [];
    }
    return record;
  } catch {
    return null;
  }
}

export async function saveSession(home, provider, conversationId, patch = {}) {
  assertIdentity(provider, conversationId);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("INVALID_CONVERSATION_PATCH");
  }

  const existing = await loadSession(home, provider, conversationId);
  const invalidated = patch.invalidated ?? existing?.invalidated ?? false;
  if (typeof invalidated !== "boolean") {
    throw new Error("INVALID_CONVERSATION_INVALIDATED");
  }

  const conversationUrl = patch.conversationUrl !== undefined
    ? patch.conversationUrl
    : (existing?.conversationUrl ?? null);

  if (
    conversationUrl !== null &&
    !isValidConversationUrl(provider, conversationUrl)
  ) {
    throw new Error("INVALID_CONVERSATION_URL");
  }
  if (!invalidated && !isValidConversationUrl(provider, conversationUrl)) {
    throw new Error("INVALID_CONVERSATION_URL");
  }

  const turnCount = patch.turnCount ?? existing?.turnCount ?? 0;
  if (!Number.isSafeInteger(turnCount) || turnCount < 0) {
    throw new Error("INVALID_CONVERSATION_TURN_COUNT");
  }

  const invalidatedReason = invalidated
    ? (patch.invalidatedReason !== undefined
        ? patch.invalidatedReason
        : (existing?.invalidatedReason ?? null))
    : null;
  if (invalidatedReason !== null && typeof invalidatedReason !== "string") {
    throw new Error("INVALID_CONVERSATION_INVALIDATED_REASON");
  }

  const now = new Date().toISOString();
  const createdAt = patch.createdAt ?? existing?.createdAt ?? now;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("INVALID_CONVERSATION_CREATED_AT");
  }

  let retired = Array.isArray(patch.retired)
    ? [...patch.retired]
    : (Array.isArray(existing?.retired) ? [...existing.retired] : []);

  if (
    existing?.conversationUrl &&
    conversationUrl &&
    existing.conversationUrl !== conversationUrl &&
    isValidConversationUrl(provider, existing.conversationUrl)
  ) {
    const alreadyRetired = retired.some((r) => r.conversationUrl === existing.conversationUrl);
    if (!alreadyRetired) {
      retired.push({
        conversationUrl: existing.conversationUrl,
        invalidatedReason: existing.invalidatedReason || "retired_on_new_session",
        deletedAt: null,
        cleanupStatus: null,
        cleanupAttemptedAt: null,
      });
    }
  }

  const record = {
    schema: CONVERSATION_SCHEMA,
    provider,
    conversationId,
    conversationUrl,
    turnCount,
    invalidated,
    invalidatedReason,
    retired,
    createdAt,
    updatedAt: now,
  };

  const target = getConversationSessionPath(home, provider, conversationId);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }

  return record;
}

export async function markDeleted(home, provider, conversationId, targetUrl, status = "deleted") {
  assertIdentity(provider, conversationId);
  if (!isValidConversationUrl(provider, targetUrl)) {
    throw new Error("INVALID_CONVERSATION_URL");
  }

  const existing = await loadSession(home, provider, conversationId);
  if (!existing) return null;

  const now = new Date().toISOString();
  let updated = false;
  const retired = Array.isArray(existing.retired) ? [...existing.retired] : [];

  for (let i = 0; i < retired.length; i++) {
    if (retired[i].conversationUrl === targetUrl) {
      retired[i] = {
        ...retired[i],
        deletedAt: status === "deleted" ? (retired[i].deletedAt || now) : retired[i].deletedAt,
        cleanupStatus: status,
        cleanupAttemptedAt: now,
      };
      updated = true;
    }
  }

  if (!updated && existing.conversationUrl === targetUrl) {
    retired.push({
      conversationUrl: targetUrl,
      invalidatedReason: existing.invalidatedReason || "invalidated",
      deletedAt: status === "deleted" ? now : null,
      cleanupStatus: status,
      cleanupAttemptedAt: now,
    });
    updated = true;
  }

  if (!updated) return existing;

  return saveSession(home, provider, conversationId, {
    conversationUrl: existing.conversationUrl,
    turnCount: existing.turnCount,
    invalidated: existing.invalidated,
    invalidatedReason: existing.invalidatedReason,
    createdAt: existing.createdAt,
    retired,
  });
}

export async function markInvalid(home, provider, conversationId, reason) {
  assertIdentity(provider, conversationId);
  const existing = await loadSession(home, provider, conversationId);
  const invalidatedReason = typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "conversation_invalidated";

  return saveSession(home, provider, conversationId, {
    conversationUrl: existing?.conversationUrl ?? null,
    turnCount: existing?.turnCount ?? 0,
    invalidated: true,
    invalidatedReason,
    retired: existing?.retired ?? [],
    ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
  });
}
