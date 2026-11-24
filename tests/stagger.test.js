import assert from "node:assert/strict";
import test from "node:test";
import { computeStaggerDelay, resetStaggerQueues, withSendSlot } from "../src/browser/stagger.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function clock() {
  let value = 10000;
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; },
    random: () => 0.5,
  };
}

test.beforeEach(() => resetStaggerQueues());

test("stagger: inclusive integer range and fixed test samples", () => {
  assert.equal(computeStaggerDelay(3000, 5000, () => 0), 3000);
  assert.equal(computeStaggerDelay(3000, 5000, () => 0.5), 4000);
  assert.equal(computeStaggerDelay(3000, 5000, () => 0.999999), 5000);
  assert.equal(computeStaggerDelay(3000, 5000, () => 1), 5000);
});

test("stagger: concurrent sends wait after actual previous submit, not an old reservation", async () => {
  const c = clock();
  const firstEntered = deferred();
  const firstDone = deferred();
  const times = [];
  const a = withSendSlot("chatgpt", async () => {
    firstEntered.resolve();
    await firstDone.promise;
    times.push(c.now());
  }, c);
  await firstEntered.promise;
  const b = withSendSlot("chatgpt", () => times.push(c.now()), c);
  const d = withSendSlot("chatgpt", () => times.push(c.now()), c);
  await c.sleep(9000); // first actual click is delayed past any old reservations
  assert.deepEqual(times, []);
  firstDone.resolve();
  await Promise.all([a, b, d]);
  assert.deepEqual(times, [19000, 23000, 27000]);
});

test("stagger: different providers do not share the gate; existing conversation bypasses it", async () => {
  const c = clock();
  const entered = deferred();
  const done = deferred();
  const first = withSendSlot("chatgpt", async () => {
    entered.resolve();
    await done.promise;
  }, c);
  await entered.promise;
  assert.equal(await withSendSlot("gemini", () => c.now(), c), 10000);
  assert.equal(await withSendSlot("chatgpt", () => c.now(), { ...c, isNewConversation: false }), 10000);
  done.resolve();
  await first;
});

test("stagger: cancelling a middle queued ticket never lets a successor overtake the active send", async () => {
  const c = clock();
  const entered = deferred();
  const done = deferred();
  const controller = new AbortController();
  let sent = false;
  const first = withSendSlot("gemini", async () => {
    entered.resolve();
    await done.promise;
  }, c);
  await entered.promise;
  const second = withSendSlot("gemini", () => assert.fail("cancelled ticket submitted"), {
    ...c, signal: controller.signal,
  });
  const third = withSendSlot("gemini", () => { sent = true; return c.now(); }, c);
  controller.abort();
  await assert.rejects(second, { code: "CANCELLED" });
  assert.equal(sent, false);
  done.resolve();
  await first;
  assert.equal(await third, 14000);
});

test("stagger: abort during head wait releases the gate without creating a new reservation", async () => {
  const c = clock();
  const controller = new AbortController();
  const waiting = deferred();
  const never = deferred();
  await withSendSlot("chatgpt", () => null, c);
  const cancelled = withSendSlot("chatgpt", () => assert.fail("cancelled ticket submitted"), {
    ...c, signal: controller.signal,
    sleep: async () => { waiting.resolve(); await never.promise; },
  });
  await waiting.promise;
  const next = withSendSlot("chatgpt", () => c.now(), c);
  controller.abort();
  await assert.rejects(cancelled, { code: "CANCELLED" });
  assert.equal(await next, 14000);
  never.resolve();
});

test("stagger: an uncertain submit still imposes spacing, and pre-abort cannot send", async () => {
  const c = clock();
  await assert.rejects(withSendSlot("chatgpt", () => {
    throw Object.assign(new Error("unknown"), { code: "SEND_UNCONFIRMED" });
  }, c), { code: "SEND_UNCONFIRMED" });
  assert.equal(await withSendSlot("chatgpt", () => c.now(), c), 14000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withSendSlot("chatgpt", () => assert.fail("cancelled ticket submitted"), {
    ...c, signal: controller.signal,
  }), { code: "CANCELLED" });
});

test("stagger: abort after submit starts does not release the gate prematurely", async () => {
  const c = clock();
  const entered = deferred();
  const done = deferred();
  const controller = new AbortController();
  let sent = false;
  const first = withSendSlot("chatgpt", async () => {
    entered.resolve();
    await done.promise;
  }, { ...c, signal: controller.signal });
  await entered.promise;
  const next = withSendSlot("chatgpt", () => { sent = true; return c.now(); }, c);
  controller.abort();
  await Promise.resolve();
  assert.equal(sent, false);
  done.resolve();
  await first;
  assert.equal(await next, 14000);
});
