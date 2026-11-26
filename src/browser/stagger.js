import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const providerQueues = new Map();
const MIN_MS = 3000;
const MAX_MS = 5000;

// F6：与 pacer.resolvePaceConfig 同形。接受 { minMs, maxMs }、
// { min, max } 或 { stagger: {...} }；非法边界回退到默认 3-5s。
export const DEFAULT_STAGGER_MS = Object.freeze({ min: MIN_MS, max: MAX_MS });

export function resolveStaggerConfig(input = {}) {
  const stagger = input && typeof input === "object"
    ? (input.stagger && typeof input.stagger === "object" ? input.stagger : input)
    : {};
  const rawMin = stagger.minMs !== undefined ? stagger.minMs : stagger.min;
  const rawMax = stagger.maxMs !== undefined ? stagger.maxMs : stagger.max;
  const safeMin = Number.isFinite(rawMin) ? Math.max(0, Math.floor(rawMin)) : MIN_MS;
  const safeMax = Number.isFinite(rawMax) ? Math.max(0, Math.floor(rawMax)) : MAX_MS;
  return safeMin <= safeMax
    ? { min: safeMin, max: safeMax }
    : { min: safeMax, max: safeMin };
}

export function computeStaggerDelay(minMs = MIN_MS, maxMs = MAX_MS, random = Math.random) {
  // 入参防御（Gemini 复核补充）：非有限值的边界回退到默认，避免 NaN 延迟。
  const safeMinInput = Number.isFinite(minMs) ? minMs : MIN_MS;
  const safeMaxInput = Number.isFinite(maxMs) ? maxMs : MAX_MS;
  const min = Math.max(0, Math.min(safeMinInput, safeMaxInput));
  const max = Math.max(min, Math.max(safeMinInput, safeMaxInput));
  const value = random();
  const r = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return Math.min(max, min + Math.floor(r * (max - min + 1)));
}

function cancelled() {
  return Object.assign(new Error("Operation cancelled before submit"), { code: "CANCELLED" });
}

function checkAbort(signal) {
  if (signal?.aborted) throw cancelled();
}

async function abortable(promise, signal) {
  if (!signal) return await promise;
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    throw cancelled();
  }
  let onAbort;
  const abort = new Promise((_, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function defaultSleep(ms, signal) {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw error;
  }
}

// Serialize only the submission attempt, never the generation itself.
// No future send slots are reserved. The next deadline is measured after the
// previous attempt settles (including unknown outcomes). Queue insertion is
// synchronous; no file lock or global mutex is held during the delay.
export async function withSendSlot(provider, submit, {
  isNewConversation = true,
  now = () => performance.now(),
  sleep = defaultSleep,
  random = Math.random,
  signal,
  minMs,
  maxMs,
  config,
} = {}) {
  checkAbort(signal);
  if (typeof submit !== "function") throw new TypeError("submit must be a function");
  if (!isNewConversation) return await submit();

  const key = String(provider).toLowerCase();
  let state = providerQueues.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), nextEligibleAt: -Infinity };
    providerQueues.set(key, state);
  }

  const previous = state.tail;
  let release;
  const own = new Promise((resolve) => { release = resolve; });
  // A cancelled middle ticket must not let its successor overtake an
  // earlier in-flight submission.
  state.tail = previous.then(() => own);

  try {
    await abortable(previous, signal);
    for (;;) {
      checkAbort(signal);
      const remaining = state.nextEligibleAt - now();
      if (remaining <= 0) break;
      await abortable(sleep(Math.ceil(remaining), signal), signal);
    }
    checkAbort(signal);
    const stagger = resolveStaggerConfig(config ?? { minMs, maxMs });
    const spacing = computeStaggerDelay(stagger.min, stagger.max, random);
    try {
      // Never race a running submit against abort: its outcome might be
      // unknown. A successor must wait until the attempt actually settles.
      return await submit();
    } finally {
      state.nextEligibleAt = now() + spacing;
    }
  } finally {
    release();
  }
}

// Test isolation only. Never reset with active submissions in production.
export function resetStaggerQueues() {
  providerQueues.clear();
}
