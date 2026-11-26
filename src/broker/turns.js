import { randomUUID } from "node:crypto";

export const TURN_STATES = Object.freeze([
  "queued", "running", "completed", "needs_human", "takeover", "stalled", "failed",
]);
export const TERMINAL_STATES = Object.freeze(["completed", "failed", "stalled"]);

const EDGES = Object.freeze({
  queued: ["running", "failed"],
  running: ["completed", "needs_human", "takeover", "stalled", "failed"],
  needs_human: ["running", "failed"],
  takeover: ["running", "failed"],
  completed: [],
  failed: [],
  stalled: [],
});

function invalid(message, code = "INVALID_ARGUMENT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createTurn({
  id = randomUUID(),
  provider,
  prompt,
  conversationId = null,
  mode = "background",
  requestId = null,
  settleMs = null,
  stallTimeoutMs = null,
  hardTimeoutMs = null,
  minIntervalMs = null,
  chromePath = null,
  // F1/F5 (coordinator wiring): Gemini page mode (chat|task) and the
  // provider-download directory. The CLI used to forward geminiMode, but
  // createTurn dropped unknown fields, so F1 never reached runCdpTurn
  // through the broker; claude was rejected outright.
  geminiMode = null,
  downloadDir = null,
  createdAt = new Date().toISOString(),
} = {}) {
  if (typeof id !== "string" || !id.trim() ||
      !["chatgpt", "gemini", "claude"].includes(provider) ||
      typeof prompt !== "string" || !prompt.trim() ||
      (conversationId !== null && (typeof conversationId !== "string" || !conversationId.trim())) ||
      typeof mode !== "string" || !mode.trim() ||
      (requestId !== null && (typeof requestId !== "string" || !requestId.trim())) ||
      (settleMs !== null && (!Number.isFinite(settleMs) || settleMs < 0)) ||
      (stallTimeoutMs !== null && (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0)) ||
      (hardTimeoutMs !== null && (!Number.isFinite(hardTimeoutMs) || hardTimeoutMs <= 0)) ||
      (minIntervalMs !== null && (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0)) ||
      (chromePath !== null && (typeof chromePath !== "string" || !chromePath.trim())) ||
      (geminiMode !== null && geminiMode !== "chat" && geminiMode !== "task") ||
      (downloadDir !== null && (typeof downloadDir !== "string" || !downloadDir.trim())) ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw invalid("Invalid turn arguments");
  }
  return {
    id, provider, prompt, conversationId, mode, requestId,
    settleMs, stallTimeoutMs, hardTimeoutMs, minIntervalMs, chromePath,
    geminiMode, downloadDir,
    createdAt,
    state: "queued", startedAt: null, finishedAt: null,
    cooldownWaitMs: null, cooldownWaitAt: null,
    sendCommittedAt: null, text: null, reason: null, evidence: null,
  };
}

export function canTransition(from, to) {
  return (EDGES[from] ?? []).includes(to);
}

export function transition(turn, to, patch = {}) {
  if (!turn || !canTransition(turn.state, to)) {
    throw invalid(`Invalid transition: ${turn?.state} -> ${to}`, "INVALID_TRANSITION");
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw invalid("Invalid transition patch");
  }
  const { id: _id, state: _state, provider: _provider, prompt: _prompt,
    conversationId: _conversationId, requestId: _requestId, ...fields } = patch;
  return { ...turn, ...fields, state: to };
}

export function isSendCommitted(turn) {
  return turn?.sendCommittedAt != null;
}

export function publicView(turn) {
  const { prompt, ...rest } = turn;
  const promptPreview = typeof prompt === "string"
    ? Array.from(prompt).slice(0, 120).join("")
    : (typeof turn.promptPreview === "string" ? turn.promptPreview : "");
  return { ...rest, promptPreview };
}
