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
  const mockCdp = {
    send: async (method, params, sessionId) => {
      sentCommands.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return { result: { value: true } };
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

  const submitRes = await submitTurn(mockCdp, tab.sessionId, chatgptAdapter);
  assert.ok(typeof submitRes.submittedAt === "number");

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
              editorEmpty: false,
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

  const answerTextCode = geminiAdapter.buildAnswerTextJs();
  const answerTextFn = new Function("document", "window", "return " + answerTextCode);
  const text = answerTextFn(mockDoc, {});
  assert.equal(text, "Here is your answer.");
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
