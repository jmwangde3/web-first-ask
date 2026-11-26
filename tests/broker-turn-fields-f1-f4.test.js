import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startBroker } from "../src/broker/server.js";
import { discoverBroker, createTurn as remoteCreateTurn, getTurn } from "../src/broker/client.js";
import { runBrokerCommand } from "../src/broker/cli.js";
import * as turnStore from "../src/broker/turn-store.js";
import * as resultStore from "../src/broker/result-store.js";

const tempHome = () => mkdtemp(path.join(os.tmpdir(), "wfa-broker-f1-f4-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(fn, limitMs = 5000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  assert.fail("Condition was not met");
}

function createMockStream() {
  let content = "";
  return {
    write: (chunk) => { content += chunk; return true; },
    get output() { return content; },
  };
}

test("F1+F4: POST /turns with geminiMode task + downloadDir reaches the runner and the turn record", async t => {
  const home = await tempHome();
  const downloadDir = path.join(home, "f4-dl");
  const seen = [];
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async (turn) => {
        seen.push({ geminiMode: turn.geminiMode, downloadDir: turn.downloadDir });
        return {
          status: "completed",
          text: "TASK_OK_4",
          geminiMode: "task",
          downloads: [{ fileName: "sample.csv", path: path.join(downloadDir, "sample.csv"), sizeBytes: 12 }],
        };
      },
      cancel() {},
    },
  });
  t.after(async () => { await server.close(); });

  const record = await discoverBroker(home);
  const created = await remoteCreateTurn(record, {
    provider: "gemini",
    prompt: "run Node.js console.log('TASK_OK_' + (2+2))",
    requestId: "req-f1-f4-1",
    geminiMode: "task",
    downloadDir,
  });
  assert.equal(created.status, 202);
  const turnId = created.json.id;

  const done = await eventually(async () => {
    const res = await getTurn(record, turnId);
    return res.json.state === "completed" ? res.json : null;
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].geminiMode, "task");
  assert.equal(seen[0].downloadDir, downloadDir);
  assert.equal(done.geminiMode, "task");
  assert.deepEqual(done.downloads, [{ fileName: "sample.csv", path: path.join(downloadDir, "sample.csv"), sizeBytes: 12 }]);

  // Persisted turn record keeps both fields for the restart round-trip.
  const stored = JSON.parse(await readFile(path.join(home, "turns", "records", `${turnId}.json`), "utf8"));
  assert.equal(stored.geminiMode, "task");
  assert.equal(stored.downloadDir, downloadDir);

  // Broker restart: the completed turn restored from the result store
  // still reports the mode it ran in and its download directory.
  await server.close();
  let secondRuns = 0;
  const server2 = await startBroker({
    home,
    mode: "tray",
    runner: { run: async () => { secondRuns++; return { status: "completed", text: "must not re-run" }; }, cancel() {} },
  });
  t.after(async () => { await server2.close(); });
  const record2 = await discoverBroker(home);
  const restored = await getTurn(record2, turnId);
  assert.equal(restored.status, 200);
  assert.equal(restored.json.state, "completed");
  assert.equal(restored.json.geminiMode, "task");
  assert.equal(restored.json.downloadDir, downloadDir);
  assert.equal(secondRuns, 0);
});

test("F1+F4: POST /turns without geminiMode/downloadDir keeps the old defaults", async t => {
  const home = await tempHome();
  const seen = [];
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async (turn) => {
        seen.push({ geminiMode: turn.geminiMode, downloadDir: turn.downloadDir });
        return { status: "completed", text: "plain chat answer" };
      },
      cancel() {},
    },
  });
  t.after(async () => { await server.close(); });

  const record = await discoverBroker(home);
  const created = await remoteCreateTurn(record, {
    provider: "gemini",
    prompt: "plain chat prompt",
    requestId: "req-f1-f4-2",
  });
  assert.equal(created.status, 202);

  await eventually(async () => {
    const res = await getTurn(record, created.json.id);
    return res.json.state === "completed" ? res.json : null;
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].geminiMode, null);
  assert.equal(seen[0].downloadDir, null);
  const stored = JSON.parse(await readFile(path.join(home, "turns", "records", `${created.json.id}.json`), "utf8"));
  assert.equal(stored.geminiMode, null);
  assert.equal(stored.downloadDir, null);
});

test("F1+F4: POST /turns rejects invalid geminiMode/downloadDir instead of dropping them", async t => {
  const home = await tempHome();
  let runs = 0;
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async () => { runs++; return { status: "completed", text: "x" }; },
      cancel() {},
    },
  });
  t.after(async () => { await server.close(); });

  const record = await discoverBroker(home);
  const badMode = await remoteCreateTurn(record, {
    provider: "gemini", prompt: "hi", requestId: "req-f1-f4-bad-1", geminiMode: "deep",
  });
  assert.equal(badMode.status, 400);
  assert.equal(badMode.json.code, "INVALID_ARGUMENT");

  const badDir = await remoteCreateTurn(record, {
    provider: "chatgpt", prompt: "hi", requestId: "req-f1-f4-bad-2", downloadDir: "   ",
  });
  assert.equal(badDir.status, 400);
  assert.equal(badDir.json.code, "INVALID_ARGUMENT");
  assert.equal(runs, 0);
});

test("F1+F4: request fingerprint covers geminiMode/downloadDir (same payload replays, changed mode conflicts)", async t => {
  const home = await tempHome();
  let runs = 0;
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async () => { runs++; return { status: "completed", text: "ok" }; },
      cancel() {},
    },
  });
  t.after(async () => { await server.close(); });

  const record = await discoverBroker(home);
  const payload = {
    provider: "gemini",
    prompt: "fingerprint prompt",
    requestId: "req-f1-f4-3",
    geminiMode: "task",
    downloadDir: path.join(home, "dl"),
  };
  const first = await remoteCreateTurn(record, payload);
  assert.equal(first.status, 202);
  await eventually(async () => {
    const res = await getTurn(record, first.json.id);
    return res.json.state === "completed" ? res.json : null;
  });

  const replay = await remoteCreateTurn(record, payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  assert.equal(runs, 1);

  const conflict = await remoteCreateTurn(record, { ...payload, geminiMode: "chat" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "REQUEST_ID_CONFLICT");
  assert.equal(runs, 1);
});

test("F1+F4: `wfa broker ask` forwards --gemini-mode/--download-dir and validates them", async () => {
  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };
  const downloadDir = path.join(os.tmpdir(), "wfa-broker-f1-f4-dl");

  let captured = null;
  const deps = {
    stdout: createMockStream(),
    stderr: createMockStream(),
    ensureBroker: async () => mockRecord,
    createTurn: async (_record, payload) => {
      captured = payload;
      return { status: 202, json: { id: "turn-1", state: "queued" } };
    },
    requestId: "req-cli-1",
  };

  const res = await runBrokerCommand(
    ["ask", "--provider", "gemini", "--prompt", "run the checks",
      "--gemini-mode", "task", "--download-dir", downloadDir, "--json"],
    deps,
  );
  assert.equal(res.code, 0);
  assert.equal(captured.provider, "gemini");
  assert.equal(captured.geminiMode, "task");
  assert.equal(captured.downloadDir, downloadDir);
  assert.equal(captured.requestId, "req-cli-1");

  // Without the flags the payload omits both fields (defaults unchanged).
  captured = null;
  const resPlain = await runBrokerCommand(
    ["ask", "--provider", "gemini", "--prompt", "plain", "--json"],
    { ...deps, requestId: "req-cli-2" },
  );
  assert.equal(resPlain.code, 0);
  assert.equal(Object.hasOwn(captured, "geminiMode"), false);
  assert.equal(Object.hasOwn(captured, "downloadDir"), false);

  // --gemini-mode task is rejected for a non-Gemini provider, and an
  // unknown mode is rejected, before any turn is created.
  const stderr = createMockStream();
  const resWrongProvider = await runBrokerCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "hi", "--gemini-mode", "task"],
    { ...deps, stdout: createMockStream(), stderr },
  );
  assert.equal(resWrongProvider.code, 2);
  assert.match(stderr.output, /--gemini-mode task only applies to --provider gemini/);

  const stderr2 = createMockStream();
  const resBadMode = await runBrokerCommand(
    ["ask", "--provider", "gemini", "--prompt", "hi", "--gemini-mode", "deep"],
    { ...deps, stdout: createMockStream(), stderr: stderr2 },
  );
  assert.equal(resBadMode.code, 2);
  assert.match(stderr2.output, /Invalid --gemini-mode: deep/);
});

test("broker close waits for in-flight result persistence (slow store)", async t => {
  // Regression test for the close-before-persist race: runTurn's finally used
  // to delete the task from `active` before the persistence awaits, so
  // close() resolved while persistTurnSnapshot/persistTurnResult were still
  // in flight and a restarted broker restored the POST-time snapshot
  // (queued) with the completed result silently lost. Same slow-store
  // injection as the preserved repro (r4-flake-repro.mjs): 300 ms on
  // recordTurn/recordResult in server1 only.
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const slowTurnStore = {
    ...turnStore,
    recordTurn: async (...args) => { await delay(300); return turnStore.recordTurn(...args); },
  };
  const slowResultStore = {
    ...resultStore,
    recordResult: async (...args) => { await delay(300); return resultStore.recordResult(...args); },
  };

  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async () => ({ status: "completed", text: "TASK_OK_4" }),
      cancel() {},
    },
    deps: { turnStore: slowTurnStore, resultStore: slowResultStore },
  });
  t.after(async () => { await server.close(); });

  const record = await discoverBroker(home);
  const created = await remoteCreateTurn(record, {
    provider: "gemini",
    prompt: "run the checks",
    requestId: "req-close-persist-1",
  });
  assert.equal(created.status, 202);
  const turnId = created.json.id;

  await eventually(async () => {
    const res = await getTurn(record, turnId);
    return res.json.state === "completed" ? res.json : null;
  });

  // close() must wait for the in-flight persistence (~600 ms of injected
  // delay), not return in a few ms while the stores are still unwritten.
  const t0 = Date.now();
  await server.close();
  const closeMs = Date.now() - t0;
  assert.ok(closeMs >= 250, `close() returned in ${closeMs}ms without waiting for persistence`);

  // A restarted broker restores the completed turn, not the POST-time
  // snapshot (queued), and does not re-run it.
  let secondRuns = 0;
  const server2 = await startBroker({
    home,
    mode: "tray",
    runner: { run: async () => { secondRuns++; return { status: "completed", text: "must not re-run" }; }, cancel() {} },
  });
  t.after(async () => { await server2.close(); });
  const record2 = await discoverBroker(home);
  const restored = await getTurn(record2, turnId);
  assert.equal(restored.status, 200);
  assert.equal(restored.json.state, "completed");
  assert.equal(secondRuns, 0);
});
