// 人类操作节奏器（三方裁决 2026-11-24）：在关键 CDP 动作之间注入随机间隔，
// 避免 0 间隔批量操作触发 provider 风控。日常 1-2s，批量 4-6s。
import { setTimeout as defaultSleep } from "node:timers/promises";

export const PACE_CONFIG = {
  casual: { min: 1000, max: 2000 },
  batch: { min: 4000, max: 6000 },
};

// F6 配置形态（与 loadConfig 合并后的 config.pace 对齐；config.js /
// constants.js 的 DEFAULT_CONFIG 接入由协调方补一行，形态见下）：
//   pace: { enabled, casualMinMs, casualMaxMs, batchMinMs, batchMaxMs }
// 也接受 { casual: { min, max }, batch: { min, max } } 或 { pace: {...} }。
// 非法/缺失边界回退到默认；min > max 时对调；全 0 表示关闭延迟（测试用）。
function normalizeRange(min, max, fallback) {
  const safeMin = Number.isFinite(min) ? Math.max(0, Math.floor(min)) : fallback.min;
  const safeMax = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : fallback.max;
  return safeMin <= safeMax
    ? { min: safeMin, max: safeMax }
    : { min: safeMax, max: safeMin };
}

export function resolvePaceConfig(input = {}) {
  const pace = input && typeof input === "object"
    ? (input.pace && typeof input.pace === "object" ? input.pace : input)
    : {};
  const casual = pace.casual && typeof pace.casual === "object"
    ? normalizeRange(pace.casual.min, pace.casual.max, PACE_CONFIG.casual)
    : normalizeRange(pace.casualMinMs, pace.casualMaxMs, PACE_CONFIG.casual);
  const batch = pace.batch && typeof pace.batch === "object"
    ? normalizeRange(pace.batch.min, pace.batch.max, PACE_CONFIG.batch)
    : normalizeRange(pace.batchMinMs, pace.batchMaxMs, PACE_CONFIG.batch);
  return {
    enabled: pace.enabled !== false,
    casual,
    batch,
  };
}

export function isPacingEnabled(options = {}) {
  if (options.enabled === false) return false;
  if (options.enabled === true) return true;
  const config = resolvePaceConfig(options.config ?? options.pace ?? {});
  if (config.enabled === false) return false;
  if (process.env.WFA_NO_PACE === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

export function computePaceDelay(kind, random = Math.random, ranges = null) {
  const resolved = ranges ? resolvePaceConfig({ pace: ranges }) : null;
  const range = resolved
    ? (resolved[kind] || resolved.casual)
    : (PACE_CONFIG[kind] || PACE_CONFIG.casual);
  return Math.floor(range.min + random() * (range.max - range.min + 1));
}

export async function pace(kind = "casual", {
  enabled,
  config,
  ranges,
  sleep = defaultSleep,
  signal,
  random = Math.random,
} = {}) {
  const resolvedConfig = resolvePaceConfig(config ?? ranges ?? {});
  const effectiveEnabled = enabled !== undefined
    ? enabled
    : isPacingEnabled({ config: resolvedConfig });
  if (!effectiveEnabled) return 0;
  if (signal?.aborted) {
    const err = new Error("Operation cancelled");
    err.code = "CANCELLED";
    throw err;
  }
  const delay = computePaceDelay(kind, random, resolvedConfig);
  if (delay > 0) await sleep(delay);
  return delay;
}
