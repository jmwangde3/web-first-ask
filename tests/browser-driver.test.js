import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { cdpVersion, connectCdp, findDevToolsPort } from "../src/browser/cdp.js";
import {
  classifyRunError,
  openTab,
  readTurnState,
  submitTurn,
  typePrompt,
  waitForCompletion,
  waitForEditor,
} from "../src/browser/driver.js";

class MockWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1; // OPEN
    this.sentMessages = [];
  }

  send(data) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  simulateMessage(msgObj) {
    this.emit("message", { data: JSON.stringify(msgObj) });
  }

  simulateError(err) {
    this.emit("error", err);
  }
}

test("connectCdp: rejects with CDP_TIMEOUT on mismatched response id and CDP_CLOSED on socket drop", async () => {
  let createdWs = null;
  const mockFactory = class extends MockWebSocket {
    constructor(url) {
      super(url);
      createdWs = this;
    }
  };

  const client = await connectCdp("ws://127.0.0.1:9222/devtools/browser/test", {
    wsClass: mockFactory,
    sendTimeoutMs: 100,
  });

  // 1. Mismatched response ID should NOT resolve the command, and it should timeout
  const cmdPromise = client.send("Page.enable", {}, undefined, { timeoutMs: 60 });
  // Send mismatched id 999
  createdWs.simulateMessage({ id: 999, result: {} });

  await assert.rejects(
    cmdPromise,
    (err) => err.code === "CDP_TIMEOUT",
    "Should reject with CDP_TIMEOUT when mismatched id is received"
  );

  // 2. Pending commands reject with CDP_CLOSED when connection drops
  const pendingPromise1 = client.send("Runtime.enable");
  const pendingPromise2 = client.send("Target.getTargets");

  createdWs.close();

  await assert.rejects(
    pendingPromise1,
    (err) => err.code === "CDP_CLOSED",
    "Pending promise 1 should reject with CDP_CLOSED on socket close"
  );
  await assert.rejects(
    pendingPromise2,
    (err) => err.code === "CDP_CLOSED",
    "Pending promise 2 should reject with CDP_CLOSED on socket close"
  );

  // 3. New commands after close should immediately reject with CDP_CLOSED
  await assert.rejects(
    client.send("Page.navigate", { url: "about:blank" }),
    (err) => err.code === "CDP_CLOSED",
    "Subsequent send should reject with CDP_CLOSED"
  );
});

test("waitForEditor: throws EDITOR_NOT_FOUND with document.title on timeout", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method, params, sessionId) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              found: false,
              title: "ChatGPT - Service Unavailable",
            },
          },
        };
      }
      return {};
    },
  };

  await assert.rejects(
    waitForEditor(mockCdp, "session-1", chatgptAdapter, {
      timeoutMs: 1000,
      pollIntervalMs: 200,
      now: () => virtualTime,
      sleep: async (ms) => {
        virtualTime += ms;
      },
    }),
    (err) => {
      assert.equal(err.code, "EDITOR_NOT_FOUND");
      assert.match(err.message, /ChatGPT - Service Unavailable/);
      assert.equal(err.title, "ChatGPT - Service Unavailable");
      return true;
    }
  );
});

test("waitForEditor: returns true when editor is found before timeout", async () => {
  let virtualTime = 0;
  let calls = 0;
  const mockCdp = {
    send: async (method, params, sessionId) => {
      if (method === "Runtime.evaluate") {
        calls++;
        return {
          result: {
            value: {
              found: calls >= 2,
              title: "ChatGPT",
            },
          },
        };
      }
      return {};
    },
  };

  const result = await waitForEditor(mockCdp, "session-1", chatgptAdapter, {
    timeoutMs: 1000,
    pollIntervalMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(result, true);
  assert.equal(calls, 2);
});

test("typePrompt: throws PROMPT_NOT_TYPED on empty string and types successfully otherwise", async () => {
  const sentCommands = [];
  let typedText = "";
  const mockCdp = {
    send: async (method, params, sessionId) => {
      sentCommands.push({ method, params, sessionId });
      if (method === "Input.insertText") {
        typedText = params.text;
      }
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("selectNodeContents") || params.expression.includes("kind:")) {
          return { result: { value: { kind: "editable", replacedChars: 0 } } };
        }
        return { result: { value: typedText } };
      }
      return {};
    },
  };

  // 1. Empty string
  await assert.rejects(
    typePrompt(mockCdp, "session-1", chatgptAdapter, ""),
    (err) => err.code === "PROMPT_NOT_TYPED"
  );

  // 2. Normal string
  const res = await typePrompt(mockCdp, "session-1", chatgptAdapter, "Hello world");
  assert.equal(res.typedChars, 11);
  assert.equal(res.replacedChars, 0);

  const evalCmd = sentCommands.find((c) => c.method === "Runtime.evaluate");
  const insertCmd = sentCommands.find((c) => c.method === "Input.insertText");
  assert.ok(evalCmd, "Should evaluate focus script");
  assert.equal(insertCmd.params.text, "Hello world");
});

test("typePrompt: throws EDITOR_NOT_FOUND if editor cannot be focused", async () => {
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: false } };
      }
      return {};
    },
  };

  await assert.rejects(
    typePrompt(mockCdp, "session-1", chatgptAdapter, "Hello"),
    (err) => err.code === "EDITOR_NOT_FOUND"
  );
});

test("openTab and submitTurn: standard CDP protocol execution", async () => {
  const calls = [];
  const mockCdp = {
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === "Target.createTarget") {
        return { targetId: "target-123" };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: "session-456" };
      }
      return {};
    },
  };

  const tab = await openTab(mockCdp, "https://chatgpt.com/");
  assert.equal(tab.targetId, "target-123");
  assert.equal(tab.sessionId, "session-456");

  const legacyAdapter = { id: "legacy" };
  const submitRes = await submitTurn(mockCdp, tab.sessionId, legacyAdapter);
  assert.ok(typeof submitRes.submittedAt === "number");
  assert.equal(submitRes.method, "enter");

  const keyDown = calls.find((c) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
  const keyUp = calls.find((c) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyUp");
  assert.ok(keyDown && keyUp);
  assert.equal(keyDown.params.windowsVirtualKeyCode, 13);
});

test("waitForCompletion: stalled with send_unconfirmed after 30s without Sent ACK and halts polling", async () => {
  let virtualTime = 0;
  let evaluateCalls = 0;
  let inputCalls = 0;

  const mockCdp = {
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        evaluateCalls++;
        return {
          result: {
            value: JSON.stringify({
              userTurns: 0,
              answerTurns: 0,
              answerText: "",
              stopVisible: false,
              editorEmpty: false,
              title: "ChatGPT",
              hasChallenge: false,
            }),
          },
        };
      }
      if (method.startsWith("Input.")) {
        inputCalls++;
      }
      return {};
    },
  };

  const result = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    ackTimeoutMs: 30000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(result.status, "stalled");
  assert.equal(result.reason, "send_unconfirmed");
  assert.ok(result.elapsedMs >= 30000);
  assert.equal(inputCalls, 0, "No Input.* calls should be made after completion/stall");
  assert.ok(evaluateCalls > 0);
  assert.equal(result.evidence.editorEmpty, false);
});

test("waitForCompletion: normal completion after settleMs and stop button disappearing", async () => {
  let virtualTime = 0;
  let pollCount = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        pollCount++;
        if (pollCount === 1) {
          // Poll 1: ACK via editorEmpty = true
          return {
            result: {
              value: JSON.stringify({
                userTurns: 1,
                answerTurns: 0,
                answerText: "",
                stopVisible: false,
                editorEmpty: true,
                title: "ChatGPT",
              }),
            },
          };
        }
        if (pollCount === 2) {
          // Poll 2: Generating text, stop visible
          return {
            result: {
              value: JSON.stringify({
                userTurns: 1,
                answerTurns: 1,
                answerText: "function hello() { return 'world'; }",
                stopVisible: true,
                editorEmpty: true,
                title: "ChatGPT",
              }),
            },
          };
        }
        // Poll 3+: Stop button disappeared, text stable
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "function hello() { return 'world'; }",
              stopVisible: false,
              editorEmpty: true,
              title: "ChatGPT",
            }),
          },
        };
      }
      return {};
    },
  };

  const result = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 4000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reason, "completed");
  assert.equal(result.text, "function hello() { return 'world'; }");
  assert.equal(result.evidence.answerChars, 36);
  assert.equal(result.evidence.stopVisible, false);
});

test("waitForCompletion: does NOT complete while stopVisible remains true even after settleMs", async () => {
  let virtualTime = 0;
  let pollCount = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        pollCount++;
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "Generating tokens... " + pollCount,
              stopVisible: true,
              editorEmpty: true,
              title: "ChatGPT",
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 2000,
    stallTimeoutMs: 10000,
    hardTimeoutMs: 15000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  // Must not declare completed as long as stopVisible is true; eventually hits hardTimeoutMs
  assert.notEqual(res.status, "completed");
  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "hard_timeout");
});

test("waitForCompletion: continuously outputting does NOT trigger stalled within stallTimeoutMs", async () => {
  let virtualTime = 0;
  let chars = 10;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        if (virtualTime < 10000) {
          chars += 5; // grows every poll while generating
        }
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "x".repeat(chars),
              stopVisible: virtualTime < 10000,
              editorEmpty: true,
              title: "ChatGPT",
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 2000,
    stallTimeoutMs: 5000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "completed");
  assert.notEqual(res.status, "stalled");
});

test("waitForCompletion: stalled with no_progress when text stops growing for stallTimeoutMs", async () => {
  let virtualTime = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        // Output stuck, stop visible
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "Stuck token...",
              stopVisible: true,
              editorEmpty: true,
              title: "ChatGPT",
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 2000,
    stallTimeoutMs: 6000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "stalled");
  assert.equal(res.reason, "no_progress");
  assert.ok(res.elapsedMs >= 6000);
});

test("waitForCompletion: triggers needs_human on challenges.cloudflare.com detection", async () => {
  let virtualTime = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 0,
              answerTurns: 0,
              answerText: "",
              stopVisible: false,
              editorEmpty: null,
              title: "Just a moment... challenges.cloudflare.com",
              hasChallenge: true,
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "human_verification_required");
});

test("waitForCompletion: fail-closed with MESSAGE_SELECTOR_UNRESOLVED if answer turn completed but answerText is empty", async () => {
  let virtualTime = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "", // Empty text even though answer turn exists
              stopVisible: false,
              editorEmpty: true,
              title: "ChatGPT",
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 2000,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "failed");
  assert.equal(res.reason, "MESSAGE_SELECTOR_UNRESOLVED");
});

test("classifyRunError: classifies errors into needs_human or failed", () => {
  const errCloudflare = new Error("Encountered challenges.cloudflare.com challenge");
  assert.deepEqual(classifyRunError(errCloudflare), {
    state: "needs_human",
    code: "HUMAN_VERIFICATION_REQUIRED",
    detail: errCloudflare.message,
  });

  const errEditor = new Error("Editor not found");
  errEditor.code = "EDITOR_NOT_FOUND";
  assert.deepEqual(classifyRunError(errEditor), {
    state: "failed",
    code: "EDITOR_NOT_FOUND",
    detail: "Editor not found",
  });
});

test("ChatGPT adapter: buildReadStateJs and buildAnswerTextJs in simulated DOM", () => {
  const mockDoc = {
    title: "ChatGPT conversation",
    querySelectorAll(selector) {
      if (selector === "h4") {
        const uH4 = {
          innerText: "你 说:",
          nextElementSibling: { innerText: "User question" },
        };
        const aH4 = {
          innerText: "ChatGPT 说:",
          nextElementSibling: { innerText: "export function solve() { return 42; }" },
        };
        return [uH4, aH4];
      }
      if (selector.includes("article")) {
        return [];
      }
      return [];
    },
    querySelector(selector) {
      if (selector.includes("ProseMirror")) {
        return { innerText: "" };
      }
      if (selector.includes("stop-button")) {
        return {
          disabled: false,
          getBoundingClientRect: () => ({ width: 0, height: 0 }),
        };
      }
      return null;
    },
  };

  const readStateCode = chatgptAdapter.buildReadStateJs();
  const readStateFn = new Function("document", "window", "return " + readStateCode);
  const stateJson = readStateFn(mockDoc, {});
  const state = JSON.parse(stateJson);

  assert.equal(state.userTurns, 1);
  assert.equal(state.answerTurns, 1);
  assert.equal(state.answerText, "export function solve() { return 42; }");
  assert.equal(state.editorEmpty, true);
  assert.equal(state.stopVisible, false);
  assert.equal(state.title, "ChatGPT conversation");
  assert.equal(state.hasProseMirror, true);
  assert.equal(state.hasMobileComposer, false);
  assert.equal(state.loggedOut, false);

  const answerTextCode = chatgptAdapter.buildAnswerTextJs();
  const answerTextFn = new Function("document", "window", "return " + answerTextCode);
  const text = answerTextFn(mockDoc, {});
  assert.equal(text, "export function solve() { return 42; }");
});

test("Gemini adapter: buildReadStateJs and buildAnswerTextJs in simulated DOM", () => {
  const mockDoc = {
    title: "Gemini",
    querySelectorAll(selector) {
      if (selector === "user-query") {
        return [{ innerText: "Hello Gemini" }];
      }
      if (selector === "model-response") {
        return [
          {
            querySelector(sub) {
              return { innerText: "Gemini said: Here is your answer." };
            },
          },
        ];
      }
      return [];
    },
    querySelector(selector) {
      if (selector.includes("rich-textarea") || selector.includes("ql-editor")) {
        return { innerText: "" };
      }
      if (selector.includes("Stop") || selector.includes("stop-button")) {
        return null;
      }
      return null;
    },
  };

  const readStateCode = geminiAdapter.buildReadStateJs();
  const readStateFn = new Function("document", "window", "return " + readStateCode);
  const stateJson = readStateFn(mockDoc, {});
  const state = JSON.parse(stateJson);

  assert.equal(state.userTurns, 1);
  assert.equal(state.answerTurns, 1);
  assert.equal(state.answerText, "Here is your answer.");
  assert.equal(state.editorEmpty, true);
  assert.equal(state.stopVisible, false);
  assert.equal(state.title, "Gemini");
  assert.equal(state.signedIn, false);
  assert.equal(state.signedOut, false);
  assert.equal(state.loggedOut, false);

  const answerTextCode = geminiAdapter.buildAnswerTextJs();
  const answerTextFn = new Function("document", "window", "return " + answerTextCode);
  const text = answerTextFn(mockDoc, {});
  assert.equal(text, "Here is your answer.");
});

test("Gemini adapter: buildReadStateJs evaluates loggedOut heuristic accurately", () => {
  const readStateCode = geminiAdapter.buildReadStateJs();
  assert.ok(readStateCode.includes("signedIn"));
  assert.ok(readStateCode.includes("signedOut"));

  const readStateFn = new Function("document", "window", "return " + readStateCode);

  const makeDoc = ({ userTurns = 0, signedIn = false, signedOut = false } = {}) => ({
    title: "Gemini",
    querySelectorAll(selector) {
      if (selector === "user-query") {
        return Array(userTurns).fill({ innerText: "User query" });
      }
      return [];
    },
    querySelector(selector) {
      if (signedIn && (selector.includes("Google 账号") || selector.includes("Google Account") || selector.includes("SignOutOptions"))) {
        return { nodeName: "BUTTON" };
      }
      if (signedOut && (selector.includes("登录") || selector.includes("Sign in") || selector.includes("ServiceLogin") || selector.includes("AccountChooser"))) {
        return { nodeName: "BUTTON" };
      }
      return null;
    },
  });

  // 1. signedIn true, signedOut false, userTurns 0 -> loggedOut false
  const state1 = JSON.parse(readStateFn(makeDoc({ userTurns: 0, signedIn: true, signedOut: false }), {}));
  assert.equal(state1.signedIn, true);
  assert.equal(state1.signedOut, false);
  assert.equal(state1.userTurns, 0);
  assert.equal(state1.loggedOut, false, "signed-in with 0 user turns must not report loggedOut");

  // 2. signedIn true, signedOut true, userTurns 0 -> loggedOut false (signed-in wins)
  const state2 = JSON.parse(readStateFn(makeDoc({ userTurns: 0, signedIn: true, signedOut: true }), {}));
  assert.equal(state2.signedIn, true);
  assert.equal(state2.signedOut, true);
  assert.equal(state2.userTurns, 0);
  assert.equal(state2.loggedOut, false, "both true must resolve to signed-in (loggedOut false)");

  // 3. signedIn false, signedOut true, userTurns 0 -> loggedOut true
  const state3 = JSON.parse(readStateFn(makeDoc({ userTurns: 0, signedIn: false, signedOut: true }), {}));
  assert.equal(state3.signedIn, false);
  assert.equal(state3.signedOut, true);
  assert.equal(state3.userTurns, 0);
  assert.equal(state3.loggedOut, true, "signedOut true and signedIn false with 0 user turns must report loggedOut");

  // 4. userTurns 1 and signed-out markers present -> loggedOut false
  const state4 = JSON.parse(readStateFn(makeDoc({ userTurns: 1, signedIn: false, signedOut: true }), {}));
  assert.equal(state4.userTurns, 1);
  assert.equal(state4.signedIn, false);
  assert.equal(state4.signedOut, true);
  assert.equal(state4.loggedOut, false, "userTurns > 0 must not report loggedOut even if signed-out markers present");
});

test("ChatGPT adapter: buildReadStateJs emits hasProseMirror and hasMobileComposer evidence", () => {
  const readStateCode = chatgptAdapter.buildReadStateJs();
  assert.ok(readStateCode.includes("hasProseMirror"));
  assert.ok(readStateCode.includes("hasMobileComposer"));

  const readStateFn = new Function("document", "window", "return " + readStateCode);

  const mockLoggedOutDoc = {
    title: "ChatGPT",
    querySelectorAll: () => [],
    querySelector: (sel) => {
      if (sel.includes("mobile-composer-prompt")) return { value: "" };
      return null;
    },
  };
  const state = JSON.parse(readStateFn(mockLoggedOutDoc, {}));
  assert.equal(state.hasProseMirror, false);
  assert.equal(state.hasMobileComposer, true);
  assert.equal(state.loggedOut, true);
});

test("findDevToolsPort: parses DevToolsActivePort file", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cdp-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  try {
    const portFile = path.join(tmpDir, "DevToolsActivePort");
    await writeFile(portFile, "9222\n/devtools/browser/uuid-12345\n", "utf8");

    const found = await findDevToolsPort(tmpDir, { timeoutMs: 1000 });
    assert.deepEqual(found, {
      port: 9222,
      wsPath: "/devtools/browser/uuid-12345",
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Gemini state with title 'Google Gemini', one editor, hasChallenge false: normal turn completion", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "Answer from Gemini",
              stopVisible: false,
              editorEmpty: true,
              title: "Google Gemini",
              hasChallenge: false,
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.text, "Answer from Gemini");
});

test("Gemini state with title '请稍候', no editor, hasChallenge true: human_verification_required", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 0,
              answerTurns: 0,
              answerText: "",
              stopVisible: false,
              editorEmpty: null,
              title: "请稍候",
              hasChallenge: true,
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "human_verification_required");
});

test("Gemini state with title 'Google Gemini', editor present, hasChallenge true (racy/stale probe): turn proceeds, not human_verification_required", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "Proceeded successfully",
              stopVisible: false,
              editorEmpty: true,
              title: "Google Gemini",
              hasChallenge: true,
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.notEqual(res.status, "needs_human");
  assert.equal(res.status, "completed");
  assert.equal(res.text, "Proceeded successfully");
});

test("ChatGPT state with title 'ChatGPT', hasProseMirror true, hasChallenge true: proceeds", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "ChatGPT proceeds",
              stopVisible: false,
              editorEmpty: null,
              hasProseMirror: true,
              title: "ChatGPT",
              hasChallenge: true,
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.notEqual(res.status, "needs_human");
  assert.equal(res.status, "completed");
  assert.equal(res.text, "ChatGPT proceeds");
});

test("Login probe still treats 'sign in' / '登录' titles as not logged in yet", () => {
  assert.ok(geminiAdapter.challengeTitlePattern.test("登录到您的 Google 账号"));
  assert.ok(geminiAdapter.challengeTitlePattern.test("Sign in - Google Accounts"));
  assert.ok(chatgptAdapter.challengeTitlePattern.test("人机验证 - 请稍候"));

  // While turnChallengeTitlePattern must NOT include sign-in words
  assert.equal(geminiAdapter.turnChallengeTitlePattern.test("登录"), false);
  assert.equal(geminiAdapter.turnChallengeTitlePattern.test("Sign in"), false);
  assert.equal(chatgptAdapter.turnChallengeTitlePattern.test("Sign in"), false);
});

test("Gemini adapter stopSelector and buildReadStateJs scoping contracts", () => {
  assert.ok(geminiAdapter.stopSelector.includes('main button[aria-label="Stop response"]'));
  assert.equal(/(^|,)\s*button\[aria-label\*="停止"\]/.test(geminiAdapter.stopSelector), false);

  const readStateCode = geminiAdapter.buildReadStateJs();
  assert.ok(readStateCode.includes('main button[aria-label=\\"Stop response\\"]') || readStateCode.includes('main button[aria-label="Stop response"]'));
  assert.equal(/(^|,|["'`\s])button\[aria-label\*="停止"\]/.test(readStateCode), false);

  assert.ok(chatgptAdapter.stopSelector.includes('main button[aria-label="Stop generating"]'));
  assert.ok(chatgptAdapter.stopSelector.includes('main button[aria-label="停止生成"]'));
  const chatgptReadCode = chatgptAdapter.buildReadStateJs();
  assert.ok(chatgptReadCode.includes('main button[aria-label=\\"Stop generating\\"]') || chatgptReadCode.includes('main button[aria-label="Stop generating"]'));
});

function createMockGeminiDocForStop(elements = []) {
  return {
    title: "Google Gemini",
    querySelectorAll(selector) {
      if (selector === "user-query") return [{ innerText: "Hello" }];
      if (selector === "model-response") return [{ querySelector: () => ({ innerText: "Answer" }) }];
      return [];
    },
    querySelector(selector) {
      if (selector.includes("rich-textarea") || selector.includes("ql-editor")) {
        return { innerText: "" };
      }
      if (selector.includes("Google 账号") || selector.includes("SignOutOptions")) {
        return { nodeName: "BUTTON" };
      }
      const subSelectors = selector.split(",").map((s) => s.trim());
      for (const el of elements) {
        for (const sel of subSelectors) {
          if (sel === ".stop-button" && el.className?.includes("stop-button")) {
            return el;
          }
          if (sel.startsWith("main button[")) {
            if (el.parentTag === "main" && el.tagName === "BUTTON") {
              const exactLabel = sel.match(/aria-label="([^"]+)"/)?.[1];
              if (exactLabel && el.ariaLabel === exactLabel) return el;
            }
          }
          if (sel.startsWith("conversation-container button[")) {
            if (el.parentTag === "conversation-container" && el.tagName === "BUTTON") {
              const subLabel = sel.match(/aria-label\*="([^"]+)"/)?.[1];
              if (subLabel && el.ariaLabel?.includes(subLabel)) return el;
            }
          }
          if (sel.startsWith("button[aria-label*=")) {
            if (el.tagName === "BUTTON") {
              const subLabel = sel.match(/aria-label\*="([^"]+)"/)?.[1];
              if (subLabel && el.ariaLabel?.includes(subLabel)) return el;
            }
          }
        }
      }
      return null;
    },
  };
}

test("Gemini state with sidebar button with 'More options for 停止生成测试' and no generation control: stopVisible false", () => {
  const sidebarBtn = {
    tagName: "BUTTON",
    parentTag: "aside",
    ariaLabel: "More options for 停止生成测试",
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
    disabled: false,
  };
  const mockDoc = createMockGeminiDocForStop([sidebarBtn]);
  const readStateCode = geminiAdapter.buildReadStateJs();
  const readStateFn = new Function("document", "window", "return " + readStateCode);
  const state = JSON.parse(readStateFn(mockDoc, {}));

  assert.equal(state.stopVisible, false);
});

test("Gemini state with 'main button[aria-label=\"Stop response\"]' present: stopVisible true", () => {
  const mainStopBtn = {
    tagName: "BUTTON",
    parentTag: "main",
    ariaLabel: "Stop response",
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
    disabled: false,
  };
  const mockDoc = createMockGeminiDocForStop([mainStopBtn]);
  const readStateCode = geminiAdapter.buildReadStateJs();
  const readStateFn = new Function("document", "window", "return " + readStateCode);
  const state = JSON.parse(readStateFn(mockDoc, {}));

  assert.equal(state.stopVisible, true);
});

test("Gemini state with generation control inside conversation-container: stopVisible true", () => {
  const containerStopBtn = {
    tagName: "BUTTON",
    parentTag: "conversation-container",
    ariaLabel: "停止回答",
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
    disabled: false,
  };
  const mockDoc = createMockGeminiDocForStop([containerStopBtn]);
  const readStateCode = geminiAdapter.buildReadStateJs();
  const readStateFn = new Function("document", "window", "return " + readStateCode);
  const state = JSON.parse(readStateFn(mockDoc, {}));

  assert.equal(state.stopVisible, true);
});

test("waitForCompletion: stopVisible persisting past stopGraceMs (60s) completes with completed_stop_signal_unreliable", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "Final answer from model",
              stopVisible: true,
              editorEmpty: true,
              title: "Google Gemini",
            }),
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 2000,
    stopGraceMs: 60000,
    stallTimeoutMs: 120000,
    hardTimeoutMs: 150000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.reason, "completed_stop_signal_unreliable");
  assert.equal(res.text, "Final answer from model");
  assert.equal(res.evidence.stopSignalDegraded, true);
  assert.ok(res.evidence.stopVisibleForMs >= 60000);
});

test("typePrompt: pre-existing draft text is measured and replaced, not appended", async () => {
  let typedText = "";
  const mockCdp = {
    send: async (method, params) => {
      if (method === "Input.insertText") {
        typedText = params.text;
      }
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("selectNodeContents") || params.expression.includes("kind:")) {
          return { result: { value: { kind: "editable", replacedChars: 18 } } };
        }
        return { result: { value: typedText } };
      }
      return {};
    },
  };

  const res = await typePrompt(mockCdp, "session-1", chatgptAdapter, "Reply with exactly: RETRY");
  assert.equal(res.typedChars, 25);
  assert.equal(res.replacedChars, 18);
});

test("submitTurn: polls sendSelector and clicks enabled button", async () => {
  let clickTriggered = false;
  const mockCdp = {
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("btn.click()")) {
          clickTriggered = true;
          return { result: { value: { clicked: true } } };
        }
        return { result: { value: { exists: true, visible: true, disabled: false } } };
      }
      return {};
    },
  };

  const res = await submitTurn(mockCdp, "session-1", chatgptAdapter, { sendButtonTimeoutMs: 500, pollIntervalMs: 50 });
  assert.equal(res.method, "click");
  assert.equal(clickTriggered, true);
  assert.ok(typeof res.submittedAt === "number");
});

test("submitTurn: throws SEND_BUTTON_MISSING when sendSelector does not match", async () => {
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: { exists: false, visible: false, disabled: true } } };
      }
      return {};
    },
  };

  await assert.rejects(
    submitTurn(mockCdp, "session-1", chatgptAdapter, { sendButtonTimeoutMs: 200, pollIntervalMs: 50 }),
    (err) => err.code === "SEND_BUTTON_MISSING"
  );
});

test("submitTurn: throws SEND_BUTTON_DISABLED when button stays disabled", async () => {
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: { exists: true, visible: true, disabled: true } } };
      }
      return {};
    },
  };

  await assert.rejects(
    submitTurn(mockCdp, "session-1", chatgptAdapter, { sendButtonTimeoutMs: 200, pollIntervalMs: 50 }),
    (err) => err.code === "SEND_BUTTON_DISABLED"
  );
});

test("readTurnState: parses pageError when alert element exists", async () => {
  const mockCdp = {
    send: async () => ({
      result: {
        value: JSON.stringify({
          userTurns: 1,
          answerTurns: 0,
          answerText: "",
          pageError: {
            reason: "provider_rate_limited",
            message: "You've hit the rate limit. Please try again later.",
          },
        }),
      },
    }),
  };

  const state = await readTurnState(mockCdp, "session-1", chatgptAdapter);
  assert.deepEqual(state.pageError, {
    reason: "provider_rate_limited",
    message: "You've hit the rate limit. Please try again later.",
  });
});

test("waitForCompletion: fast-fails immediately on pageError when !hasAnswer", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async () => ({
      result: {
        value: JSON.stringify({
          userTurns: 0,
          answerTurns: 0,
          answerText: "",
          editorEmpty: false,
          pageError: {
            reason: "provider_rate_limited",
            message: "Too many requests",
          },
        }),
      },
    }),
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    pollIntervalMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "provider_rate_limited");
  assert.deepEqual(res.evidence.pageError, {
    reason: "provider_rate_limited",
    message: "Too many requests",
  });
});

test("waitForCompletion: does not abort on pageError if hasAnswer is already true", async () => {
  let virtualTime = 0;
  let poll = 0;
  const mockCdp = {
    send: async () => {
      poll++;
      return {
        result: {
          value: JSON.stringify({
            userTurns: 1,
            answerTurns: 1,
            answerText: "Here is the complete solution.",
            stopVisible: false,
            editorEmpty: true,
            pageError: {
              reason: "provider_error",
              message: "Some non-blocking toast warning",
            },
          }),
        },
      };
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 500,
    pollIntervalMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.text, "Here is the complete solution.");
});

test("classifyRunError: classifies send button and prompt typing errors as needs_human", () => {
  assert.equal(classifyRunError({ code: "SEND_BUTTON_MISSING" }).state, "needs_human");
  assert.equal(classifyRunError({ code: "SEND_BUTTON_DISABLED" }).state, "needs_human");
  assert.equal(classifyRunError({ code: "PROMPT_NOT_TYPED" }).state, "needs_human");
});

test("waitForCompletion: pre-ACK history answer does not block rate-limit fast-fail", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async () => ({
      result: {
        value: JSON.stringify({
          userTurns: 1, // baseline was 1, not yet acked
          answerTurns: 1, // baseline was 1, previous history answer
          answerText: "History turn 1 answer",
          editorEmpty: false,
          pageError: {
            reason: "provider_rate_limited",
            message: "Rate limit reached",
          },
        }),
      },
    }),
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 1,
    baselineAnswerTurns: 1,
    pollIntervalMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "provider_rate_limited");
});

test("waitForCompletion: current-turn answer blocks rate-limit fast-fail (answer wins)", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async () => ({
      result: {
        value: JSON.stringify({
          userTurns: 2,
          answerTurns: 2, // baseline was 1, grew to 2 -> current turn answer!
          answerText: "Fresh current turn response",
          stopVisible: false,
          editorEmpty: true,
          pageError: {
            reason: "provider_rate_limited",
            message: "Late banner after generation",
          },
        }),
      },
    }),
  };

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 1,
    baselineAnswerTurns: 1,
    settleMs: 500,
    pollIntervalMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.text, "Fresh current turn response");
});

test("T3: submitTurn handles hidden vs visible buttons and rejects SEND_BUTTON_AMBIGUOUS when multiple enabled", async () => {
  // Case 1: First hidden, second visible & enabled -> only second clicked
  let clickCount = 0;
  const mockCdp1 = {
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("btn.click()")) {
          clickCount++;
          return { result: { value: { clicked: true } } };
        }
        return { result: { value: { exists: true, visible: true, disabled: false } } };
      }
      return {};
    },
  };

  const res1 = await submitTurn(mockCdp1, "session-1", chatgptAdapter, { sendButtonTimeoutMs: 500, pollIntervalMs: 50 });
  assert.equal(res1.method, "click");
  assert.equal(clickCount, 1);

  // Case 2: Two enabled buttons -> SEND_BUTTON_AMBIGUOUS, 0 clicks
  let ambClickCount = 0;
  const mockCdp2 = {
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("btn.click()")) {
          ambClickCount++;
          return { result: { value: { clicked: false, reason: "ambiguous" } } };
        }
        return { result: { value: { exists: true, visible: true, disabled: false } } };
      }
      return {};
    },
  };

  await assert.rejects(
    submitTurn(mockCdp2, "session-1", chatgptAdapter, { sendButtonTimeoutMs: 500, pollIntervalMs: 50 }),
    (err) => {
      assert.equal(err.code, "SEND_BUTTON_AMBIGUOUS");
      return true;
    }
  );
  assert.equal(ambClickCount, 1, "Only one probe-click attempted before aborting on ambiguous");
});

test("T4 & 3b invariant: CDP click failure throws SEND_UNCONFIRMED with no Enter fallback and exactly 1 click attempt", async () => {
  let clickEvaluations = 0;
  let keyEventsDispatched = 0;

  const mockCdp = {
    send: async (method, params) => {
      if (method === "Input.dispatchKeyEvent") {
        keyEventsDispatched++;
        return {};
      }
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("btn.click()")) {
          clickEvaluations++;
          // Simulate network drop / timeout during click evaluation
          throw new Error("CDP connection timed out waiting for click response");
        }
        return { result: { value: { exists: true, visible: true, disabled: false } } };
      }
      return {};
    },
  };

  await assert.rejects(
    submitTurn(mockCdp, "session-1", chatgptAdapter, { sendButtonTimeoutMs: 1000, pollIntervalMs: 50 }),
    (err) => {
      assert.equal(err.code, "SEND_UNCONFIRMED");
      return true;
    }
  );

  assert.equal(clickEvaluations, 1, "Click expression must be executed at most once (no retry on failure)");
  assert.equal(keyEventsDispatched, 0, "No Enter fallback dispatch when click fails");
});

test("T5: typePrompt value branch with only zero-width space \\u200b yields replacedChars 0", async () => {
  const mockCdp = {
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("kind:")) {
          // Focus script simulated on a textarea with only zero-width spaces
          // If cleaned.length === 0, replacedChars is 0
          return { result: { value: { kind: "value", replacedChars: 0 } } };
        }
        if (params.expression.includes("el.value ===")) {
          return { result: { value: true } };
        }
      }
      return {};
    },
  };

  const res = await typePrompt(mockCdp, "session-1", chatgptAdapter, "Hello world");
  assert.equal(res.typedChars, 11);
  assert.equal(res.replacedChars, 0);
});

test("T5-eval: focusExpr regex escape in template literal correctly strips whitespace and \\u200b on textarea", () => {
  const valOnlyBlanks = "   \u200b\u00a0\n\t  ";
  const snippet1 = `const cleaned = (${JSON.stringify(valOnlyBlanks)}).replace(/[\\s\\u00a0\\u200b]/g, ""); cleaned.length;`;
  assert.equal(eval(snippet1), 0, "All whitespace, non-breaking and zero-width spaces must be stripped");

  const valWithText = "   \u200bhello  ";
  const snippet2 = `const cleaned = (${JSON.stringify(valWithText)}).replace(/[\\s\\u00a0\\u200b]/g, ""); cleaned.length;`;
  assert.equal(eval(snippet2), 5, "Real text characters must remain");
});


