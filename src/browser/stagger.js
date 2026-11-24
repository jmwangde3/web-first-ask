// src/browser/stagger.js
// 同 provider 发送错峰门禁（硬限制）：
// 在实际提交 (driver.submitTurn) 之前强制插入 3000-5000ms 随机间隔，
// 抹除多 Tab 自动化瞬时同击指纹特征。
// 调度为 Provider 级内存队列，登记完立即出队/释放锁再 sleep，严禁持锁挂起。

const providerQueues = new Map();

/**
 * 产生 [minMs, maxMs] 之间的随机毫秒数，含毫秒级 jitter。
 */
export function computeStaggerDelay(minMs = 3000, maxMs = 5000, random = Math.random) {
  const min = Math.max(0, Math.min(minMs, maxMs));
  const max = Math.max(min, Math.max(minMs, maxMs));
  const r = typeof random === "function" ? random() : Math.random();
  const clampedR = Math.max(0, Math.min(1, Number.isFinite(r) ? r : 0));
  return Math.floor(min + clampedR * (max - min));
}

/**
 * 核心门禁：等待当前 provider 的发送槽位。
 * 仅用于新会话（无 conversationId 或新 conversationId）。
 *
 * @param {string} provider
 * @param {object} options
 * @param {boolean} [options.isNewConversation=true] 是否属于新会话
 * @param {number} [options.minMs=3000]
 * @param {number} [options.maxMs=5000]
 * @param {Function} [options.now=Date.now]
 * @param {Function} [options.sleep]
 * @param {Function} [options.random=Math.random]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ waitedMs: number, scheduledAt: number }>}
 */
export async function waitForSendSlot(provider, {
  isNewConversation = true,
  minMs = 3000,
  maxMs = 5000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  signal,
} = {}) {
  // 仅对新会话实行发车错峰；续聊无需限制
  if (!isNewConversation) {
    return { waitedMs: 0, scheduledAt: now() };
  }

  const key = String(provider || "default").toLowerCase();

  // 获取该 provider 的发车队列（Promise 链）
  let queueState = providerQueues.get(key);
  if (!queueState) {
    queueState = {
      tail: Promise.resolve(),
      nextEligibleAt: 0,
    };
    providerQueues.set(key, queueState);
  }

  // 挂载到队列尾部：每个后来者等待前序出队后再计算自己的排期。
  // 用 Promise 链传递"排期计算资格"，不持有锁 sleep，绝不阻塞其它 provider。
  const prevTail = queueState.tail;
  let releaseTail;
  queueState.tail = new Promise((resolve) => { releaseTail = resolve; });

  // 1. 等待轮到自己获得排期计算资格
  let currentTime, targetSendTime, waitMs;
  try {
    try {
      await prevTail;
    } catch {
      // 容错：前序 ticket 即使异常被 abort，不阻断后续任务出队
    }

    if (signal?.aborted) {
      const err = new Error("Operation cancelled before stagger slot assignment");
      err.code = "CANCELLED";
      throw err;
    }

    currentTime = now();
    const delay = computeStaggerDelay(minMs, maxMs, random);

    // 计算本 turn 发送时间点：基于上一次排期时间或当前时间
    targetSendTime = Math.max(currentTime, queueState.nextEligibleAt);
    // 下一次同 provider 发送最早必须在此刻的 delay 之后
    queueState.nextEligibleAt = targetSendTime + delay;

    // 计算当前 turn 需要等待的毫秒数
    waitMs = Math.max(0, targetSendTime - currentTime);
  } finally {
    // 无论成功/取消/异常，都必须放行后续排队请求，绝不持锁等待 sleep
    releaseTail();
  }

  // 2. 释放调度互斥后，自身独立进入 sleep
  if (waitMs > 0) {
    if (signal?.aborted) {
      const err = new Error("Operation cancelled");
      err.code = "CANCELLED";
      throw err;
    }
    await sleep(waitMs);
    if (signal?.aborted) {
      const err = new Error("Operation cancelled");
      err.code = "CANCELLED";
      throw err;
    }
  }

  return {
    waitedMs: waitMs,
    scheduledAt: targetSendTime,
  };
}

/**
 * 辅助清理，供测试环境隔离重置使用
 */
export function resetStaggerQueues() {
  providerQueues.clear();
}
