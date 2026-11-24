import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
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

test("turn-lock: concurrent acquire throws CONCURRENT_TURN_BUSY", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-turnlock-"));
  try {
    const first = await acquireTurnLock(home, "chatgpt", { timeoutMs: 1000 });
    await assert.rejects(
      () => acquireTurnLock(home, "chatgpt", { timeoutMs: 300, pollIntervalMs: 50 }),
      (err) => err?.code === "CONCURRENT_TURN_BUSY"
    );
    await first.release();
    // 释放后可重新获取
    const second = await acquireTurnLock(home, "chatgpt", { timeoutMs: 1000 });
    await second.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("turn-lock: stale lock (dead pid) is reclaimed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-turnlock-stale-"));
  try {
    const dir = path.join(home);
    const lockPath = path.join(dir, "cdp-turn-chatgpt.lock");
    // 写入一个 pid=999999（必然不存在）的陈旧锁
    await writeFile(lockPath, JSON.stringify({ pid: 999999, lockId: "stale", provider: "chatgpt", acquiredAt: Date.now() }) + "\n", "utf8");
    const lock = await acquireTurnLock(home, "chatgpt", { timeoutMs: 1000, pollIntervalMs: 50 });
    const raw = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(raw.lockId, lock.lockId, "stale lock must be replaced");
    await lock.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("turn-lock: release only removes own lock", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-turnlock-own-"));
  try {
    const lockPath = path.join(home, "cdp-turn-gemini.lock");
    const lock = await acquireTurnLock(home, "gemini", { timeoutMs: 1000 });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, lockId: "other", provider: "gemini", acquiredAt: Date.now() }) + "\n", "utf8");
    await lock.release();
    const raw = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(raw.lockId, "other", "release must not delete someone else's lock");
    await rm(lockPath, { force: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
