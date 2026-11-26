import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "../paths.js";

export const CONVERSATION_SCHEMA = 1;

const PROVIDERS = new Set(["chatgpt", "gemini", "claude"]);
const CHATGPT_CONVERSATION_PATH = /^\/c\/[a-zA-Z0-9-]+\/?$/;
const GEMINI_CONVERSATION_PATH = /^\/app\/[a-zA-Z0-9_-]+\/?$/;
// F5 (coordinator wiring): Claude conversation URLs are /chat/<id>;
// UNVERIFIED against the live Claude DOM — see adapters/claude.js.
const CLAUDE_CONVERSATION_PATH = /^\/chat\/[a-zA-Z0-9-]+\/?$/;

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

  if (provider === "claude") {
    return parsed.hostname === "claude.ai" &&
      CLAUDE_CONVERSATION_PATH.test(parsed.pathname);
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
  // F7：仅本工具创建的会话才可清理；缺失即视为既有会话（永不删除）。
  if (item.createdByRun !== undefined && typeof item.createdByRun !== "boolean") return false;
  if (item.createdRunId !== undefined && item.createdRunId !== null && typeof item.createdRunId !== "string") return false;
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

  // F7：createdByRun / createdRunId 可选（旧记录缺失即视为既有会话）。
  if (record.createdByRun !== undefined && typeof record.createdByRun !== "boolean") return false;
  if (record.createdRunId !== undefined && record.createdRunId !== null && typeof record.createdRunId !== "string") return false;

  return true;
}

// F7 — enumerate the stored session identities for an explicit cleanup
// sweep. Session files are named by sha256(conversationId), so the id is
// read back from each file and the record is re-validated through
// loadSession; corrupt or foreign files are skipped, never trusted.
export async function listSessionIdentities(home, { providers } = {}) {
  const root = home || getHomeDir();
  const wanted = Array.isArray(providers) && providers.length
    ? [...new Set(providers.map((p) => String(p).toLowerCase()))]
    : [...PROVIDERS];
  const identities = [];
  for (const provider of wanted) {
    if (!PROVIDERS.has(provider)) continue;
    const dir = path.join(root, "conversations", provider);
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let record = null;
      try {
        record = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      } catch {
        continue;
      }
      const conversationId = record?.conversationId;
      if (typeof conversationId !== "string" || !conversationId.trim()) continue;
      const session = await loadSession(root, provider, conversationId);
      if (session) identities.push({ provider, conversationId });
    }
  }
  return identities;
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
    // F7：旧记录缺失创建来源时默认为既有会话，绝不进入清理集合。
    if (record.createdByRun === undefined) record.createdByRun = false;
    if (record.createdRunId === undefined) record.createdRunId = null;
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

  // F7：创建来源。只在打开新会话时由调用方传入（createdByRun: true，
  // createdRunId: 本次运行的 requestId/taskId）；复用既有会话时不传，
  // 沿用旧值。URL 变化时若未传入则 fail-closed：新 URL 视为既有会话
  // （绝不删除），旧 URL 的来源随 retired 条目保留。
  const urlChanged = Boolean(
    existing?.conversationUrl && conversationUrl &&
    existing.conversationUrl !== conversationUrl,
  );
  const createdByRun = patch.createdByRun ?? (urlChanged ? false : (existing?.createdByRun ?? false));
  if (typeof createdByRun !== "boolean") {
    throw new Error("INVALID_CONVERSATION_CREATED_BY_RUN");
  }
  const createdRunId = patch.createdRunId !== undefined
    ? patch.createdRunId
    : (urlChanged ? null : (existing?.createdRunId ?? null));
  if (createdRunId !== null && typeof createdRunId !== "string") {
    throw new Error("INVALID_CONVERSATION_CREATED_RUN_ID");
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
        createdByRun: existing.createdByRun ?? false,
        createdRunId: existing.createdRunId ?? null,
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
    createdByRun,
    createdRunId,
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
      createdByRun: existing.createdByRun ?? false,
      createdRunId: existing.createdRunId ?? null,
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

// F7 — 仅清理本工具创建的会话。
// 清理集合的唯一来源是 createdByRun === true 的记录（当前 URL + 未删的
// retired 条目）；既有会话（createdByRun 为 false 或缺失）永远不在其中。
// 传 runId 时进一步限定为该次运行打开的会话；不传则为该 key 下全部
// 本工具创建且尚未删除的会话。
export async function listCreatedConversations(home, provider, conversationId, { runId } = {}) {
  assertIdentity(provider, conversationId);
  const session = await loadSession(home, provider, conversationId);
  if (!session) return [];

  const matchesRun = (entry) => runId === undefined || entry?.createdRunId === runId;
  const targets = [];

  const retiredDeleted = new Set(
    (Array.isArray(session.retired) ? session.retired : [])
      .filter((r) => r?.deletedAt != null)
      .map((r) => r.conversationUrl),
  );
  if (
    session.createdByRun === true &&
    matchesRun(session) &&
    isValidConversationUrl(provider, session.conversationUrl) &&
    !retiredDeleted.has(session.conversationUrl)
  ) {
    targets.push({
      conversationUrl: session.conversationUrl,
      createdRunId: session.createdRunId ?? null,
      retired: false,
    });
  }

  for (const entry of Array.isArray(session.retired) ? session.retired : []) {
    if (
      entry?.createdByRun === true &&
      matchesRun(entry) &&
      entry.deletedAt == null &&
      isValidConversationUrl(provider, entry.conversationUrl) &&
      !targets.some((t) => t.conversationUrl === entry.conversationUrl)
    ) {
      targets.push({
        conversationUrl: entry.conversationUrl,
        createdRunId: entry.createdRunId ?? null,
        retired: true,
      });
    }
  }

  return targets;
}

// 删除 listCreatedConversations 返回的集合，且仅此集合。
// deleteConversation 由调用方注入，签名 ({ provider, conversationUrl }) =>
// { success: true } | { success: false, reason }，引擎侧用适配器的
// buildDeleteConversationJs + CDP Runtime.evaluate 实现（chatgpt/gemini
// 均已提供该函数）；未注入时不删除任何会话，只报告 wouldDelete 与缺失的 hook。
// dryRun 同样只报告。每次删除后经 markDeleted 记账，重复调用不再重复删。
export async function cleanupCreatedConversations(home, provider, conversationId, {
  runId,
  deleteConversation,
  dryRun = false,
  onResult,
} = {}) {
  assertIdentity(provider, conversationId);
  const targets = await listCreatedConversations(home, provider, conversationId, { runId });
  const result = {
    status: "done",
    dryRun: Boolean(dryRun),
    deleted: [],
    failed: [],
    skipped: [],
    wouldDelete: targets.map((t) => t.conversationUrl),
  };

  if (dryRun) return result;

  if (typeof deleteConversation !== "function") {
    return {
      ...result,
      status: "missing_delete_hook",
      reason: "no deleteConversation hook: wire adapter.buildDeleteConversationJs via CDP Runtime.evaluate",
    };
  }

  result.wouldDelete = [];
  for (const target of targets) {
    const url = target.conversationUrl;
    if (!isValidConversationUrl(provider, url)) {
      result.skipped.push({ conversationUrl: url, reason: "invalid_url" });
      continue;
    }
    let outcome;
    try {
      outcome = await deleteConversation({ provider, conversationUrl: url });
    } catch (err) {
      outcome = { success: false, reason: err?.message || String(err) };
    }
    const entry = { conversationUrl: url };
    if (outcome && outcome.success) {
      await markDeleted(home, provider, conversationId, url, "deleted").catch(() => {});
      result.deleted.push(url);
      entry.status = "deleted";
    } else {
      const reason = outcome?.reason || "delete_failed";
      await markDeleted(home, provider, conversationId, url, "failed").catch(() => {});
      result.failed.push({ conversationUrl: url, reason });
      entry.status = "failed";
      entry.reason = reason;
    }
    if (typeof onResult === "function") {
      try { await onResult(entry); } catch {}
    }
  }
  if (result.failed.length > 0) result.status = "partial";
  return result;
}
