import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCdpTurn } from "../src/engines/cdp-engine.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { main } from "../src/cli.js";
import { WfaError } from "../src/errors.js";

function createMockStream() {
  let content = "";
  return {
    write: (chunk) => {
      content += chunk;
      return true;
    },
    get output() {
      return content;
    },
    clear: () => {
      content = "";
    },
  };
}

test("runCdpTurn: full successful flow with SAFE_START, verifies driver.submitTurn is called and status is completed", async () => {
  let submitTurnCalled = false;
  let typePromptText = "";
  const cdpSentMethods = [];

  const mockCdp = {
    send: async (method, params = {}) => {
      cdpSentMethods.push(method);
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 1 };
      }
      if (method === "Runtime.evaluate" && params.expression === "window.location.href") {
        return { result: { value: "https://chatgpt.com/c/test-conversation-id" } };
      }
      return {};
    },
    close: () => {},
  };

  const mockDriver = {
    openTab: async () => ({ targetId: "target-123", sessionId: "session-456" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({ userTurns: 0, answerTurns: 0 }),
    typePrompt: async (_cdp, _sessionId, _adapter, text) => {
      typePromptText = text;
      return { typedChars: text.length };
    },
    submitTurn: async () => {
      submitTurnCalled = true;
      return { submittedAt: Date.now() };
    },
    waitForCompletion: async () => ({
      status: "completed",
      reason: "completed",
      text: "Hello from mock ChatGPT response",
      evidence: { stopVisible: false, answerChars: 32 },
    }),
  };

  const mockRecoverBrowser = async ({ mode }) => {
    assert.equal(mode, "background", "background mode should pass through to recoverBrowser");
    return {
      action: "SAFE_START",
      reason: "no_lock_profile_free",
      evidence: {},
      chrome: { pid: 4242, port: 9222 },
    };
  };

  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Write a fibonacci function",
    mode: "background",
    minIntervalMs: 0,
    deps: {
      recoverBrowser: mockRecoverBrowser,
      connectCdp: async (port) => {
        assert.equal(port, 9222);
        return mockCdp;
      },
      driver: mockDriver,
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, "Hello from mock ChatGPT response");
  assert.equal(result.reason, "completed");
  assert.equal(submitTurnCalled, true, "driver.submitTurn must be called during turn lifecycle");
  assert.equal(typePromptText, "Write a fibonacci function");
  assert.equal(result.conversationUrl, "https://chatgpt.com/c/test-conversation-id");
  assert.deepEqual(result.browser, {
    pid: 4242,
    port: 9222,
    mode: "background",
    reused: false,
  });
  assert.ok(cdpSentMethods.includes("Browser.setWindowBounds"), "background mode sets window bounds");
  assert.ok(cdpSentMethods.includes("Target.closeTarget"), "tab must be closed in finally");
});

test("runCdpTurn: recoverBrowser returns RECOVERY_REQUIRED -> returns status needs_human and connectCdp is never called", async () => {
  let connectCdpCalled = false;

  const mockRecoverBrowser = async () => ({
    action: "RECOVERY_REQUIRED",
    reason: "lock_corrupt",
    evidence: { lockStatus: "corrupt" },
    chrome: null,
  });

  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    minIntervalMs: 0,
    deps: {
      recoverBrowser: mockRecoverBrowser,
      connectCdp: async () => {
        connectCdpCalled = true;
        throw new Error("connectCdp should never be called when recovery is required");
      },
    },
  });

  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "lock_corrupt");
  assert.deepEqual(result.evidence, { lockStatus: "corrupt" });
  assert.equal(connectCdpCalled, false, "connectCdp must not be called when RECOVERY_REQUIRED");
});

test("runCdpTurn: waitForCompletion returns stalled -> correctly passes through status stalled", async () => {
  const mockCdp = {
    send: async () => ({}),
    close: () => {},
  };

  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({ userTurns: 1, answerTurns: 0 }),
    typePrompt: async () => ({ typedChars: 5 }),
    submitTurn: async () => ({ submittedAt: Date.now() }),
    waitForCompletion: async () => ({
      status: "stalled",
      reason: "no_progress",
      text: "partial output before stall",
      evidence: { lastProgressAgoMs: 185000 },
    }),
  };

  const result = await runCdpTurn({
    provider: "gemini",
    prompt: "Explain relativity",
    minIntervalMs: 0,
    deps: {
      recoverBrowser: async () => ({
        action: "ADOPT",
        reason: "verified",
        chrome: { pid: 8888, port: 9333 },
      }),
      connectCdp: async () => mockCdp,
      driver: mockDriver,
    },
  });

  assert.equal(result.status, "stalled");
  assert.equal(result.reason, "no_progress");
  assert.equal(result.text, "partial output before stall");
  assert.equal(result.browser.reused, true, "ADOPT action marks reused as true");
});

test("runCdpTurn: driver throws EDITOR_NOT_FOUND -> returns status failed and reason EDITOR_NOT_FOUND", async () => {
  const mockCdp = {
    send: async () => ({}),
    close: () => {},
  };

  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => {
      const err = new WfaError("EDITOR_NOT_FOUND", "Editor not found within 60000ms");
      err.code = "EDITOR_NOT_FOUND";
      throw err;
    },
  };

  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    minIntervalMs: 0,
    deps: {
      recoverBrowser: async () => ({
        action: "SAFE_START",
        reason: "no_lock_profile_free",
        chrome: { pid: 1234, port: 9222 },
      }),
      connectCdp: async () => mockCdp,
      driver: mockDriver,
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "editor_not_found");
});

test("T1: onSendIntent throws -> journal_unwritable, countsForCooldown false", async () => {
  let recordedCountsForCooldown = null;

  const mockCdp = {
    send: async () => ({}),
    close: () => {},
  };

  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({ userTurns: 0, answerTurns: 0 }),
  };

  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    minIntervalMs: 0,
    deps: {
      recoverBrowser: async () => ({
        action: "SAFE_START",
        reason: "no_lock_profile_free",
        chrome: { pid: 1234, port: 9222 },
      }),
      connectCdp: async () => mockCdp,
      driver: mockDriver,
      onSendIntent: async () => {
        throw new Error("Journal disk full");
      },
      recordLastTurn: async (_home, _provider, opts) => {
        recordedCountsForCooldown = opts.countsForCooldown;
      },
    },
  });

  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "journal_unwritable");
  assert.equal(recordedCountsForCooldown, false, "countsForCooldown must be false when onSendIntent fails");
});

test("T6: draft replaced then submit fails -> error evidence includes replacedChars", async () => {
  const mockCdp = {
    send: async () => ({}),
    close: () => {},
  };

  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({ userTurns: 0, answerTurns: 0 }),
    typePrompt: async () => ({ typedChars: 15, replacedChars: 8 }),
    submitTurn: async () => {
      const err = new WfaError("SEND_BUTTON_MISSING", "Send button missing");
      err.code = "SEND_BUTTON_MISSING";
      throw err;
    },
  };

  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    minIntervalMs: 0,
    deps: {
      recoverBrowser: async () => ({
        action: "SAFE_START",
        reason: "no_lock_profile_free",
        chrome: { pid: 1234, port: 9222 },
      }),
      connectCdp: async () => mockCdp,
      driver: mockDriver,
    },
  });

  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "send_button_missing");
  assert.equal(result.evidence.replacedChars, 8, "evidence must include replacedChars from completed typePrompt");
});

test("runCdpTurn: cancellation after typePrompt preserves typedChars and replacedChars in evidence", async () => {
  const mockCdp = {
    send: async (method) => {
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      return {};
    },
    close: () => {},
  };

  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({ userTurns: 0, answerTurns: 0 }),
    typePrompt: async () => ({ typedChars: 25, replacedChars: 12 }),
    submitTurn: async () => {},
    waitForCompletion: async () => {
      const err = new Error("Generation cancelled");
      err.code = "CANCELLED";
      throw err;
    },
  };

  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    minIntervalMs: 0,
    deps: {
      recoverBrowser: async () => ({
        action: "SAFE_START",
        reason: "no_lock_profile_free",
        chrome: { pid: 1234, port: 9222 },
      }),
      connectCdp: async () => mockCdp,
      driver: mockDriver,
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "cancelled");
  assert.deepEqual(result.evidence, { typedChars: 25, replacedChars: 12 });
  assert.ok(typeof result.sendCommittedAt === "number" && result.sendCommittedAt > 0);
});

test("runCdpTurn: cancellation before typePrompt leaves evidence as null", async () => {
  const mockCdp = {
    send: async (method) => {
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      return {};
    },
    close: () => {},
  };

  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => {
      const err = new Error("Editor wait cancelled");
      err.code = "CANCELLED";
      throw err;
    },
    readTurnState: async () => ({ userTurns: 0, answerTurns: 0 }),
    typePrompt: async () => ({ typedChars: 25, replacedChars: 12 }),
  };

  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    minIntervalMs: 0,
    deps: {
      recoverBrowser: async () => ({
        action: "SAFE_START",
        reason: "no_lock_profile_free",
        chrome: { pid: 1234, port: 9222 },
      }),
      connectCdp: async () => mockCdp,
      driver: mockDriver,
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "cancelled");
  assert.equal(result.evidence, null);
  assert.equal(result.sendCommittedAt, undefined);
});


test("runCdpCommand ask --json: normal output can be parsed by JSON.parse", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const mockTurnResult = {
    status: "completed",
    text: "console.log('JSON test');",
    reason: "completed",
    evidence: { answerChars: 25 },
    conversationUrl: "https://chatgpt.com/c/123",
    browser: { pid: 5000, port: 9222, mode: "background", reused: true },
    elapsedMs: 2500,
  };

  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "Test prompt", "--json"],
    {
      stdout,
      stderr,
      runCdpTurn: async (opts) => {
        assert.equal(opts.provider, "chatgpt");
        assert.equal(opts.prompt, "Test prompt");
        return mockTurnResult;
      },
    },
  );

  assert.equal(res.code, 0);
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.text, "console.log('JSON test');");
  assert.equal(parsed.browser.pid, 5000);
});

test("runCdpCommand: unknown subcommand returns code: 2", async () => {
  const stderr = createMockStream();

  const res1 = await runCdpCommand(["unknownSubcmd"], { stderr });
  assert.equal(res1.code, 2);

  const res2 = await runCdpCommand([], { stderr });
  assert.equal(res2.code, 2);
});

test("runCdpCommand: missing or invalid --provider returns code: 1 with INVALID_ARGUMENT", async () => {
  const stderr = createMockStream();

  // Missing --provider
  const resMissing = await runCdpCommand(["ask", "--prompt", "Hello"], { stderr });
  assert.equal(resMissing.code, 1);
  assert.equal(resMissing.error?.code, "INVALID_ARGUMENT");

  // Invalid provider
  const resInvalid = await runCdpCommand(["ask", "--provider", "unsupported-ai", "--prompt", "Hello"], { stderr });
  assert.equal(resInvalid.code, 1);
  assert.equal(resInvalid.error?.code, "INVALID_ARGUMENT");
});

test("runCdpCommand status: reports running when broker.json exists, returns code: 0", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const record = {
    instanceId: "inst-1234",
    pid: 7777,
    port: 9444,
    mode: "background",
    startedAt: "2026-11-23T00:00:00.000Z",
  };

  const res = await runCdpCommand(["status"], {
    stdout,
    stderr,
    readBrokerRecord: async () => record,
  });

  assert.equal(res.code, 0);
  assert.ok(stdout.output.includes("instanceId: inst-1234"));
  assert.ok(stdout.output.includes("pid: 7777"));
  assert.ok(stdout.output.includes("port: 9444"));

  // With --json
  stdout.clear();
  const resJson = await runCdpCommand(["status", "--json"], {
    stdout,
    stderr,
    readBrokerRecord: async () => record,
  });
  assert.equal(resJson.code, 0);
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.instanceId, "inst-1234");
  assert.equal(parsed.pid, 7777);
});

test("runCdpCommand status: reports 'broker: not running' when broker.json is missing, returns code: 0", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "wfa-cdp-test-"));
  try {
    const res = await runCdpCommand(["status"], {
      stdout,
      stderr,
      home: tmpHome,
    });
    assert.equal(res.code, 0);
    assert.equal(stdout.output.trim(), "broker: not running");

    stdout.clear();
    const resJson = await runCdpCommand(["status", "--json"], {
      stdout,
      stderr,
      home: tmpHome,
    });
    assert.equal(resJson.code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.running, false);
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test("runCdpCommand --help: prints help and returns code: 0", async () => {
  const stdout = createMockStream();
  const res = await runCdpCommand(["--help"], { stdout });
  assert.equal(res.code, 0);
  assert.ok(stdout.output.includes("wfa cdp ask"));
  assert.ok(stdout.output.includes("wfa cdp status"));
});

test("runCdpCommand ask: non-json prints [cdp] prefix and text on completion", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runCdpCommand(["ask", "--provider=gemini", "--prompt=hello"], {
    stdout,
    stderr,
    runCdpTurn: async () => ({
      status: "completed",
      text: "Gemini text response\n",
      elapsedMs: 1200,
      browser: { pid: 100, port: 9222, mode: "background", reused: true },
    }),
  });

  assert.equal(res.code, 0);
  assert.ok(stdout.output.includes("[cdp] provider=gemini status=completed elapsed=1.2s"));
  assert.ok(stdout.output.includes("Gemini text response"));
});

test("runCdpCommand ask: non-completed turn returns code: 1", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "fail test"], {
    stdout,
    stderr,
    runCdpTurn: async () => ({
      status: "failed",
      reason: "EDITOR_NOT_FOUND",
      text: "",
      elapsedMs: 800,
    }),
  });

  assert.equal(res.code, 1);
  assert.ok(stdout.output.includes("[cdp] provider=chatgpt status=failed"));
  assert.ok(stderr.output.includes("[cdp] reason: EDITOR_NOT_FOUND"));
});

test("runCdpCommand ask: reads from --prompt-file", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wfa-prompt-test-"));
  const promptFile = path.join(tmpDir, "prompt.txt");
  await writeFile(promptFile, "Prompt from prompt file");

  try {
    let receivedPrompt = "";
    const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt-file", promptFile], {
      stdout,
      stderr,
      runCdpTurn: async (opts) => {
        receivedPrompt = opts.prompt;
        return {
          status: "completed",
          text: "OK",
          elapsedMs: 500,
        };
      },
    });

    assert.equal(res.code, 0);
    assert.equal(receivedPrompt, "Prompt from prompt file");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("cli.js dispatch: main(['cdp', '--help']) delegates to cdp-cli and returns 0", async () => {
  const stdout = createMockStream();
  const origStdoutWrite = process.stdout.write;
  process.stdout.write = stdout.write;

  try {
    const code = await main(["cdp", "--help"]);
    assert.equal(code, 0);
    assert.ok(stdout.output.includes("wfa cdp ask"));
    assert.ok(stdout.output.includes("wfa cdp login"));
  } finally {
    process.stdout.write = origStdoutWrite;
  }
});

test("wfa cdp login: success path returns marker on 2nd poll and never kills Chrome", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let pollCount = 0;
  let killCalled = false;
  let socketClosed = false;

  const mockCdp = {
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        pollCount++;
        return {
          result: {
            value: {
              loggedIn: pollCount >= 2,
              user: pollCount >= 2 ? "Logged In - ChatGPT" : null,
              title: pollCount >= 2 ? "Logged In - ChatGPT" : "Login to ChatGPT",
            },
          },
        };
      }
      return {};
    },
    close: () => {
      socketClosed = true;
    },
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    kill: () => {
      killCalled = true;
    },
    recoverBrowser: async ({ mode }) => {
      assert.equal(mode, "visible");
      return {
        action: "SAFE_START",
        chrome: { pid: 777, port: 9222 },
      };
    },
    connectCdp: async () => mockCdp,
    driver: {
      openTab: async () => ({ targetId: "tab-1", sessionId: "sess-1" }),
    },
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.equal(pollCount, 2);
  assert.equal(killCalled, false, "Chrome must never be killed");
  assert.equal(socketClosed, true, "CDP socket must be closed");
  assert.match(stdout.output, /logged in as Logged In - ChatGPT/);
});

test("wfa cdp login: timeout path exits with code 1 and never kills Chrome", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let killCalled = false;

  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              loggedIn: false,
              title: "Login to ChatGPT",
            },
          },
        };
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--timeout", "5"], {
    stdout,
    stderr,
    kill: () => {
      killCalled = true;
    },
    recoverBrowser: async () => ({
      action: "ADOPT",
      chrome: { pid: 888, port: 9222 },
    }),
    connectCdp: async () => mockCdp,
    driver: {
      openTab: async () => ({ targetId: "tab-1", sessionId: "sess-1" }),
    },
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms + 5000;
    },
    pollIntervalMs: 200,
  });

  assert.equal(res.code, 1);
  assert.equal(killCalled, false, "Chrome must never be killed on timeout");
  assert.match(stdout.output, /login not detected within 5s/);
});

test("wfa cdp login: --json shape on success and timeout", async () => {
  const stdoutSuccess = createMockStream();
  const stdoutTimeout = createMockStream();

  // JSON Success
  const resSuccess = await runCdpCommand(["login", "--provider", "chatgpt", "--json"], {
    stdout: stdoutSuccess,
    stderr: createMockStream(),
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => ({
      send: async () => ({ result: { value: { loggedIn: true, user: "pro-user", title: "ChatGPT Pro" } } }),
      close: () => {},
    }),
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    sleep: async () => {},
  });
  assert.equal(resSuccess.code, 0);
  const successJson = JSON.parse(stdoutSuccess.output);
  assert.deepEqual(successJson, {
    status: "completed",
    provider: "chatgpt",
    title: "ChatGPT Pro",
    user: "pro-user",
  });

  // JSON Timeout
  let virtualTime = 0;
  const resTimeout = await runCdpCommand(["login", "--provider", "gemini", "--timeout", "10", "--json"], {
    stdout: stdoutTimeout,
    stderr: createMockStream(),
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => ({
      send: async () => ({ result: { value: { loggedIn: false, title: "Sign in" } } }),
      close: () => {},
    }),
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms + 11000;
    },
    pollIntervalMs: 10,
  });
  assert.equal(resTimeout.code, 1);
  const timeoutJson = JSON.parse(stdoutTimeout.output);
  assert.deepEqual(timeoutJson, {
    status: "timeout",
    provider: "gemini",
    timeout: 10,
  });
});

test("wfa cdp login: invalid --provider rejects with INVALID_ARGUMENT", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runCdpCommand(["login", "--provider", "invalid_prov"], {
    stdout,
    stderr,
  });

  assert.equal(res.code, 1);
  assert.match(stderr.output, /INVALID_ARGUMENT/);
});

test("wfa cdp login: moves window on-screen to 100,100 and records CDP methods", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const sentMethods = [];
  const sentParams = {};

  const mockCdp = {
    send: async (method, params) => {
      sentMethods.push(method);
      if (params) sentParams[method] = params;
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 77 };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              loggedIn: true,
              title: "ChatGPT",
            },
          },
        };
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: {
      openTab: async () => ({ targetId: "target-xyz", sessionId: "session-xyz" }),
    },
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.ok(sentMethods.includes("Browser.getWindowForTarget"), "Must call Browser.getWindowForTarget");
  assert.ok(sentMethods.includes("Browser.setWindowBounds"), "Must call Browser.setWindowBounds");
  assert.deepEqual(sentParams["Browser.getWindowForTarget"], { targetId: "target-xyz" });
  assert.deepEqual(sentParams["Browser.setWindowBounds"], {
    windowId: 77,
    bounds: { left: 100, top: 100, windowState: "normal" },
  });
  assert.ok(stdout.output.includes("[cdp] window moved to 100,100\n[cdp] a visible Chrome window is open."));
});

test("wfa cdp login: rejection on setWindowBounds does not abort login", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const mockCdp = {
    send: async (method) => {
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 88 };
      }
      if (method === "Browser.setWindowBounds") {
        throw new Error("Failed to set window bounds");
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              loggedIn: true,
              user: "ChatGPT Logged In",
              title: "ChatGPT Logged In",
            },
          },
        };
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: {
      openTab: async () => ({ targetId: "tab-1", sessionId: "sess-1" }),
    },
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.match(stdout.output, /logged in as ChatGPT Logged In/);
});

test("wfa cdp login: recovery RECOVERY_REQUIRED throws RECOVERY_REQUIRED with evidence in details", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const evidenceObj = { lockPid: 12345, detail: "lock collision" };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({
      action: "RECOVERY_REQUIRED",
      reason: "profile_locked",
      evidence: evidenceObj,
      chrome: null,
    }),
  });

  assert.equal(res.code, 1);
  assert.equal(res.error?.code, "RECOVERY_REQUIRED");
  assert.match(res.error?.message, /browser\.lock needs a human decision: profile_locked \(run `wfa cdp status` for evidence\)/);
  assert.deepEqual(res.error?.details, evidenceObj);
});

test("wfa cdp login: recovery failure (non-RECOVERY_REQUIRED) throws CHROME_START_FAILED with reason and evidence", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const evidenceObj = { launchError: "binary not found" };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({
      action: "SAFE_START",
      reason: "binary_missing",
      evidence: evidenceObj,
      chrome: null,
    }),
  });

  assert.equal(res.code, 1);
  assert.equal(res.error?.code, "CHROME_START_FAILED");
  assert.match(res.error?.message, /Chrome port is missing from recovery: binary_missing/);
  assert.deepEqual(res.error?.details, evidenceObj);
});

test("wfa cdp login: probe returns false for two polls then true with user - exits 0, prints user, sends Browser.close once", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let pollCount = 0;
  let browserCloseCount = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        pollCount++;
        if (pollCount <= 2) {
          return { result: { value: { loggedIn: false, user: null, title: "Login" } } };
        }
        return { result: { value: { loggedIn: true, user: "a@b.c", title: "ChatGPT" } } };
      }
      if (method === "Browser.close") {
        browserCloseCount++;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.equal(pollCount, 3);
  assert.equal(browserCloseCount, 1, "Browser.close was sent exactly once");
  assert.match(stdout.output, /a@b\.c/);
  assert.equal(res.result.user, "a@b.c");
});

test("wfa cdp login: probe returns false forever with tiny timeout - exits 1, no Browser.close", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let browserCloseSent = false;
  let virtualTime = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: { loggedIn: false, user: null, title: "Login" } } };
      }
      if (method === "Browser.close") {
        browserCloseSent = true;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt", "--timeout", "1"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms + 2000;
    },
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 1);
  assert.equal(browserCloseSent, false, "Browser.close was not sent");
  assert.match(stdout.output, /login not detected within 1s/);
});

test("wfa cdp login: Browser.close rejects - still exits 0", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: { loggedIn: true, user: "a@b.c", title: "ChatGPT" } } };
      }
      if (method === "Browser.close") {
        throw new Error("Connection reset by peer");
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.match(stdout.output, /logged in as a@b\.c/);
  assert.match(stdout.output, /session persisted; later runs restore it with --restore-last-session/);
});

test("wfa cdp login: exits 0 even when Browser.close never resolves", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let browserCloseSent = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: { loggedIn: true, user: "hang@b.c", title: "ChatGPT" } } };
      }
      if (method === "Browser.close") {
        browserCloseSent++;
        return new Promise(() => {}); // never resolves
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.equal(browserCloseSent, 1, "Browser.close was sent exactly once");
  assert.match(stdout.output, /hang@b\.c/);
  assert.match(stdout.output, /session persisted; later runs restore it with --restore-last-session/);
});

test("launch.js: the argument list contains --restore-last-session for background, visible, and headless", async () => {
  const { buildChromeArgs, launchChrome } = await import("../src/browser/launch.js");
  const { EventEmitter } = await import("node:events");

  for (const mode of ["background", "visible", "headless"]) {
    // 1. Direct argument builder check
    const args = buildChromeArgs({ userDataDir: "/tmp/profile", mode });
    assert.ok(args.includes("--restore-last-session"), `args for ${mode} must include --restore-last-session`);
    const noFirstRunIdx = args.indexOf("--no-first-run");
    const restoreIdx = args.indexOf("--restore-last-session");
    assert.equal(restoreIdx, noFirstRunIdx + 1, "--restore-last-session must be placed next to --no-first-run");

    // 2. Fake spawn via launchChrome check
    let spawnedArgs = null;
    const fakeSpawn = (_exe, spawnArgs) => {
      spawnedArgs = spawnArgs;
      const child = new EventEmitter();
      child.pid = 9999;
      child.unref = () => {};
      setImmediate(() => child.emit("error", new Error("test abort")));
      return child;
    };

    try {
      await launchChrome({
        profileDir: "/tmp/fake-profile",
        mode,
        deps: {
          resolveChromeExecutable: async () => "/fake/chrome",
          spawn: fakeSpawn,
        },
      });
    } catch {}

    assert.ok(spawnedArgs, `spawn must have been called for mode ${mode}`);
    assert.ok(spawnedArgs.includes("--restore-last-session"), `spawned args for ${mode} must include --restore-last-session`);
  }
});

test("wfa cdp login: Gemini login where only signed-in selector matches - exits 0", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let browserCloseSent = false;
  let evaluateParams = null;

  const mockCdp = {
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        evaluateParams = params;
        return {
          result: {
            value: {
              loggedIn: true,
              user: null,
              title: "Gemini",
              signedIn: true,
              signedOut: false,
              matchedSignedIn: ['button[aria-label*="Google 账号"]'],
              matchedSignedOut: [],
            },
          },
        };
      }
      if (method === "Browser.close") {
        browserCloseSent = true;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "gemini"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.equal(browserCloseSent, true);
  assert.equal(evaluateParams?.awaitPromise, true);
  assert.match(stdout.output, /logged in \(gemini\)/);
});

test("wfa cdp login: Gemini login where both selectors match - exits 1 (signed-out signal wins)", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let virtualTime = 0;
  let browserCloseSent = false;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        const signedIn = true;
        const signedOut = true;
        const loggedIn = signedIn && !signedOut; // false
        return {
          result: {
            value: {
              loggedIn,
              user: null,
              title: "Gemini Sign in",
              signedIn,
              signedOut,
              matchedSignedIn: ['button[aria-label*="Google 账号"]'],
              matchedSignedOut: ['a[href*="accounts.google.com/ServiceLogin"]'],
            },
          },
        };
      }
      if (method === "Browser.close") {
        browserCloseSent = true;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "gemini", "--timeout", "1"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms + 2000;
    },
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 1);
  assert.equal(browserCloseSent, false, "Must not close browser on timeout");
  assert.match(stdout.output, /login not detected within 1s/);
});

test("wfa cdp login: off-origin ticks for two polls then on-origin success - exits 0, Browser.close sent once, prints user", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let pollCount = 0;
  let browserCloseCount = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        pollCount++;
        if (pollCount <= 2) {
          return {
            result: {
              value: {
                loggedIn: false,
                user: null,
                title: "Sign in to OpenAI",
                origin: "https://auth.openai.com",
                offOrigin: true,
              },
            },
          };
        }
        return {
          result: {
            value: {
              loggedIn: true,
              user: "a@b.c",
              title: "ChatGPT",
              origin: "https://chatgpt.com",
              offOrigin: false,
            },
          },
        };
      }
      if (method === "Browser.close") {
        browserCloseCount++;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.equal(browserCloseCount, 1, "Browser.close sent once");
  assert.match(stdout.output, /a@b\.c/);
  assert.match(stdout.output, /waiting for the redirect to finish \(on auth\.openai\.com\)/);
});

test("wfa cdp login: 45s of off-origin ticks - Page.navigate sent once or twice, never more than twice", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let navigateCount = 0;
  let virtualTime = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              loggedIn: false,
              user: null,
              title: "Sign in to OpenAI",
              origin: "https://auth.openai.com",
              offOrigin: true,
            },
          },
        };
      }
      if (method === "Page.navigate") {
        navigateCount++;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt", "--timeout", "150"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    now: () => virtualTime,
    sleep: async () => {
      virtualTime += 50000;
    },
    pollIntervalMs: 1,
    offOriginThresholdMs: 45000,
  });

  assert.equal(res.code, 1);
  assert.equal(navigateCount, 2, "Page.navigate attempted at most twice");
});

test("wfa cdp login: on-origin false forever with 1s timeout - exit 1, no Browser.close, no navigate", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let browserCloseSent = false;
  let navigateSent = false;
  let virtualTime = 0;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              loggedIn: false,
              user: null,
              title: "ChatGPT: Chat, Work, Create & Code with AI",
              origin: "https://chatgpt.com",
              offOrigin: false,
            },
          },
        };
      }
      if (method === "Browser.close") {
        browserCloseSent = true;
        return {};
      }
      if (method === "Page.navigate") {
        navigateSent = true;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt", "--timeout", "1"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms + 2000;
    },
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 1);
  assert.equal(browserCloseSent, false, "Browser.close must not be sent on timeout");
  assert.equal(navigateSent, false, "Page.navigate must not be sent on-origin");
  assert.match(stdout.output, /login not detected within 1s/);
});

test("wfa cdp login: live broker record - exit 0, stderr mentions broker, Browser.close not sent", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let browserCloseSent = false;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              loggedIn: true,
              user: "a@b.c",
              title: "ChatGPT",
              origin: "https://chatgpt.com",
              offOrigin: false,
            },
          },
        };
      }
      if (method === "Browser.close") {
        browserCloseSent = true;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    readBrokerRecord: async () => ({ schema: 1, instanceId: "inst-1", pid: 1234, port: 4444, token: "tok" }),
    isInstanceAlive: async () => true,
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.equal(browserCloseSent, false, "Browser.close must NOT be sent when broker is live");
  assert.match(stderr.output, /a broker is running; leaving the browser open/);
  assert.match(stdout.output, /logged in as a@b\.c/);
});

test("wfa cdp login: dead broker record - Browser.close sent", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let browserCloseSent = false;

  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              loggedIn: true,
              user: "a@b.c",
              title: "ChatGPT",
              origin: "https://chatgpt.com",
              offOrigin: false,
            },
          },
        };
      }
      if (method === "Browser.close") {
        browserCloseSent = true;
        return {};
      }
      return {};
    },
    close: () => {},
  };

  const res = await runCdpCommand(["login", "--provider", "chatgpt"], {
    stdout,
    stderr,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    connectCdp: async () => mockCdp,
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
    readBrokerRecord: async () => ({ schema: 1, instanceId: "inst-stale", pid: 9999, port: 4444, token: "tok" }),
    isInstanceAlive: async () => false,
    sleep: async () => {},
    pollIntervalMs: 1,
  });

  assert.equal(res.code, 0);
  assert.equal(browserCloseSent, true, "Browser.close must be sent when broker is dead");
  assert.match(stdout.output, /logged in as a@b\.c/);
});

test("wfa cdp ask: passes --min-interval to runCdpTurn", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let passedOptions = null;

  const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "Hello", "--min-interval", "3500"], {
    stdout,
    stderr,
    runCdpTurn: async (opts) => {
      passedOptions = opts;
      if (typeof opts.onWait === "function") {
        opts.onWait(2500);
      }
      return { status: "completed", text: "Answer text", elapsedMs: 100 };
    },
  });

  assert.equal(res.code, 0);
  assert.equal(passedOptions.minIntervalMs, 3500);
  assert.match(stderr.output, /\[cdp\] waiting 2\.5s for the provider interval/);
});

test("wfa cdp ask: rejects negative --min-interval with INVALID_ARGUMENT", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "Hello", "--min-interval", "-10"], {
    stdout,
    stderr,
  });

  assert.equal(res.code, 1);
  assert.match(stderr.output, /INVALID_ARGUMENT/);
});

test("wfa cdp ask: rejects decimal, hex, and scientific notation in --min-interval with INVALID_ARGUMENT", async () => {
  for (const badValue of ["1.5", "0x10", "1e3", "abc"]) {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "Hello", "--min-interval", badValue], {
      stdout,
      stderr,
    });
    assert.equal(res.code, 1, `Expected ${badValue} to be rejected`);
    assert.match(stderr.output, /INVALID_ARGUMENT/);
  }
});




