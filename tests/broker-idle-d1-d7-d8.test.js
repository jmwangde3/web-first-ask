import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startBroker } from "../src/broker/server.js";
import {
  discoverBroker,
  createTurn as remoteCreateTurn,
  getTurn,
  cancelTurn,
  diagnoseBrokerUnreachable,
} from "../src/broker/client.js";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import {
  activateTab,
  challengePatternFor,
  isChallengedState,
  parkChallengedTab,
  readTurnState,
  waitForCompletion,
  waitForEditor,
} from "../src/browser/driver.js";

const tempHome = () => mkdtemp(path.join(os.tmpdir(), "wfa-idle-d1-d7-d8-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(fn, limitMs = 5000) {
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
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------- D1

test("D1: a non-terminal running turn keeps an off-mode broker alive past the idle threshold", async (t) => {
  const home = await tempHome();
  const gate = deferred();
  let server;
  t.after(async () => {
    await server?.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  server = await startBroker({
    home,
    mode: "off",
    idleTimeoutMs: 200,
    idleGraceMs: 100,
    runner: {
      run: async () => {
        await gate.promise;
        return { status: "completed", text: "done" };
      },
    },
  });
  const record = { host: "127.0.0.1", port: server.port, token: server.token };
  const created = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "d1 running turn" });
  assert.equal(created.status, 202);
  const turnId = created.json.id;

  // Past the 200 ms idle threshold with the turn still running: the broker
  // must still be alive and the turn still readable.
  await delay(500);
  assert.notEqual(await discoverBroker(home), null, "broker must not idle out while a turn is running");
  const running = await getTurn(record, turnId);
  assert.equal(running.status, 200);
  assert.equal(running.json.state, "running");

  // Let the turn finish. The broker must NOT die the moment the turn
  // terminalizes (grace period), but must idle out shortly afterwards.
  gate.resolve();
  await eventually(async () => {
    const res = await getTurn(record, turnId).catch(() => null);
    return res?.status === 200 && res.json.state === "completed" ? res : null;
  });
  assert.notEqual(await discoverBroker(home), null, "broker must survive the grace period after the last turn completes");
  await eventually(async () => (await discoverBroker(home)) === null);
});

test("D1: a broker owning only terminal turns still idles out", async (t) => {
  const home = await tempHome();
  let server;
  t.after(async () => {
    await server?.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  server = await startBroker({
    home,
    mode: "off",
    idleTimeoutMs: 50,
    idleGraceMs: 20,
    runner: { run: async () => ({ status: "completed", text: "done" }) },
  });
  const record = { host: "127.0.0.1", port: server.port, token: server.token };
  const created = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "d1 terminal turn" });
  assert.equal(created.status, 202);
  await eventually(async () => {
    const res = await getTurn(record, created.json.id).catch(() => null);
    return res?.status === 200 && res.json.state === "completed" ? res : null;
  });
  await eventually(async () => (await discoverBroker(home)) === null);
});

test("D1: a needs_human turn pins the broker; cancelling it to terminal lets the broker idle out", async (t) => {
  const home = await tempHome();
  let server;
  t.after(async () => {
    await server?.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  server = await startBroker({
    home,
    mode: "off",
    idleTimeoutMs: 60,
    idleGraceMs: 20,
    runner: { run: async () => ({ status: "needs_human", reason: "human_verification_required" }) },
  });
  const record = { host: "127.0.0.1", port: server.port, token: server.token };
  const created = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "d1 challenged turn" });
  assert.equal(created.status, 202);
  const turnId = created.json.id;

  await eventually(async () => {
    const res = await getTurn(record, turnId).catch(() => null);
    return res?.status === 200 && res.json.state === "needs_human" ? res : null;
  });
  // needs_human is non-terminal: past the idle threshold the broker must
  // still own the turn instead of idling out.
  await delay(250);
  assert.notEqual(await discoverBroker(home), null, "broker must not idle out while it owns a needs_human turn");

  const cancelled = await cancelTurn(record, turnId);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.state, "failed");
  await eventually(async () => (await discoverBroker(home)) === null);
});

// ---------------------------------------------------------------- D7

function challengedStateCdp(calls, { navigateFails = false } = {}) {
  return {
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 0,
              answerTurns: 0,
              answerText: "",
              title: "请稍候…",
              hasChallenge: true,
              editorEmpty: null,
              hasProseMirror: false,
              loggedOut: false,
            }),
          },
        };
      }
      if (method === "Page.navigate") {
        if (navigateFails) throw new Error("navigate boom");
        return {};
      }
      return {};
    },
  };
}

test("D7: readTurnState parks a challenged tab on about:blank and reports parked", async () => {
  const calls = [];
  const cdp = challengedStateCdp(calls);
  const state = await readTurnState(cdp, "session-1", chatgptAdapter);
  assert.equal(state.hasChallenge, true);
  assert.equal(state.parked, true);
  // The challenged state is still reported (not the blank page's state).
  assert.equal(state.title, "请稍候…");
  const navigate = calls.find((call) => call.method === "Page.navigate");
  assert.ok(navigate, "challenged tab must be navigated away");
  assert.deepEqual(navigate.params, { url: "about:blank" });
  assert.equal(navigate.sessionId, "session-1");
  assert.ok(
    calls.findIndex((call) => call.method === "Runtime.evaluate") <
      calls.findIndex((call) => call.method === "Page.navigate"),
    "park happens after the challenged state is read",
  );
  assert.equal(calls.some((call) => call.method === "Page.bringToFront"), false);
});

test("D7: readTurnState does not park a normal page", async () => {
  const calls = [];
  const cdp = {
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "hi",
              title: "ChatGPT",
              hasChallenge: false,
              editorEmpty: true,
              hasProseMirror: true,
              loggedOut: false,
            }),
          },
        };
      }
      return {};
    },
  };
  const state = await readTurnState(cdp, "session-1", chatgptAdapter);
  assert.equal(state.parked, false);
  assert.equal(calls.some((call) => call.method === "Page.navigate"), false);
});

test("D7: a failed park does not hide the challenged state", async () => {
  const calls = [];
  const cdp = challengedStateCdp(calls, { navigateFails: true });
  const state = await readTurnState(cdp, "session-1", chatgptAdapter);
  assert.equal(state.hasChallenge, true);
  assert.equal(state.parked, false);
});

test("D7: waitForCompletion parks the challenged tab once and reports human_verification_required", async () => {
  const calls = [];
  const cdp = challengedStateCdp(calls);
  const res = await waitForCompletion(cdp, "session-1", chatgptAdapter, {
    pollIntervalMs: 50,
    hardTimeoutMs: 5000,
  });
  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "human_verification_required");
  assert.equal(res.parked, true);
  assert.equal(res.evidence.parked, true);
  assert.equal(
    calls.filter((call) => call.method === "Page.navigate").length,
    1,
    "readTurnState parks; waitForCompletion must not navigate a second time",
  );
});

test("D7: waitForEditor parks before throwing HUMAN_VERIFICATION_REQUIRED", async () => {
  const calls = [];
  const mockCdp = {
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: { found: false, title: "请稍候…", bodyLength: 0, hasPassword: false },
          },
        };
      }
      return {};
    },
  };
  await assert.rejects(
    waitForEditor(mockCdp, "session-1", chatgptAdapter, {
      timeoutMs: 60000,
      pollIntervalMs: 50,
      sleep: async () => {},
    }),
    (err) => {
      assert.equal(err.code, "HUMAN_VERIFICATION_REQUIRED");
      assert.equal(err.details?.challenge, true);
      assert.equal(err.details?.parked, true);
      assert.equal(err.title, "请稍候…");
      return true;
    },
  );
  const navigate = calls.find((call) => call.method === "Page.navigate");
  assert.ok(navigate);
  assert.deepEqual(navigate.params, { url: "about:blank" });
  assert.equal(navigate.sessionId, "session-1");
});

test("D7: challenge detection reuses the adapter pattern (no second detector)", () => {
  // The driver must use the adapter's own turnChallengeTitlePattern.
  assert.equal(challengePatternFor(chatgptAdapter), chatgptAdapter.turnChallengeTitlePattern);
  assert.equal(isChallengedState({ hasChallenge: true, editorEmpty: null }, chatgptAdapter), true);
  assert.equal(
    isChallengedState({ hasChallenge: false, title: "请稍候…", editorEmpty: null }, chatgptAdapter),
    true,
    "title match alone is a challenge",
  );
  assert.equal(
    isChallengedState({ hasChallenge: true, editorEmpty: true }, chatgptAdapter),
    false,
    "a usable composer means the page is not challenged",
  );
  assert.equal(isChallengedState({ hasChallenge: false, title: "ChatGPT", editorEmpty: true }, chatgptAdapter), false);
});

test("D7: parkChallengedTab is best-effort and validates its arguments", async () => {
  const cdp = { send: async () => ({}) };
  assert.deepEqual(await parkChallengedTab(cdp, "session-1"), { parked: true, url: "about:blank" });
  const failing = { send: async () => { throw new Error("boom"); } };
  assert.deepEqual(await parkChallengedTab(failing, "session-1"), { parked: false, reason: "navigate_failed" });
  assert.deepEqual(await parkChallengedTab(cdp, ""), { parked: false, reason: "invalid_args" });
  assert.deepEqual(await parkChallengedTab(null, "session-1"), { parked: false, reason: "invalid_args" });
});

// ---------------------------------------------------------------- D8

function stateCdp(calls, state, { activateFails = false } = {}) {
  return {
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === "Target.activateTarget") {
        if (activateFails) throw new Error("activate boom");
        return {};
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: JSON.stringify(state) } };
      }
      return {};
    },
    close() {},
  };
}

const normalState = {
  userTurns: 1,
  answerTurns: 1,
  answerText: "hello",
  answerActionsVisible: true,
  stopVisible: false,
  editorEmpty: true,
  title: "ChatGPT",
  hasChallenge: false,
  hasProseMirror: true,
  loggedOut: false,
};

test("D8: readTurnState activates the tab before reading when targetId is given", async () => {
  const calls = [];
  const cdp = stateCdp(calls, normalState);
  const state = await readTurnState(cdp, "session-1", chatgptAdapter, { targetId: "target-9" });
  assert.equal(state.answerText, "hello");
  assert.equal(state.parked, false);
  const activate = calls.find((call) => call.method === "Target.activateTarget");
  assert.ok(activate, "tab must be activated before the read");
  assert.deepEqual(activate.params, { targetId: "target-9" });
  assert.equal(activate.sessionId, undefined, "Target.activateTarget is browser-scoped, not session-scoped");
  assert.ok(
    calls.findIndex((call) => call.method === "Target.activateTarget") <
      calls.findIndex((call) => call.method === "Runtime.evaluate"),
    "activation must precede the evaluate",
  );
  assert.equal(calls.some((call) => call.method === "Page.bringToFront"), false);
});

test("D8: readTurnState without targetId does not activate anything", async () => {
  const calls = [];
  const cdp = stateCdp(calls, normalState);
  await readTurnState(cdp, "session-1", chatgptAdapter);
  assert.equal(calls.some((call) => call.method === "Target.activateTarget"), false);
});

test("D8: a failed tab activation does not fail the read", async () => {
  const calls = [];
  const cdp = stateCdp(calls, normalState, { activateFails: true });
  const state = await readTurnState(cdp, "session-1", chatgptAdapter, { targetId: "target-9" });
  assert.equal(state.answerText, "hello");
});

test("D8: activateTab validates its arguments", async () => {
  const cdp = { send: async () => ({}) };
  assert.deepEqual(await activateTab(cdp, "target-1"), { targetId: "target-1", activated: true });
  await assert.rejects(activateTab(cdp, ""), (err) => err.code === "TARGET_ID_REQUIRED");
  await assert.rejects(activateTab(null, "target-1"), (err) => err.code === "CDP_REQUIRED");
});

test("D8: waitForCompletion activates the tab exactly once, before the first read", async () => {
  let virtualTime = 0;
  const calls = [];
  const cdp = stateCdp(calls, normalState);
  const res = await waitForCompletion(cdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 0,
    pollIntervalMs: 100,
    targetId: "target-8",
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });
  assert.equal(res.status, "completed");
  assert.equal(calls.filter((call) => call.method === "Target.activateTarget").length, 1);
  assert.ok(
    calls.findIndex((call) => call.method === "Target.activateTarget") <
      calls.findIndex((call) => call.method === "Runtime.evaluate"),
  );

  const calls2 = [];
  const cdp2 = stateCdp(calls2, normalState);
  await waitForCompletion(cdp2, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 0,
    pollIntervalMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });
  assert.equal(calls2.some((call) => call.method === "Target.activateTarget"), false);
});

test("D8: broker live-page probe passes the targetId to the read so the tab is activated", async () => {
  const readArgs = [];
  const mockDriver = {
    listPageTargets: async () => [
      { targetId: "target-7", url: "https://chatgpt.com/c/abc", type: "page" },
    ],
    attachTab: async () => ({ sessionId: "sess-7" }),
    readTurnState: async (...args) => {
      readArgs.push(args);
      return {
        answerText: "hi",
        answerActionsVisible: true,
        pendingCount: 0,
        stopVisible: false,
        editorEmpty: true,
      };
    },
  };
  const turnRecord = {
    provider: "chatgpt",
    conversationUrl: "https://chatgpt.com/c/abc",
    targetId: "target-7",
    state: "running",
    sendCommittedAt: "2026-01-01T00:00:00.000Z",
  };
  const diag = await diagnoseBrokerUnreachable({
    home: await tempHome(),
    turnId: "turn-7",
    deps: {
      readCommit: async () => null,
      readTurn: async () => turnRecord,
      readResult: async () => null,
      chromePort: 9222,
      connectCdp: async () => ({ close() {} }),
      driver: mockDriver,
    },
  });
  assert.equal(diag.submissionState, "committed");
  assert.equal(diag.safeToResend, false);
  assert.equal(diag.livePage?.targetId, "target-7");
  assert.equal(readArgs.length, 1);
  assert.deepEqual(readArgs[0][3], { targetId: "target-7" });
});
