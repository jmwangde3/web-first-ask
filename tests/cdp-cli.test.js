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
      send: async () => ({ result: { value: { loggedIn: true, title: "ChatGPT Pro" } } }),
      close: () => {},
    }),
    driver: { openTab: async () => ({ targetId: "t", sessionId: "s" }) },
  });
  assert.equal(resSuccess.code, 0);
  const successJson = JSON.parse(stdoutSuccess.output);
  assert.deepEqual(successJson, {
    status: "completed",
    provider: "chatgpt",
    title: "ChatGPT Pro",
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

