import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTurn, canTransition, transition, publicView, isSendCommitted, TERMINAL_STATES } from "../src/broker/turns.js";
import { createScheduler, schedule, release, snapshot } from "../src/broker/queue.js";
import { acquireInstanceLock, clearBrokerRecord, getBrokerPaths, isInstanceAlive,
  readBrokerRecord, writeBrokerRecord } from "../src/broker/lifecycle.js";
import { startBroker } from "../src/broker/server.js";
import { discoverBroker, ensureBroker, request, createTurn as remoteCreateTurn, getTurn } from "../src/broker/client.js";

const tempHome = () => mkdtemp(path.join(os.tmpdir(), "wfa-broker-test-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(fn, limitMs = 2000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  assert.fail("Condition was not met");
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test("createTurn defaults and publicView do not expose the full prompt", () => {
  const prompt = "🙂".repeat(140);
  const turn = createTurn({ provider: "chatgpt", prompt });
  assert.equal(turn.state, "queued");
  assert.equal(turn.mode, "background");
  assert.equal(turn.conversationId, null);
  assert.ok(turn.id);
  const publicTurn = publicView(turn);
  assert.equal(Object.hasOwn(publicTurn, "prompt"), false);
  assert.equal(Array.from(publicTurn.promptPreview).length, 120);
  assert.equal(JSON.stringify(publicTurn).includes(prompt), false);
  assert.equal(isSendCommitted(turn), false);
  assert.equal(isSendCommitted({ sendCommittedAt: "now" }), true);
  assert.deepEqual(TERMINAL_STATES, ["completed", "failed", "stalled"]);
  assert.throws(() => createTurn({ provider: "chatgpt", prompt: " " }), { code: "INVALID_ARGUMENT" });
});

test("strict transition table and immutability", () => {
  const edges = {
    queued: ["running", "failed"],
    running: ["completed", "needs_human", "takeover", "stalled", "failed"],
    needs_human: ["running", "failed"],
    takeover: ["running", "failed"],
    completed: [], failed: [], stalled: [],
  };
  for (const [from, targets] of Object.entries(edges)) {
    for (const to of targets) {
      assert.equal(canTransition(from, to), true);
      const original = { ...createTurn({ provider: "gemini", prompt: "hello" }), state: from };
      const next = transition(original, to, { reason: "ok" });
      assert.equal(next.state, to);
      assert.equal(original.state, from);
      assert.notEqual(next, original);
    }
  }
  assert.throws(() => transition({ state: "running" }, "running"), { code: "INVALID_TRANSITION" });
  assert.throws(() => transition({ state: "completed" }, "running"), { code: "INVALID_TRANSITION" });
});

test("scheduler enforces conversation, provider and global limits; release restores slots", () => {
  const scheduler = createScheduler();
  const turn = (provider, conversationId) => createTurn({ provider, prompt: "hi", conversationId });
  const a = turn("chatgpt", "shared");
  const b = turn("gemini", "shared");
  const c = turn("chatgpt", "c-only");
  const d = turn("gemini", "different");
  const e = turn("chatgpt", null);
  assert.deepEqual(schedule(scheduler, a), { accepted: true });
  assert.equal(schedule(scheduler, b).reason, "conversation_busy");
  assert.equal(schedule(scheduler, c).reason, "provider_busy");
  assert.equal(schedule(scheduler, d).accepted, true);
  assert.equal(schedule(scheduler, e).reason, "provider_busy");
  const f = { ...turn("chatgpt", null), provider: "other" };
  assert.equal(schedule(scheduler, f).reason, "global_busy");
  assert.equal(snapshot(scheduler).runningTotal, 2);
  release(scheduler, a);
  assert.equal(schedule(scheduler, c).accepted, true);
  release(scheduler, c);
  release(scheduler, d);
  assert.equal(schedule(scheduler, b).accepted, true);
  release(scheduler, b);
  const x = turn("chatgpt", null), y = turn("gemini", null);
  assert.equal(schedule(scheduler, x).accepted, true);
  assert.equal(schedule(scheduler, y).accepted, true);
  release(scheduler, x);
  release(scheduler, y);
  const anon = turn("chatgpt", null);
  const named = turn("gemini", `anonymous:${anon.id}`);
  assert.equal(schedule(scheduler, anon).accepted, true);
  assert.equal(schedule(scheduler, named).accepted, true);
  release(scheduler, anon);
  release(scheduler, named);
});

test("lifecycle record, exclusive lock, stale owner recovery", async t => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const record = { schema: 1, instanceId: "example", pid: process.pid,
    host: "127.0.0.1", port: 40001, token: "secret" };
  await writeBrokerRecord(home, record);
  assert.deepEqual(await readBrokerRecord(home), record);
  assert.equal(await isInstanceAlive(record), false);
  const lock = await acquireInstanceLock(home);
  assert.ok(lock);
  assert.equal(await acquireInstanceLock(home), null);
  await lock.release();
  await writeFile(path.join(home, "broker.lock"), JSON.stringify({ pid: 2147483647, instanceId: "stale" }));
  const successor = await acquireInstanceLock(home);
  assert.ok(successor);
  await successor.release();
  await clearBrokerRecord(home, "example");
  assert.equal(await readBrokerRecord(home), null);
  await writeFile(getBrokerPaths(home).brokerJson, "{broken");
  assert.equal(await readBrokerRecord(home), null);
});

test("HTTP authentication, completion, runner exception, release, and shutdown", async t => {
  const home = await tempHome();
  let calls = 0;
  const server = await startBroker({ home, mode: "tray", runner: {
    run: async turn => {
      calls++;
      if (turn.prompt === "throw") throw Object.assign(new Error("test"), { code: "TEST_FAIL" });
      return { status: "completed", text: `reply ${calls}` };
    },
    cancel() {},
  } });
  t.after(async () => { await server.close(); await rm(home, { recursive: true, force: true }); });
  const record = await discoverBroker(home);
  assert.equal(record.instanceId, server.instanceId);
  assert.equal((await fetch(`${server.url}/status`)).status, 401);
  assert.equal((await fetch(`${server.url}/turns`, { method: "POST" })).status, 401);
  assert.equal((await request(record, "POST", "/turns", { provider: "chatgpt", prompt: " " })).status, 400);
  const created = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "hello" });
  assert.equal(created.status, 202);
  const completed = await eventually(async () => {
    const r = await getTurn(record, created.json.id);
    return r.json.state === "completed" ? r.json : null;
  });
  assert.equal(completed.text, "reply 1");
  assert.equal(Object.hasOwn(completed, "prompt"), false);
  const thrown = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "throw" });
  const failed = await eventually(async () => {
    const r = await getTurn(record, thrown.json.id);
    return r.json.state === "failed" ? r.json : null;
  });
  assert.equal(failed.reason, "TEST_FAIL");
  assert.equal((await request(record, "GET", "/status")).json.scheduler.runningTotal, 0);
  assert.equal((await request(record, "POST", "/shutdown")).status, 202);
  await eventually(async () => !await discoverBroker(home));
  await eventually(async () => {
    try { await fetch(`${server.url}/status`); return false; }
    catch { return true; }
  });
  await eventually(async () => await readBrokerRecord(home) === null);
});

test("FIFO queue across providers; running cancellation keeps lease until runner settles", async t => {
  const home = await tempHome();
  const first = deferred();
  const blocker = deferred();
  const server = await startBroker({ home, mode: "tray", runner: {
    run: turn => turn.prompt === "first" ? first.promise :
      turn.prompt === "blocked" ? blocker.promise : Promise.resolve({ status: "completed" }),
    cancel() {},
  } });
  t.after(async () => { first.resolve({ status: "completed" }); blocker.resolve({ status: "completed" }); await server.close(); await rm(home, { recursive: true, force: true }); });
  const record = await discoverBroker(home);
  const a = (await remoteCreateTurn(record, { provider: "chatgpt", prompt: "first", conversationId: "c" })).json;
  const b = (await remoteCreateTurn(record, { provider: "chatgpt", prompt: "second", conversationId: "c" })).json;
  const c = (await remoteCreateTurn(record, { provider: "gemini", prompt: "blocked" })).json;
  assert.equal((await getTurn(record, b.id)).json.state, "queued");
  assert.equal((await request(record, "GET", "/status")).json.scheduler.runningTotal, 2);
  assert.equal((await request(record, "POST", `/turns/${a.id}/cancel`)).status, 200);
  assert.equal((await getTurn(record, b.id)).json.state, "queued");
  first.resolve({ status: "completed" });
  await eventually(async () => (await getTurn(record, b.id)).json.state === "completed");
  blocker.resolve({ status: "completed" });
  await eventually(async () => (await request(record, "GET", "/status")).json.scheduler.runningTotal === 0);
  assert.equal((await getTurn(record, a.id)).json.reason, "cancelled");
});

test("ensureBroker discovers and spawns; off mode idles out", async t => {
  const home = await tempHome();
  let server;
  t.after(async () => { await server?.close(); await rm(home, { recursive: true, force: true }); });
  let spawned = 0;
  const record = await ensureBroker({ home, timeoutMs: 1000, spawnBroker: async () => {
    spawned++;
    server = await startBroker({ home, mode: "off", idleTimeoutMs: 30,
      runner: { run: async () => ({ status: "completed" }) } });
  } });
  assert.equal(spawned, 1);
  assert.equal(record.instanceId, server.instanceId);
  assert.equal((await ensureBroker({ home, spawnBroker: () => { spawned++; } })).instanceId, server.instanceId);
  assert.equal(spawned, 1);
  await eventually(async () => await discoverBroker(home) === null);
});
