import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireTurnLock } from "../src/broker/turn-lock.js";
import { acquireInstanceLock } from "../src/broker/lifecycle.js";

const DEAD_PID = 2147483647;

function makeWindowsEperm(src, dst) {
  const err = new Error(`EPERM: operation not permitted, rename '${src}' -> '${dst}'`);
  err.code = "EPERM";
  err.errno = -4048;
  err.syscall = "rename";
  return err;
}

test("turn-lock: publishes .lock via create-by-rename onto non-existent target (never overwrites existing .lock)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wfa-lock-no-overwrite-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const originalRename = fs.rename.bind(fs);
  let ticketRenames = 0;
  let overwroteExisting = false;

  t.mock.method(fs, "rename", async (src, dst) => {
    if (String(src).endsWith(".lock.ready") && String(dst).endsWith(".lock")) {
      ticketRenames += 1;
      const exists = await fs.access(dst).then(() => true).catch(() => false);
      if (exists) overwroteExisting = true;
    }
    return originalRename(src, dst);
  });

  let active = 0;
  let maxActive = 0;
  await Promise.all(
    Array.from({ length: 12 }, async (_, idx) => {
      const lock = await acquireTurnLock(home, "chatgpt", {
        conversationId: "conv-no-overwrite",
        turnId: `t-${idx}`,
        timeoutMs: 10000,
        pollIntervalMs: 5,
      });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
      await lock.release();
    }),
  );

  assert.equal(ticketRenames, 12);
  assert.equal(overwroteExisting, false, "must never overwrite an existing .lock file on rename");
  assert.equal(maxActive, 1, "mutual exclusion must hold across all 12 contenders");
  assert.deepEqual(await fs.readdir(path.join(home, "cdp-turn-locks-v2")), []);
});

test("turn-lock & instance-lock: recover from transient Windows EPERM on rename without losing exclusivity", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wfa-lock-transient-eperm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const originalRename = fs.rename.bind(fs);
  const failuresByDest = new Map();
  let injectedErrors = 0;

  t.mock.method(fs, "rename", async (src, dst) => {
    const key = String(dst);
    const seen = failuresByDest.get(key) || 0;
    if (seen < 2 && (key.endsWith(".lock") || key.endsWith("broker.lock"))) {
      failuresByDest.set(key, seen + 1);
      injectedErrors += 1;
      throw makeWindowsEperm(src, dst);
    }
    return originalRename(src, dst);
  });

  const lock = await acquireTurnLock(home, "gemini", {
    conversationId: "transient-eperm",
    timeoutMs: 5000,
    pollIntervalMs: 10,
  });
  await lock.release();

  const results = await Promise.all(Array.from({ length: 8 }, () => acquireInstanceLock(home)));
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.ok(injectedErrors >= 4, "must have actually hit and recovered from injected EPERM");

  const stored = JSON.parse(await fs.readFile(path.join(home, "broker.lock"), "utf8"));
  assert.deepEqual(stored, { pid: process.pid, instanceId: winners[0].instanceId });
  await winners[0].release();
  assert.deepEqual(await fs.readdir(path.join(home, "cdp-turn-locks-v2")), []);
});

test("turn-lock & instance-lock: persistent EPERM is never ignored and fails boundedly", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wfa-lock-persist-eperm-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  let renameCalls = 0;
  t.mock.method(fs, "rename", async (src, dst) => {
    renameCalls += 1;
    throw makeWindowsEperm(src, dst);
  });

  const started = Date.now();
  await assert.rejects(
    acquireTurnLock(home, "chatgpt", {
      conversationId: "persist-eperm",
      timeoutMs: 5000,
      pollIntervalMs: 10,
      sleep: async () => {},
    }),
    (err) => err?.code === "EPERM",
  );
  assert.ok(renameCalls >= 2 && renameCalls <= 10, `expected bounded retry attempts, got ${renameCalls}`);
  assert.ok(Date.now() - started < 2000, "must not retry infinitely");
  assert.deepEqual(await fs.readdir(path.join(home, "cdp-turn-locks-v2")), []);
});

test("stress: 10 rounds x 12 concurrent contenders on stale broker.lock produce exact 1 owner per round", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wfa-lock-stress-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const lockPath = path.join(home, "broker.lock");
  for (let round = 0; round < 10; round += 1) {
    await fs.writeFile(lockPath, JSON.stringify({ pid: DEAD_PID, instanceId: `stale-${round}` }) + "\n", "utf8");
    const results = await Promise.all(Array.from({ length: 12 }, () => acquireInstanceLock(home)));
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1, `round ${round}: expected exactly 1 winner`);
    assert.equal(results.filter((r) => r === null).length, 11);

    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.deepEqual(parsed, { pid: process.pid, instanceId: winners[0].instanceId });
    await winners[0].release();
  }

  assert.deepEqual(await fs.readdir(path.join(home, "cdp-turn-locks-v2")), []);
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
});
