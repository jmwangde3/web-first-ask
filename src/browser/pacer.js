// 人类操作节奏器（F6）：在关键 CDP 动作之间注入可配置随机间隔，
// 默认日常 1–2s、批次 4–6s，支持环境变量与显式配置覆盖。
import { setTimeout as defaultSleep } from "node:timers/promises";

export const PACE_CONFIG = {
  casual: { min: 1000, max: 2000 },
  batch: { min: 4000, max: 6000 },
  batch_pause: { min: 60000, max: 180000 },
};

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function resolvePaceRange(kind = "casual", overrides = {}) {
  const base = PACE_CONFIG[kind] || PACE_CONFIG.casual;
  const envPrefix = kind === "batch_pause" ? "WFA_PACE_BATCH_PAUSE" : (kind === "batch" ? "WFA_PACE_BATCH" : "WFA_PACE_CASUAL");
  const min = parsePositiveInt(overrides?.min ?? process.env[`${envPrefix}_MIN_MS`], base.min);
  const max = Math.max(min, parsePositiveInt(overrides?.max ?? process.env[`${envPrefix}_MAX_MS`], base.max));
  return { min, max };
}

export function isPacingEnabled(options = {}) {
  if (options.enabled === false) return false;
  if (options.enabled === true) return true;
  if (process.env.WFA_NO_PACE === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

export function computePaceDelay(kind, random = Math.random, overrides = {}) {
  const range = resolvePaceRange(kind, overrides);
  return Math.floor(range.min + random() * (range.max - range.min + 1));
}

export async function pace(kind = "casual", {
  enabled = isPacingEnabled(),
  sleep = defaultSleep,
  signal,
  random = Math.random,
  range,
} = {}) {
  if (!enabled) return 0;
  if (signal?.aborted) {
    const err = new Error("Operation cancelled");
    err.code = "CANCELLED";
    throw err;
  }
  const delay = computePaceDelay(kind, random, range);
  if (delay > 0) await sleep(delay);
  return delay;
}

export function createPacer({ casual, batch, enabled, sleep = defaultSleep, random = Math.random } = {}) {
  const ranges = { casual, batch };
  return (kind = "casual", opts = {}) => pace(kind, {
    enabled: opts.enabled ?? enabled ?? isPacingEnabled(),
    sleep: opts.sleep ?? sleep,
    signal: opts.signal,
    random: opts.random ?? random,
    range: opts.range ?? ranges[kind],
  });
}
