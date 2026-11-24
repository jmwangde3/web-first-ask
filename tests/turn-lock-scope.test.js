import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acquireTurnLock } from "../src/broker/turn-lock.js";

async function withTempHome(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-scope-test-"));
  try { await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const opts = (conversationId) => ({ conversationId, timeoutMs: 5000, pollIntervalMs: 10 });

function runChild(home, script) {
  const moduleUrl = new URL("../src/broker/turn-lock.js", import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, moduleUrl, home], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

test("turn-lock: simultaneous same-conversation callers are serialized", async () => {
  await withTempHome(async (home) => {
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      const lock = await acquireTurnLock(home, "chatgpt", opts("same"));
      try {
        active++;
        peak = Math.max(peak, active);
        await delay(10);
      } finally {
        active--;
        await lock.release();
      }
    }));
    assert.equal(peak, 1);
    assert.deepEqual(await readdir(path.join(home, "cdp-turn-locks-v2")), []);
  });
});

test("turn-lock: unrelated conversations/providers/anonymous turns never block each other", async () => {
  await withTempHome(async (home) => {
    const held = await Promise.all([
      acquireTurnLock(home, "chatgpt", opts("same")),
      acquireTurnLock(home, "chatgpt", opts("other")),
      acquireTurnLock(home, "gemini", opts("same")),
      acquireTurnLock(home, "chatgpt", { ...opts(null), turnId: "same" }),
      acquireTurnLock(home, "chatgpt", { ...opts(null), turnId: "same" }),
    ]);
    try {
      assert.equal(new Set(held.map((lock) => lock.lockPath)).size, held.length);
    } finally {
      await Promise.all(held.map((lock) => lock.release()));
    }
  });
});

test("turn-lock: elapsed TTL never permits stealing a live owner's lock; timeout cleans its ticket", async () => {
  await withTempHome(async (home) => {
    const first = await acquireTurnLock(home, "chatgpt", opts("same"));
    try {
      await assert.rejects(acquireTurnLock(home, "CHATGPT", {
        ...opts("same"), timeoutMs: 80, staleTimeoutMs: 0,
      }), { code: "CONCURRENT_TURN_BUSY" });
      assert.deepEqual(await readdir(path.dirname(first.lockPath)), [path.basename(first.lockPath)]);
    } finally {
      await first.release();
    }
    const next = await acquireTurnLock(home, "chatgpt", opts("same"));
    await first.release(); // stale release must never affect successor
    await next.release();
  });
});

test("turn-lock: cancellation while waiting cleans up only its own ticket", async () => {
  await withTempHome(async (home) => {
    const first = await acquireTurnLock(home, "chatgpt", opts("same"));
    const controller = new AbortController();
    try {
      const pending = acquireTurnLock(home, "chatgpt", { ...opts("same"), signal: controller.signal });
      const rejected = assert.rejects(pending, { code: "CANCELLED" });
      await delay(30);
      controller.abort();
      await rejected;
      assert.deepEqual(await readdir(path.dirname(first.lockPath)), [path.basename(first.lockPath)]);
    } finally {
      await first.release();
    }
  });
});

test("turn-lock: actual subprocesses recover a dead owner and never overlap", async () => {
  await withTempHome(async (home) => {
    await runChild(home, `
      const { acquireTurnLock } = await import(process.argv[1]);
      await acquireTurnLock(process.argv[2], "chatgpt", { conversationId: "same" });
      process.exit(0);
    `);
    assert.equal((await readdir(path.join(home, "cdp-turn-locks-v2"))).length, 1);
    const worker = `
      import { open, rm } from "node:fs/promises";
      import path from "node:path";
      import { setTimeout as delay } from "node:timers/promises";
      const { acquireTurnLock } = await import(process.argv[1]);
      const home = process.argv[2];
      const lock = await acquireTurnLock(home, "chatgpt", {
        conversationId: "same", timeoutMs: 5000, pollIntervalMs: 10,
      });
      const sentinel = path.join(home, "inside-critical-section");
      try {
        const handle = await open(sentinel, "wx");
        try { await delay(25); }
        finally { await handle.close(); await rm(sentinel); }
      } finally { await lock.release(); }
    `;
    await Promise.all(Array.from({ length: 6 }, () => runChild(home, worker)));
    assert.deepEqual(await readdir(path.join(home, "cdp-turn-locks-v2")), []);
  });
});
