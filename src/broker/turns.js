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

export function createTurn({ id = randomUUID(), provider, prompt, conversationId = null,
  mode = "background", createdAt = new Date().toISOString() } = {}) {
  if (typeof id !== "string" || !id.trim() ||
      !["chatgpt", "gemini"].includes(provider) ||
      typeof prompt !== "string" || !prompt.trim() ||
      (conversationId !== null && (typeof conversationId !== "string" || !conversationId.trim())) ||
      typeof mode !== "string" || !mode.trim() ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw invalid("Invalid turn arguments");
  }
  return {
    id, provider, prompt, conversationId, mode, createdAt,
    state: "queued", startedAt: null, finishedAt: null,
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
    conversationId: _conversationId, ...fields } = patch;
  return { ...turn, ...fields, state: to };
}

export function isSendCommitted(turn) {
  return turn?.sendCommittedAt != null;
}

export function publicView(turn) {
  const { prompt, ...rest } = turn;
  return { ...rest, promptPreview: Array.from(prompt).slice(0, 120).join("") };
}
