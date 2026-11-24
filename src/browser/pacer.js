// 人类操作节奏器（三方裁决 2026-11-24）：在关键 CDP 动作之间注入随机间隔，
// 避免 0 间隔批量操作触发 provider 风控。日常 1-2s，批量 4-6s。
import { setTimeout as defaultSleep } from "node:timers/promises";

export const PACE_CONFIG = {
  casual: { min: 1000, max: 2000 },
  batch: { min: 4000, max: 6000 },
};

export function isPacingEnabled(options = {}) {
  if (options.enabled === false) return false;
  if (options.enabled === true) return true;
  if (process.env.WFA_NO_PACE === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

export function computePaceDelay(kind, random = Math.random) {
  const range = PACE_CONFIG[kind] || PACE_CONFIG.casual;
  return Math.floor(range.min + random() * (range.max - range.min + 1));
}

export async function pace(kind = "casual", {
  enabled = isPacingEnabled(),
  sleep = defaultSleep,
  signal,
  random = Math.random,
} = {}) {
  if (!enabled) return 0;
  if (signal?.aborted) {
    const err = new Error("Operation cancelled");
    err.code = "CANCELLED";
    throw err;
  }
  const delay = computePaceDelay(kind, random);
  if (delay > 0) await sleep(delay);
  return delay;
}
