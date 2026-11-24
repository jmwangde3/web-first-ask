import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computePaceDelay, isPacingEnabled, pace } from "../src/browser/pacer.js";
import { acquireTurnLock } from "../src/broker/turn-lock.js";

test("pacer: casual delay is within 1000-2000ms, batch within 4000-6000ms", () => {
  for (const kind of ["casual", "batch"]) {
    const range = kind === "casual" ? { min: 1000, max: 2000 } : { min: 4000, max: 6000 };
    for (let i = 0; i < 200; i++) {
      const d = computePaceDelay(kind, () => Math.random());
      assert.ok(d >= range.min && d <= range.max, `${kind} delay ${d} out of range`);
    }
  }
  // 固定随机数边界
  assert.equal(computePaceDelay("casual", () => 0), 1000);
  assert.equal(computePaceDelay("casual", () => 0.9999), 2000);
  assert.equal(computePaceDelay("batch", () => 0), 4000);
  assert.equal(computePaceDelay("batch", () => 0.9999), 6000);
});

test("pacer: never zero interval; disabled returns 0 without sleep", async () => {
  let slept = 0;
  const d = await pace("casual", {
    enabled: true,
    sleep: async (ms) => { slept += ms; },
    random: () => 0.5,
  });
  assert.equal(d, 1500);
  assert.equal(slept, 1500);
  assert.ok(d > 0, "pace must not be 0 interval");

  let disabledSlept = 0;
  const d2 = await pace("batch", {
    enabled: false,
    sleep: async (ms) => { disabledSlept += ms; },
  });
  assert.equal(d2, 0);
  assert.equal(disabledSlept, 0);
});

test("pacer: respects aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => pace("casual", { enabled: true, signal: controller.signal, sleep: async () => {} }),
    (err) => err?.code === "CANCELLED"
  );
});

test("pacer: isPacingEnabled honors explicit option over env", () => {
  assert.equal(isPacingEnabled({ enabled: false }), false);
  assert.equal(isPacingEnabled({ enabled: true }), true);
});

test("turn-lock: concurrent acquire on same conversation throws CONCURRENT_TURN_BUSY", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-turnlock-"));
  try {
    const first = await acquireTurnLock(home, "chatgpt", { conversationId: "conv-locked", timeoutMs: 1000 });
    await assert.rejects(
      () => acquireTurnLock(home, "chatgpt", { conversationId: "conv-locked", timeoutMs: 300, pollIntervalMs: 50 }),
      (err) => err?.code === "CONCURRENT_TURN_BUSY"
    );
    await first.release();
    // 释放后可重新获取
    const second = await acquireTurnLock(home, "chatgpt", { conversationId: "conv-locked", timeoutMs: 1000 });
    await second.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

