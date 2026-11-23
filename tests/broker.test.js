import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTurn, canTransition, transition, publicView, isSendCommitted, TERMINAL_STATES } from "../src/broker/turns.js";
import { createScheduler, schedule, release, snapshot } from "../src/broker/queue.js";
import { acquireInstanceLock, clearBrokerRecord, getBrokerPaths, isInstanceAlive,
  readBrokerRecord, writeBrokerRecord } from "../src/broker/lifecycle.js";
import { startBroker } from "../src/broker/server.js";
import { discoverBroker, ensureBroker, request, createTurn as remoteCreateTurn, getTurn, waitForTurn } from "../src/broker/client.js";

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
  assert.equal(turn.requestId, null);
  assert.ok(turn.id);
  const publicTurn = publicView(turn);
  assert.equal(Object.hasOwn(publicTurn, "prompt"), false);
  assert.equal(Array.from(publicTurn.promptPreview).length, 120);
  assert.equal(JSON.stringify(publicTurn).includes(prompt), false);
  assert.equal(isSendCommitted(turn), false);
  assert.equal(isSendCommitted({ sendCommittedAt: "now" }), true);
  assert.deepEqual(TERMINAL_STATES, ["completed", "failed", "stalled"]);
  assert.throws(() => createTurn({ provider: "chatgpt", prompt: " " }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => createTurn({ provider: "chatgpt", prompt: "ok", requestId: "  " }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => createTurn({ provider: "chatgpt", prompt: "ok", requestId: 123 }), { code: "INVALID_ARGUMENT" });
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
  const scheduler = createScheduler({ maxPerProvider: 1, maxTotal: 2 });
  const turn = (provider, conversationId) => createTurn({ provider, prompt: "hi", conversationId });
  const a = turn("chatgpt", "shared");
  const aSame = turn("chatgpt", "shared");
  const b = turn("gemini", "shared");
  const c = turn("chatgpt", "c-only");
  const d = turn("gemini", "different");
  const e = turn("chatgpt", null);
  assert.deepEqual(schedule(scheduler, a), { accepted: true });
  assert.equal(schedule(scheduler, aSame).reason, "conversation_busy");
  assert.deepEqual(schedule(scheduler, b), { accepted: true });
  assert.equal(schedule(scheduler, c).reason, "provider_busy");
  assert.equal(schedule(scheduler, d).reason, "provider_busy");
  assert.equal(schedule(scheduler, e).reason, "provider_busy");
  assert.equal(snapshot(scheduler).runningTotal, 2);
  release(scheduler, a);
  const f = { ...turn("chatgpt", null), provider: "other" };
  assert.deepEqual(schedule(scheduler, c), { accepted: true });
  assert.equal(schedule(scheduler, f).reason, "global_busy");
  release(scheduler, c);
  release(scheduler, b);
  release(scheduler, aSame);
  release(scheduler, d);
  release(scheduler, e);
  release(scheduler, f);
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

test("scheduler enforces conversation and global limits while allowing same-provider independent conversations when maxPerProvider is 2", () => {
  const scheduler = createScheduler({ maxPerProvider: 2, maxTotal: 2 });
  const turn = (provider, conversationId) => createTurn({ provider, prompt: "hi", conversationId });
  const a = turn("chatgpt", "shared");
  const aSame = turn("chatgpt", "shared");
  const b = turn("gemini", "shared");
  const c = turn("chatgpt", "c-only");
  const d = turn("gemini", "d-only");
  assert.deepEqual(schedule(scheduler, a), { accepted: true });
  assert.equal(schedule(scheduler, aSame).reason, "conversation_busy");
  assert.deepEqual(schedule(scheduler, c), { accepted: true });
  assert.equal(schedule(scheduler, d).reason, "global_busy");
  assert.equal(snapshot(scheduler).runningTotal, 2);
  assert.equal(snapshot(scheduler).runningByProvider.chatgpt, 2);
  release(scheduler, a);
  assert.deepEqual(schedule(scheduler, b), { accepted: true });
  release(scheduler, c);
  release(scheduler, b);
  release(scheduler, aSame);
  release(scheduler, d);
  const x = turn("chatgpt", null), y = turn("chatgpt", null);
  assert.deepEqual(schedule(scheduler, x), { accepted: true });
  assert.deepEqual(schedule(scheduler, y), { accepted: true });
  release(scheduler, x);
  release(scheduler, y);
});

test("scheduler defaults to 4 per provider and 8 total, and scopes conversation lease by provider", () => {
  const scheduler = createScheduler();
  assert.equal(scheduler.maxPerProvider, 4);
  assert.equal(scheduler.maxTotal, 8);
  const turn = (provider, conversationId) => createTurn({ provider, prompt: "hi", conversationId });

  const sharedChatgpt = turn("chatgpt", "shared");
  const sharedGemini = turn("gemini", "shared");
  assert.deepEqual(schedule(scheduler, sharedChatgpt), { accepted: true });
  assert.deepEqual(schedule(scheduler, sharedGemini), { accepted: true });

  const sameProviderBusy = turn("chatgpt", "shared");
  assert.equal(schedule(scheduler, sameProviderBusy).reason, "conversation_busy");

  const chatgptTurns = [
    sharedChatgpt,
    turn("chatgpt", "c-2"),
    turn("chatgpt", "c-3"),
    turn("chatgpt", "c-4"),
  ];
  const geminiTurns = [
    sharedGemini,
    turn("gemini", "g-2"),
    turn("gemini", "g-3"),
    turn("gemini", "g-4"),
  ];
  for (const t of chatgptTurns.slice(1)) {
    assert.deepEqual(schedule(scheduler, t), { accepted: true });
  }
  for (const t of geminiTurns.slice(1)) {
    assert.deepEqual(schedule(scheduler, t), { accepted: true });
  }

  const state = snapshot(scheduler);
  assert.equal(state.runningTotal, 8);
  assert.equal(state.runningByProvider.chatgpt, 4);
  assert.equal(state.runningByProvider.gemini, 4);

  const fifthGemini = turn("gemini", "g-5");
  assert.equal(schedule(scheduler, fifthGemini).reason, "provider_busy");
  assert.equal(snapshot(scheduler).queued.some(item => item.id === fifthGemini.id), true);

  for (const t of [...chatgptTurns, ...geminiTurns, sameProviderBusy, fifthGemini]) {
    release(scheduler, t);
  }
  assert.equal(snapshot(scheduler).runningTotal, 0);
  assert.equal(snapshot(scheduler).queued.length, 0);
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
  const statusRes = await request(record, "GET", "/status");
  assert.equal(statusRes.json.scheduler.runningTotal, 0);
  assert.equal(statusRes.json.port, server.port);
  assert.equal(statusRes.json.url, server.url);
  assert.equal((await request(record, "POST", "/shutdown")).status, 202);
  await server.closed;
  assert.ok(true, "server.closed resolved");
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

test("8 concurrent ensureBroker calls trigger only 1 spawnBroker and all receive the same record", async t => {
  const home = await tempHome();
  let server;
  t.after(async () => { await server?.close(); await rm(home, { recursive: true, force: true }); });
  let spawned = 0;
  const spawnBroker = async () => {
    spawned++;
    await delay(50);
    server = await startBroker({
      home,
      mode: "tray",
      runner: { run: async () => ({ status: "completed" }), cancel() {} },
    });
  };
  const records = await Promise.all(
    Array.from({ length: 8 }, () => ensureBroker({ home, timeoutMs: 5000, spawnBroker }))
  );
  assert.equal(spawned, 1);
  for (const r of records) {
    assert.deepEqual(r, records[0]);
    assert.equal(r.instanceId, server.instanceId);
  }
});

test("ensureBroker recovers stale broker-start.lock with dead pid without deadlocking", async t => {
  const home = await tempHome();
  let server;
  t.after(async () => { await server?.close(); await rm(home, { recursive: true, force: true }); });
  await writeFile(
    path.join(home, "broker-start.lock"),
    JSON.stringify({ pid: 2147483647, createdAt: Date.now(), lockId: "stale-lock" }),
  );
  let spawned = 0;
  const record = await ensureBroker({
    home,
    timeoutMs: 3000,
    spawnBroker: async () => {
      spawned++;
      server = await startBroker({
        home,
        mode: "tray",
        runner: { run: async () => ({ status: "completed" }), cancel() {} },
      });
    },
  });
  assert.equal(spawned, 1);
  assert.equal(record.instanceId, server.instanceId);
});

test("clearBrokerRecord concurrent calls do not throw ENOENT or safe-delete errors", async t => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const record = {
    schema: 1,
    instanceId: "concurrent-clear",
    pid: process.pid,
    host: "127.0.0.1",
    port: 40002,
    token: "secret",
  };
  await writeBrokerRecord(home, record);
  await Promise.all(
    Array.from({ length: 8 }, () => clearBrokerRecord(home, record.instanceId))
  );
  assert.equal(await readBrokerRecord(home), null);
  await clearBrokerRecord(home, record.instanceId);
});

test("acquireInstanceLock writes complete JSON atomically under concurrent contention", async t => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const results = await Promise.all(
    Array.from({ length: 8 }, () => acquireInstanceLock(home))
  );
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  const raw = await readFile(path.join(home, "broker.lock"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.pid, process.pid);
  assert.equal(parsed.instanceId, winners[0].instanceId);
  await winners[0].release();
});

test("isInstanceAlive retries once after single fetch timeout and returns true", async t => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url !== "/status" || req.headers["x-wfa-token"] !== "tok") {
      res.writeHead(401);
      res.end();
      return;
    }
    if (hits === 1) {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ instanceId: "retry-inst", pid: process.pid }));
        }
      }, 450);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ instanceId: "retry-inst", pid: process.pid }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const record = {
    schema: 1,
    instanceId: "retry-inst",
    pid: process.pid,
    host: "127.0.0.1",
    port,
    token: "tok",
  };
  assert.equal(await isInstanceAlive(record), true);
  assert.equal(hits, 2);
});

test("requestId idempotency: same fingerprint replays same turnId; different fingerprint returns 409", async t => {
  const home = await tempHome();
  let runs = 0;
  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async (turn) => {
        runs++;
        return { status: "completed", text: `ok:${turn.prompt}` };
      },
      cancel() {},
    },
  });
  t.after(async () => { await server.close(); await rm(home, { recursive: true, force: true }); });

  const record = await discoverBroker(home);
  const first = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "idempotent", requestId: "req-idem-1" });
  assert.equal(first.status, 202);

  await eventually(async () => (await getTurn(record, first.json.id)).json.state === "completed");

  const replay = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "idempotent", requestId: "req-idem-1" });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  assert.equal(replay.json.state, "completed");
  assert.equal(runs, 1);

  const conflict = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "different prompt", requestId: "req-idem-1" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "REQUEST_ID_CONFLICT");
  assert.equal(runs, 1);
});

test("completed turn survives broker restart via GET /turns/:id and requestId replay", async t => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server1 = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async () => ({ status: "completed", text: "persisted answer" }),
      cancel() {},
    },
  });
  const record1 = await discoverBroker(home);
  const created = await remoteCreateTurn(record1, {
    provider: "gemini",
    prompt: "persist across restart",
    requestId: "req-persist-1",
  });
  assert.equal(created.status, 202);
  await eventually(async () => (await getTurn(record1, created.json.id)).json.state === "completed");
  await server1.close();

  let runsAfterRestart = 0;
  const server2 = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async () => {
        runsAfterRestart++;
        return { status: "completed", text: "should not re-run" };
      },
      cancel() {},
    },
  });
  t.after(() => server2.close());
  const record2 = await discoverBroker(home);

  const fetched = await getTurn(record2, created.json.id);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.state, "completed");
  assert.equal(fetched.json.text, "persisted answer");
  assert.equal(Object.hasOwn(fetched.json, "prompt"), false);

  const replay = await remoteCreateTurn(record2, {
    provider: "gemini",
    prompt: "persist across restart",
    requestId: "req-persist-1",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, created.json.id);
  assert.equal(runsAfterRestart, 0);
});

test("client waitForTurn backs off on transient errors and re-discovers broker port without resending", async () => {
  const record1 = { host: "127.0.0.1", port: 41001, token: "t1" };
  const record2 = { host: "127.0.0.1", port: 41002, token: "t2" };
  const calls = [];
  const sleeps = [];
  let nowMs = 0;
  let discoverCalls = 0;

  const turn = await waitForTurn({
    record: record1,
    turnId: "turn-reconnect-1",
    home: "/tmp/fake-home",
    timeoutMs: 30000,
    deps: {
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      discoverBroker: async () => {
        discoverCalls++;
        return discoverCalls >= 2 ? record2 : null;
      },
      getTurn: async (rec, id) => {
        calls.push({ port: rec.port, id });
        if (calls.length === 1) {
          throw Object.assign(new Error("timeout"), { code: "BROKER_TIMEOUT" });
        }
        if (calls.length === 2) {
          throw Object.assign(new Error("unreachable"), { code: "BROKER_UNREACHABLE" });
        }
        if (rec.port === 41002) {
          return { status: 200, json: { id, state: "completed", text: "reconnected!" } };
        }
        return { status: 200, json: { id, state: "running" } };
      },
    },
  });

  assert.equal(turn.state, "completed");
  assert.equal(turn.text, "reconnected!");
  assert.deepEqual(calls, [
    { port: 41001, id: "turn-reconnect-1" },
    { port: 41001, id: "turn-reconnect-1" },
    { port: 41002, id: "turn-reconnect-1" },
  ]);
  assert.deepEqual(sleeps, [500, 1000]);

  // Exceeding reconnect window throws BROKER_UNREACHABLE with turnId
  let now2 = 0;
  await assert.rejects(
    () => waitForTurn({
      record: record1,
      turnId: "turn-lost-99",
      timeoutMs: 2000,
      deps: {
        now: () => now2,
        sleep: async (ms) => { now2 += ms; },
        discoverBroker: async () => null,
        getTurn: async () => {
          throw Object.assign(new Error("unreachable"), { code: "BROKER_UNREACHABLE" });
        },
      },
    }),
    (err) => err?.code === "BROKER_UNREACHABLE" && err.message.includes("turn-lost-99"),
  );
});

test("8 concurrent different turns complete without cross-talk", async t => {
  const home = await tempHome();
  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async (turn) => {
        await delay(20);
        return { status: "completed", text: `reply:${turn.provider}:${turn.prompt}` };
      },
      cancel() {},
    },
  });
  t.after(async () => { await server.close(); await rm(home, { recursive: true, force: true }); });
  const record = await discoverBroker(home);

  const specs = Array.from({ length: 8 }, (_, idx) => ({
    provider: idx % 2 === 0 ? "chatgpt" : "gemini",
    prompt: `concurrent-prompt-${idx}`,
    conversationId: `conv-${idx}`,
    requestId: `req-conc-${idx}`,
  }));

  const createdList = await Promise.all(specs.map((s) => remoteCreateTurn(record, s)));
  for (const res of createdList) {
    assert.equal(res.status, 202);
  }
  const ids = createdList.map((r) => r.json.id);
  assert.equal(new Set(ids).size, 8);

  const results = await Promise.all(
    ids.map((id) => waitForTurn({ record, turnId: id, home, timeoutMs: 10000, pollIntervalMs: 20 }))
  );

  for (let i = 0; i < specs.length; i++) {
    assert.equal(results[i].state, "completed");
    assert.equal(results[i].text, `reply:${specs[i].provider}:${specs[i].prompt}`);
  }
});
