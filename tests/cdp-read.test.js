import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConversation } from "../src/engines/cdp-read.js";
import * as defaultDriver from "../src/browser/driver.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { main } from "../src/cli.js";
import { runCdpTurn } from "../src/engines/cdp-engine.js";
import { launchChrome, buildChromeArgs } from "../src/browser/launch.js";
import { startBroker } from "../src/broker/server.js";
import { discoverBroker, createTurn, getTurn } from "../src/broker/client.js";
import { readResult } from "../src/broker/result-store.js";
import { createCdpRunner } from "../src/broker/runner.js";

function stream() {
  let value = "";
  return { write: (chunk) => { value += chunk; }, get output() { return value; } };
}

async function eventually(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Condition was not met before timeout");
}

function makeCdp({ targets = [] } = {}) {
  const calls = [];
  const state = {
    targets: targets.map((target) => ({ ...target })),
    calls,
    closed: false,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargets") return { targetInfos: state.targets.map((target) => ({ ...target })) };
      if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
      if (method === "Target.createTarget") {
        const targetId = `created-${state.targets.length + 1}`;
        state.targets.push({ targetId, type: "page", url: params.url || "about:blank" });
        return { targetId };
      }
      if (method === "Target.closeTarget") return { success: true };
      if (method === "Runtime.evaluate" && params.expression === "window.location.href") {
        return { result: { value: "https://chatgpt.com/c/thread-1" } };
      }
      return {};
    },
    close() { state.closed = true; },
  };
  return state;
}



test("openTab does not close a created target when attachment fails", async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Target.createTarget") return { targetId: "failed-attach-target" };
      if (method === "Target.attachToTarget") throw new Error("attach failed");
      return {};
    },
  };
  await assert.rejects(
    () => defaultDriver.openTab(cdp, "https://chatgpt.com/"),
    /attach failed/,
  );
  assert.equal(calls.some((call) => call.method === "Target.closeTarget"), false);
});

test("ensureAnchorTab creates one about:blank target and reuses it", async () => {
  const cdp = makeCdp();
  cdp.wsUrl = "ws://127.0.0.1:9222/devtools/browser/anchor-reuse";
  const first = await defaultDriver.ensureAnchorTab(cdp);
  const second = await defaultDriver.ensureAnchorTab(cdp);
  assert.equal(first.targetId, second.targetId);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(cdp.calls.filter((call) => call.method === "Target.createTarget").length, 1);
  assert.deepEqual(
    cdp.calls.find((call) => call.method === "Target.createTarget").params,
    { url: "about:blank", background: true },
  );
});


test("ensureAnchorTab adopts a remaining page target instead of creating a second anchor", async () => {
  const cdp = makeCdp();
  cdp.wsUrl = "ws://127.0.0.1:9222/devtools/browser/anchor-replaced";
  const first = await defaultDriver.ensureAnchorTab(cdp);
  cdp.targets.splice(cdp.targets.findIndex((target) => target.targetId === first.targetId), 1);
  cdp.targets.push({ targetId: "remaining-page", type: "page", url: "https://chatgpt.com/c/retained" });

  const next = await defaultDriver.ensureAnchorTab(cdp);
  assert.deepEqual(next, { targetId: "remaining-page", created: false });
  assert.equal(cdp.calls.filter((call) => call.method === "Target.createTarget").length, 1);
});

test("ensureAnchorTab reuses an existing page target without creating or navigating a tab", async () => {
  const cdp = makeCdp({
    targets: [{ targetId: "existing-page", type: "page", url: "chrome://newtab/" }],
  });
  cdp.wsUrl = "ws://127.0.0.1:9222/devtools/browser/anchor-existing";
  const result = await defaultDriver.ensureAnchorTab(cdp);
  assert.deepEqual(result, { targetId: "existing-page", created: false });
  assert.equal(cdp.calls.some((call) => call.method === "Target.createTarget"), false);
  assert.equal(cdp.calls.some((call) => call.method === "Target.activateTarget"), false);
  assert.equal(cdp.calls.some((call) => call.method === "Page.navigate"), false);
});

test("launchChrome detaches the process and unreferences the child", async () => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "wfa-launch-detached-"));
  const child = new EventEmitter();
  child.pid = 43210;
  let spawnOptions = null;
  let unrefCalled = false;
  child.unref = () => { unrefCalled = true; };

  try {
    const launched = await launchChrome({
      profileDir,
      mode: "background",
      deps: {
        resolveChromeExecutable: async () => "/fake/chrome",
        spawn: (_executable, _args, options) => {
          spawnOptions = options;
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
        queryProcess: async () => ({
          creationDate: "2026-11-25T00:00:00.000Z",
          executablePath: "/fake/chrome",
        }),
        readDevToolsActivePort: async () => ({
          port: 9222,
          wsPath: "/devtools/browser/detached-test",
        }),
        cdpProbe: async () => ({ ok: true }),
        terminateProcessAndWait: async () => {},
      },
    });
    assert.equal(launched.pid, 43210);
    assert.equal(spawnOptions.detached, true);
    assert.equal(spawnOptions.stdio, "ignore");
    assert.equal(unrefCalled, true);

    const args = buildChromeArgs({ userDataDir: profileDir, mode: "background" });
    assert.ok(args.includes("--window-size=1440,1200"));
    assert.ok(args.includes("--window-position=-2000,-2000"));
    assert.ok(!args.some((arg) => arg.startsWith("--headless")));
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
});



test("broker runner forwards runCdpTurn progress metadata to the server callback", async () => {
  const runner = createCdpRunner({
    home: "/tmp/wfa-runner-progress",
    deps: {
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 123, port: 9222 } }),
      isPidAlive: () => true,
      fetch: async () => ({ ok: true, status: 200 }),
      runCdpTurn: async (options) => {
        options.onProgress?.({
          conversationUrl: "https://chatgpt.com/c/progress",
          targetId: "target-progress",
        });
        return { status: "completed", text: "answer" };
      },
    },
  });
  let progress = null;
  const result = await runner.run({
    id: "turn-progress",
    provider: "chatgpt",
    prompt: "progress",
    mode: "background",
  }, new AbortController().signal, {
    onProgress: (patch) => { progress = patch; },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(progress, {
    conversationUrl: "https://chatgpt.com/c/progress",
    targetId: "target-progress",
  });
});

test("broker finish and result-store preserve conversationUrl and targetId", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-broker-target-metadata-"));
  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async (_turn, _signal, { onProgress }) => {
        onProgress?.({
          conversationUrl: "https://gemini.google.com/app/thread-metadata",
          targetId: "gemini-target-metadata",
        });
        return { status: "completed", text: "stored answer" };
      },
    },
  });
  try {
    const record = await discoverBroker(home);
    const created = await createTurn(record, { provider: "gemini", prompt: "metadata" });
    assert.equal(created.status, 202);

    const completed = await eventually(async () => {
      const response = await getTurn(record, created.json.id);
      return response.json?.state === "completed" ? response.json : null;
    });
    assert.equal(completed.conversationUrl, "https://gemini.google.com/app/thread-metadata");
    assert.equal(completed.targetId, "gemini-target-metadata");

    const persisted = await eventually(() => readResult(home, created.json.id));
    assert.equal(persisted.conversationUrl, "https://gemini.google.com/app/thread-metadata");
    assert.equal(persisted.targetId, "gemini-target-metadata");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});



test("production source contains no Runtime domain enable command", async () => {
  const source = await readFile(new URL("../src/browser/driver.js", import.meta.url), "utf8");
  assert.equal(source.includes("Runtime.enable"), false);
});

test("driver keeps every pre-existing public export and adds the read helpers", () => {
  const required = [
    "openTab", "waitForEditor", "normalizePromptText", "foldEditorLines",
    "isPromptTextMatch", "typePrompt", "attachFiles", "submitTurn",
    "readTurnState", "waitForCompletion", "classifyRunError",
  ];
  for (const name of required) assert.equal(typeof defaultDriver[name], "function", `${name} export missing`);
  for (const name of ["listPageTargets", "ensureAnchorTab", "attachTab"]) {
    assert.equal(typeof defaultDriver[name], "function", `${name} export missing`);
  }
});

test("web-first Skill stays within 120 lines and preserves the required state contract", async () => {
  const content = await readFile(new URL("../skills/web-first/SKILL.md", import.meta.url), "utf8");
  assert.ok(content.split(/\r?\n/).length <= 120);
  for (const phrase of [
    "wfa send", "wfa read --task-id", "wfa cdp ask",
    "`completed`", "`stalled`", "`unconfirmed`", "`needs_user`",
    "`tab_missing`", "`failed`", "`needs_human`",
    "must not answer the delegated question itself",
  ]) {
    assert.ok(content.includes(phrase), `Skill is missing ${phrase}`);
  }
});

test("read CLI forwards wait/timeout/no-reopen and writes captured text to --out", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-read-out-"));
  const outPath = path.join(home, "answer.txt");
  const stdout = stream();
  let captured = null;
  try {
    const result = await runCdpCommand([
      "read", "--url", "https://gemini.google.com/app/thread-out",
      "--timeout", "9", "--wait", "2", "--no-reopen", "--out", outPath, "--json",
    ], {
      home,
      stdout,
      stderr: stream(),
      readConversation: async (options) => {
        captured = options;
        return {
          status: "unconfirmed",
          provider: "gemini",
          conversationUrl: options.url,
          text: "partial text",
        };
      },
    });

    assert.equal(result.code, 0);
    assert.equal(captured.timeoutMs, 9000);
    assert.equal(captured.wait, 2000);
    assert.equal(captured.noReopen, true);
    assert.equal(await readFile(outPath, "utf8"), "partial text");
    assert.equal(JSON.parse(stdout.output).out, outPath);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("read --wait expiry returns the latest state and text as an observation, not an error", async () => {
  const cdp = makeCdp({
    targets: [{ targetId: "target-wait", type: "page", url: "https://chatgpt.com/c/wait" }],
  });
  let virtualTime = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-test",
    url: "https://chatgpt.com/c/wait",
    wait: 1000,
    deps: {
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "target-wait", sessionId: "session-wait" }),
        readTurnState: async () => ({
          userTurns: 1,
          answerTurns: 1,
          answerText: "still partial",
          answerActionsVisible: false,
          stopVisible: true,
        }),
      },
    },
  });
  assert.equal(result.status, "streaming");
  assert.equal(result.text, "still partial");
  assert.equal(result.elapsedMs, 1000);
});


test("readConversation maps queued, running, stalled, needs_human, and failed task states", async () => {
  const cases = [
    ["queued", "pending"],
    ["running", "thinking"],
    ["stalled", "stalled"],
    ["needs_human", "needs_user"],
    ["failed", "unconfirmed"],
  ];
  for (const [taskState, expected] of cases) {
    const result = await readConversation({
      home: "/tmp/wfa-read-state-map",
      taskId: `turn-${taskState}`,
      deps: {
        resultStore: {
          readResult: async () => ({
            turnId: `turn-${taskState}`,
            provider: "chatgpt",
            state: taskState,
            text: "",
          }),
        },
        discoverBroker: async () => null,
      },
    });
    assert.equal(result.status, expected, taskState);
  }
});

test("readConversation returns a completed persisted result without starting or connecting Chrome", async () => {
  let recoveryCalls = 0;
  let connectCalls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-test",
    taskId: "turn-complete",
    deps: {
      resultStore: {
        readResult: async () => ({
          turnId: "turn-complete",
          provider: "chatgpt",
          state: "completed",
          text: "Persisted final answer",
          conversationUrl: "https://chatgpt.com/c/thread-1",
          targetId: "target-1",
        }),
      },
      recoverBrowser: async () => { recoveryCalls++; throw new Error("must not recover"); },
      connectCdp: async () => { connectCalls++; throw new Error("must not connect"); },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, "Persisted final answer");
  assert.equal(result.source, "result-store");
  assert.equal(recoveryCalls, 0);
  assert.equal(connectCalls, 0);
});

test("readConversation resolves task metadata from broker and reads the matching target", async () => {
  const cdp = makeCdp({
    targets: [{ targetId: "target-task", type: "page", url: "https://chatgpt.com/c/thread-1/?from=tab" }],
  });
  const attached = [];
  const result = await readConversation({
    home: "/tmp/wfa-read-test",
    taskId: "turn-running",
    deps: {
      resultStore: { readResult: async () => null },
      discoverBroker: async () => ({ host: "127.0.0.1", port: 1234, token: "token" }),
      getTurn: async () => ({
        status: 200,
        json: {
          id: "turn-running",
          provider: "chatgpt",
          state: "running",
          conversationUrl: "https://chatgpt.com/c/thread-1",
          targetId: "target-task",
        },
      }),
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async (_cdp, targetId) => {
          attached.push(targetId);
          return { targetId, sessionId: `session-${targetId}` };
        },
        readTurnState: async () => ({
          userTurns: 1,
          answerTurns: 1,
          answerText: "Final answer from current turn",
          answerActionsVisible: true,
          stopVisible: false,
          hasChallenge: false,
          loggedOut: false,
          pageError: null,
        }),
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, "Final answer from current turn");
  assert.equal(result.targetId, "target-task");
  assert.deepEqual(attached, ["target-task"]);
  assert.equal(cdp.calls.some((call) => call.method === "Target.closeTarget"), false);
  assert.equal(cdp.calls.some((call) => call.method === "Runtime.enable"), false);
  assert.equal(cdp.closed, true);
});


test("readConversation falls back to normalized URL matching when targetId is unavailable", async () => {
  const cdp = makeCdp({
    targets: [{ targetId: "url-matched", type: "page", url: "https://gemini.google.com/app/thread-url/?tracking=1" }],
  });
  let attached = null;
  const result = await readConversation({
    home: "/tmp/wfa-read-url-match",
    taskId: "turn-url-match",
    deps: {
      resultStore: { readResult: async () => null },
      discoverBroker: async () => ({ host: "127.0.0.1", port: 1234, token: "token" }),
      getTurn: async () => ({
        status: 200,
        json: {
          id: "turn-url-match",
          provider: "gemini",
          state: "running",
          conversationUrl: "https://gemini.google.com/app/thread-url",
        },
      }),
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async (_cdp, targetId) => {
          attached = targetId;
          return { targetId, sessionId: "url-match-session" };
        },
        readTurnState: async () => ({
          userTurns: 1,
          answerTurns: 1,
          answerText: "Gemini final answer",
          answerActionsVisible: true,
          stopVisible: false,
        }),
      },
    },
  });
  assert.equal(attached, "url-matched");
  assert.equal(result.status, "completed");
  assert.equal(result.targetId, "url-matched");
});

test("readConversation --no-reopen reports SESSION_TAB_MISSING and does not open or close a tab", async () => {
  const cdp = makeCdp();
  let openCalls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-test",
    taskId: "turn-missing",
    noReopen: true,
    deps: {
      resultStore: {
        readResult: async () => ({
          turnId: "turn-missing",
          provider: "chatgpt",
          state: "running",
          conversationUrl: "https://chatgpt.com/c/missing",
          targetId: "gone-target",
        }),
      },
      discoverBroker: async () => null,
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: defaultDriver.listPageTargets,
        openTab: async () => { openCalls++; return { targetId: "new", sessionId: "new-session" }; },
      },
    },
  });

  assert.equal(result.status, "tab_missing");
  assert.equal(result.reason, "SESSION_TAB_MISSING");
  assert.equal(openCalls, 0);
  assert.equal(cdp.calls.some((call) => call.method === "Target.closeTarget"), false);
});

test("readConversation opens a missing URL exactly once and never closes the read tab", async () => {
  const cdp = makeCdp();
  let openCalls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-test",
    url: "https://chatgpt.com/c/thread-1",
    deps: {
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: defaultDriver.listPageTargets,
        openTab: async (_cdp, url) => {
          openCalls++;
          assert.equal(url, "https://chatgpt.com/c/thread-1");
          return { targetId: "opened-read-tab", sessionId: "opened-session" };
        },
        readTurnState: async () => ({
          userTurns: 1,
          answerTurns: 1,
          answerText: "Partial text",
          answerActionsVisible: false,
          stopVisible: false,
        }),
      },
    },
  });

  assert.equal(result.status, "streaming");
  assert.equal(result.text, "Partial text");
  assert.equal(openCalls, 1);
  assert.equal(cdp.calls.some((call) => call.method === "Target.closeTarget"), false);
});

test("readConversation never marks text completed without answerActionsVisible true", async () => {
  const cdp = makeCdp({
    targets: [{ targetId: "target-unknown", type: "page", url: "https://chatgpt.com/c/thread-unknown" }],
  });
  const result = await readConversation({
    home: "/tmp/wfa-read-test",
    url: "https://chatgpt.com/c/thread-unknown",
    deps: {
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "target-unknown", sessionId: "session-unknown" }),
        readTurnState: async () => ({
          userTurns: 1,
          answerTurns: 1,
          answerText: "Possible answer, but completion is not confirmed",
          answerActionsVisible: null,
          stopVisible: false,
        }),
      },
    },
  });

  assert.equal(result.status, "unconfirmed");
  assert.notEqual(result.status, "completed");
  assert.match(result.reason, /completion_signal_unknown/);
});

test("readConversation maps login and challenge states to needs_user", async () => {
  for (const pageState of [
    { loggedOut: true },
    { hasChallenge: true },
  ]) {
    const cdp = makeCdp({
      targets: [{ targetId: "target-needs-user", type: "page", url: "https://chatgpt.com/c/thread-user" }],
    });
    const result = await readConversation({
      home: "/tmp/wfa-read-test",
      url: "https://chatgpt.com/c/thread-user",
      deps: {
        recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
        connectCdp: async () => cdp,
        driver: {
          listPageTargets: defaultDriver.listPageTargets,
          attachTab: async () => ({ targetId: "target-needs-user", sessionId: "session-needs-user" }),
          readTurnState: async () => ({
            userTurns: 0, answerTurns: 0, answerText: "", answerActionsVisible: null,
            stopVisible: false, ...pageState,
          }),
        },
      },
    });
    assert.equal(result.status, "needs_user");
  }
});

test("runCdpTurn creates and retains an anchor and closes only a completed one-shot work tab", async () => {
  const closeTargets = [];
  const methods = [];
  const cdp = {
    wsUrl: "ws://127.0.0.1:9222/devtools/browser/lifecycle-anchor",
    targets: [],
    async send(method, params = {}) {
      methods.push(method);
      if (method === "Target.getTargets") return { targetInfos: this.targets.map((target) => ({ ...target })) };
      if (method === "Target.createTarget") {
        const targetId = "anchor-target";
        this.targets.push({ targetId, type: "page", url: "about:blank" });
        return { targetId };
      }
      if (method === "Target.closeTarget") {
        closeTargets.push(params.targetId);
        return { success: true };
      }
      if (method === "Runtime.evaluate" && params.expression === "window.location.href") {
        return { result: { value: "https://chatgpt.com/c/one-shot" } };
      }
      return {};
    },
    close() {},
  };
  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "test lifecycle",
    mode: "background",
    minIntervalMs: 0,
    deps: {
      skipTurnLock: true,
      enforceCooldown: async () => {},
      recordLastTurn: async () => {},
      withSendSlot: async (_provider, fn) => fn(),
      pace: async () => {},
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 123, port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        ...defaultDriver,
        openTab: async () => ({ targetId: "work-target", sessionId: "work-session" }),
        waitForEditor: async () => true,
        readTurnState: async () => ({
          userTurns: 0, answerTurns: 0, answerText: "", answerActionsVisible: false,
          stopVisible: false, editorEmpty: true, loggedOut: false, pageError: null,
        }),
        typePrompt: async () => ({ typedChars: 13, replacedChars: 0 }),
        submitTurn: async () => ({ submittedAt: Date.now() }),
        waitForCompletion: async () => ({
          status: "completed", reason: "completed", text: "Final answer", evidence: {},
        }),
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.targetId, "work-target");
  assert.equal(result.conversationUrl, "https://chatgpt.com/c/one-shot");
  assert.deepEqual(closeTargets, ["work-target"]);
  assert.ok(cdp.targets.some((target) => target.targetId === "anchor-target"));
  assert.equal(closeTargets.includes("anchor-target"), false);
  assert.equal(cdp.targets.some((target) => target.targetId === "work-target"), false);
  assert.equal(methods.includes("Browser.close"), false);
});

test("runCdpTurn retains work tabs for non-completed, empty, resumed, and keepBrowser turns", async () => {
  const cases = [
    { name: "needs_human", completion: { status: "needs_human", text: "", reason: "login_required" } },
    { name: "stalled", completion: { status: "stalled", text: "partial", reason: "no_progress" } },
    { name: "failed", completion: { status: "failed", text: "", reason: "provider_error" } },
    { name: "empty completed", completion: { status: "completed", text: "   ", reason: "completed" } },
    { name: "keepBrowser", completion: { status: "completed", text: "answer", reason: "completed" }, keepBrowser: true },
    { name: "resumed", completion: { status: "completed", text: "answer", reason: "completed" }, conversationId: "logical-thread" },
  ];

  for (const item of cases) {
    const closeTargets = [];
    const cdp = {
      wsUrl: `ws://127.0.0.1:9222/devtools/browser/lifecycle-${item.name.replace(/\s/g, "-")}`,
      targets: [],
      async send(method, params = {}) {
        if (method === "Target.getTargets") return { targetInfos: this.targets.map((target) => ({ ...target })) };
        if (method === "Target.createTarget") {
          this.targets.push({ targetId: "anchor", type: "page", url: "about:blank" });
          return { targetId: "anchor" };
        }
        if (method === "Target.closeTarget") { closeTargets.push(params.targetId); return { success: true }; }
        if (method === "Runtime.evaluate" && params.expression === "window.location.href") {
          return { result: { value: "https://chatgpt.com/c/lifecycle" } };
        }
        return {};
      },
      close() {},
    };
    const result = await runCdpTurn({
      provider: "chatgpt",
      prompt: "test lifecycle",
      mode: "background",
      minIntervalMs: 0,
      ...(item.keepBrowser ? { keepBrowser: true } : {}),
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      deps: {
        skipTurnLock: true,
        enforceCooldown: async () => {},
        recordLastTurn: async () => {},
        withSendSlot: async (_provider, fn) => fn(),
        pace: async () => {},
        conversationStore: {
          loadSession: async () => null,
          saveSession: async () => {},
          markInvalid: async () => {},
        },
        recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 123, port: 9222 } }),
        connectCdp: async () => cdp,
        driver: {
          ...defaultDriver,
          openTab: async () => ({ targetId: "work", sessionId: "work-session" }),
          waitForEditor: async () => true,
          readTurnState: async () => ({
            userTurns: 0, answerTurns: 0, answerText: "", answerActionsVisible: false,
            stopVisible: false, editorEmpty: true, loggedOut: false, pageError: null,
          }),
          typePrompt: async () => ({ typedChars: 13, replacedChars: 0 }),
          submitTurn: async () => ({ submittedAt: Date.now() }),
          waitForCompletion: async () => item.completion,
        },
      },
    });

    assert.equal(result.status, item.completion.status, item.name);
    assert.deepEqual(closeTargets, [], `${item.name} must retain its work tab`);
    assert.ok(cdp.targets.some((target) => target.targetId === "anchor"));
  }
});

test("wfa cdp ask --no-wait waits for sendCommittedAt before returning five fields", async () => {
  const stdout = stream();
  const stderr = stream();
  let waitCalls = 0;
  let submissionCalls = 0;
  let stageCalls = 0;

  const result = await runCdpCommand([
    "ask", "--provider", "chatgpt", "--prompt", "send once", "--request-id", "req-no-wait", "--no-wait", "--json",
  ], {
    stdout, stderr,
    ensureBroker: async () => ({ host: "127.0.0.1", port: 43210, token: "test" }),
    createTurn: async (_record, payload) => {
      assert.equal(payload.requestId, "req-no-wait");
      return { status: 202, json: { id: "turn-no-wait", requestId: "req-no-wait", state: "queued" } };
    },
    waitForSubmission: async ({ turnId }) => {
      submissionCalls++;
      return {
        id: turnId,
        state: "running",
        sendCommittedAt: 123,
      };
    },
    waitForTurn: async () => { waitCalls++; throw new Error("waitForTurn must not be called"); },
    stageCdpResponse: async () => { stageCalls++; throw new Error("staging must not be called"); },
  });

  assert.equal(result.code, 0);
  assert.deepEqual(result.result, {
    id: "turn-no-wait",
    requestId: "req-no-wait",
    state: "running",
    poll: "wfa read --task-id turn-no-wait",
    provider: "chatgpt",
  });
  assert.deepEqual(Object.keys(JSON.parse(stdout.output)), ["id", "requestId", "state", "poll", "provider"]);
  assert.equal(submissionCalls, 1);
  assert.equal(waitCalls, 0);
  assert.equal(stageCalls, 0);
  assert.equal(stderr.output, "");
});

test("wfa cdp ask --no-wait accepts idempotent HTTP 200 after confirming sendCommittedAt", async () => {
  const stdout = stream();
  const result = await runCdpCommand([
    "ask", "--provider", "gemini", "--prompt", "same request", "--request-id", "same-id", "--no-wait", "--json",
  ], {
    stdout,
    ensureBroker: async () => ({ host: "127.0.0.1", port: 43210, token: "test" }),
    createTurn: async () => ({
      status: 200,
      json: { id: "existing-turn", requestId: "same-id", state: "running" },
    }),
    waitForSubmission: async () => ({
      id: "existing-turn",
      state: "running",
      sendCommittedAt: 123,
    }),
    waitForTurn: async () => { throw new Error("must not wait"); },
  });

  assert.equal(result.code, 0);
  assert.equal(result.result.id, "existing-turn");
  assert.equal(result.result.state, "running");
  assert.equal(result.result.provider, "gemini");
});

test("top-level wfa send aliases cdp ask --no-wait and top-level read aliases cdp read", async () => {
  const sendOut = stream();
  const sendCode = await main([
    "send", "--provider", "chatgpt", "--prompt", "top level", "--json",
  ], {
    stdout: sendOut,
    stderr: stream(),
    home: "/tmp/wfa-top-send",
    ensureBroker: async () => ({ host: "127.0.0.1", port: 43210, token: "test" }),
    createTurn: async () => ({ status: 202, json: { id: "top-turn", state: "queued" } }),
    waitForSubmission: async () => ({
      id: "top-turn",
      state: "running",
      sendCommittedAt: 123,
    }),
    waitForTurn: async () => { throw new Error("send alias must not wait"); },
  });
  assert.equal(sendCode, 0);
  assert.equal(JSON.parse(sendOut.output).id, "top-turn");

  const readOut = stream();
  const readCode = await main(["read", "--url", "https://chatgpt.com/c/top", "--json"], {
    stdout: readOut,
    stderr: stream(),
    readConversation: async (options) => ({
      status: "unconfirmed",
      provider: "chatgpt",
      conversationUrl: options.url,
      text: "partial",
    }),
  });
  assert.equal(readCode, 0);
  assert.equal(JSON.parse(readOut.output).status, "unconfirmed");
});
