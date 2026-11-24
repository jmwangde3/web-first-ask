// tests/turn-lock-scope.test.js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireTurnLock } from "../src/broker/turn-lock.js";

async function withTempHome(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-scope-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("turn-lock: same conversation on same provider is strictly serialized", async () => {
  await withTempHome(async (home) => {
    const lock1 = await acquireTurnLock(home, "chatgpt", {
      conversationId: "conv-123",
      timeoutMs: 1000,
    });
    assert.ok(lock1);

    // 相同 provider 和 conversationId 发生冲突
    await assert.rejects(
      () => acquireTurnLock(home, "chatgpt", {
        conversationId: "conv-123",
        timeoutMs: 300,
        pollIntervalMs: 50,
      }),
      (err) => err?.code === "CONCURRENT_TURN_BUSY"
    );

    await lock1.release();

    // 释放后可重新获得
    const lock2 = await acquireTurnLock(home, "chatgpt", {
      conversationId: "conv-123",
      timeoutMs: 1000,
    });
    assert.ok(lock2);
    await lock2.release();
  });
});

test("turn-lock: different conversations on same provider run concurrently", async () => {
  await withTempHome(async (home) => {
    const lock1 = await acquireTurnLock(home, "chatgpt", {
      conversationId: "conv-AAA",
      timeoutMs: 1000,
    });
    const lock2 = await acquireTurnLock(home, "chatgpt", {
      conversationId: "conv-BBB",
      timeoutMs: 1000,
    });
    assert.ok(lock1);
    assert.ok(lock2);
    assert.notEqual(lock1.lockPath, lock2.lockPath);

    await lock1.release();
    await lock2.release();
  });
});

test("turn-lock: same conversationId across different providers does not conflict", async () => {
  await withTempHome(async (home) => {
    const lock1 = await acquireTurnLock(home, "chatgpt", {
      conversationId: "conv-shared",
      timeoutMs: 1000,
    });
    const lock2 = await acquireTurnLock(home, "gemini", {
      conversationId: "conv-shared",
      timeoutMs: 1000,
    });
    assert.ok(lock1);
    assert.ok(lock2);

    await lock1.release();
    await lock2.release();
  });
});

test("turn-lock: new turns without conversationId never block each other", async () => {
  await withTempHome(async (home) => {
    const lock1 = await acquireTurnLock(home, "chatgpt", { conversationId: null, timeoutMs: 1000 });
    const lock2 = await acquireTurnLock(home, "chatgpt", { conversationId: null, timeoutMs: 1000 });
    assert.ok(lock1);
    assert.ok(lock2);
    assert.notEqual(lock1.lockPath, lock2.lockPath);

    await lock1.release();
    await lock2.release();
  });
});
