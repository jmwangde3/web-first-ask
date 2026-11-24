function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

// 需求6裁决：CDP session 层每 turn 独立（target/session/WebSocket），配合会话级互斥锁，
// 默认允许每 provider 4 路、全局 8 路并发；与 server.js 显式配置统一，消除 1/1 vs 4/8 分裂。
export const DEFAULT_MAX_PER_PROVIDER = 4;
export const DEFAULT_MAX_TOTAL = 8;

export function createScheduler({ maxPerProvider = DEFAULT_MAX_PER_PROVIDER, maxTotal = DEFAULT_MAX_TOTAL, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxPerProvider) || maxPerProvider < 1 ||
      !Number.isInteger(maxTotal) || maxTotal < 1 || typeof now !== "function") {
    throw invalid("Invalid scheduler limits");
  }
  return { maxPerProvider, maxTotal, now, running: new Map(), queued: new Map() };
}

export function schedule(scheduler, turn) {
  if (!turn || typeof turn.id !== "string" || !turn.id ||
      typeof turn.provider !== "string" || !turn.provider) {
    throw invalid("Invalid turn");
  }
  if (scheduler.running.has(turn.id)) {
    return { accepted: false, reason: "conversation_busy" };
  }
  const active = [...scheduler.running.values()];
  const conversationKey = turn.conversationId == null
    ? `anonymous:${turn.id}` : `named:${turn.provider}:${turn.conversationId}`;
  let reason = null;
  if (active.some(item => item.conversationKey === conversationKey)) {
    reason = "conversation_busy";
  } else if (active.filter(item => item.provider === turn.provider).length >= scheduler.maxPerProvider) {
    reason = "provider_busy";
  } else if (active.length >= scheduler.maxTotal) {
    reason = "global_busy";
  }
  if (reason) {
    if (!scheduler.queued.has(turn.id)) {
      scheduler.queued.set(turn.id, {
        id: turn.id, provider: turn.provider, conversationId: turn.conversationId ?? null,
        queuedAt: scheduler.now(),
      });
    }
    return { accepted: false, reason };
  }
  scheduler.queued.delete(turn.id);
  scheduler.running.set(turn.id, {
    id: turn.id, provider: turn.provider,
    conversationKey,
  });
  return { accepted: true };
}

export function release(scheduler, turn) {
  scheduler.running.delete(turn.id);
  scheduler.queued.delete(turn.id);
}

export function snapshot(scheduler) {
  const runningByProvider = {};
  for (const { provider } of scheduler.running.values()) {
    runningByProvider[provider] = (runningByProvider[provider] ?? 0) + 1;
  }
  return {
    runningByProvider,
    runningTotal: scheduler.running.size,
    queued: [...scheduler.queued.values()].map(item => ({ ...item })),
  };
}
