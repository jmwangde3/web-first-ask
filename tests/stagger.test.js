// tests/stagger.test.js
import assert from "node:assert/strict";
import test from "node:test";
import { computeStaggerDelay, resetStaggerQueues, waitForSendSlot } from "../src/browser/stagger.js";

test.beforeEach(() => {
  resetStaggerQueues();
});

test("stagger: computeStaggerDelay returns uniform jitter between 3000ms and 5000ms", () => {
  for (let i = 0; i < 50; i++) {
    const delay = computeStaggerDelay(3000, 5000, Math.random);
    assert.ok(delay >= 3000 && delay <= 5000, `Delay ${delay} out of range`);
  }
  assert.equal(computeStaggerDelay(3000, 5000, () => 0), 3000);
  assert.equal(computeStaggerDelay(3000, 5000, () => 0.5), 4000);
  assert.equal(computeStaggerDelay(3000, 5000, () => 1), 5000);
});

test("stagger: same provider calls are staggered sequentially by [3s, 5s]", async () => {
  let virtualTime = 10000;
  const sleeps = [];

  const fakeNow = () => virtualTime;
  const fakeSleep = async (ms) => {
    sleeps.push(ms);
    virtualTime += ms;
  };

  // 第 1 个新会话立即放行
  const p1 = await waitForSendSlot("chatgpt", {
    isNewConversation: true,
    now: fakeNow,
    sleep: fakeSleep,
    random: () => 0.5, // 4000ms
  });
  assert.equal(p1.waitedMs, 0);

  // 第 2 个新会话同 provider 并发，应等待 4000ms
  const p2 = await waitForSendSlot("chatgpt", {
    isNewConversation: true,
    now: fakeNow,
    sleep: fakeSleep,
    random: () => 0.5, // 4000ms
  });
  assert.equal(p2.waitedMs, 4000);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 4000);
});

test("stagger: different providers run independently without waiting each other", async () => {
  let virtualTime = 10000;
  const fakeNow = () => virtualTime;
  const fakeSleep = async (ms) => { virtualTime += ms; };

  // chatgpt 启动
  const c1 = await waitForSendSlot("chatgpt", {
    isNewConversation: true,
    now: fakeNow,
    sleep: fakeSleep,
    random: () => 0.5,
  });
  assert.equal(c1.waitedMs, 0);

  // gemini 在同一时间启动，跨 provider 零等待
  const g1 = await waitForSendSlot("gemini", {
    isNewConversation: true,
    now: fakeNow,
    sleep: fakeSleep,
    random: () => 0.5,
  });
  assert.equal(g1.waitedMs, 0);
});

test("stagger: existing conversation bypasses stagger", async () => {
  let virtualTime = 10000;
  let slept = false;
  const res = await waitForSendSlot("chatgpt", {
    isNewConversation: false, // 续聊
    now: () => virtualTime,
    sleep: async () => { slept = true; },
  });
  assert.equal(res.waitedMs, 0);
  assert.equal(slept, false);
});

test("stagger: abort signal cancels waiting", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => waitForSendSlot("chatgpt", {
      isNewConversation: true,
      signal: controller.signal,
      sleep: async () => {},
    }),
    (err) => err?.code === "CANCELLED"
  );
});

test("stagger: an aborted caller does not jam the provider queue", async () => {
  let virtualTime = 10000;
  const fakeNow = () => virtualTime;
  const fakeSleep = async (ms) => { virtualTime += ms; };

  const aborter = new AbortController();
  aborter.abort();
  await assert.rejects(
    () => waitForSendSlot("gemini", {
      isNewConversation: true,
      now: fakeNow,
      sleep: fakeSleep,
      random: () => 0.5,
      signal: aborter.signal,
    }),
    (err) => err?.code === "CANCELLED"
  );

  // 后续同 provider 请求仍能立即排期（队列未被前一个 abort 卡死）
  const next = await waitForSendSlot("gemini", {
    isNewConversation: true,
    now: fakeNow,
    sleep: fakeSleep,
    random: () => 0.5,
  });
  assert.equal(next.waitedMs, 0);
});
