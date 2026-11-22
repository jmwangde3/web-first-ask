import test from "node:test";
import assert from "node:assert/strict";
import { createCdpRunner } from "../src/broker/runner.js";
import { waitForEditor, typePrompt } from "../src/browser/driver.js";
import { runCdpTurn } from "../src/engines/cdp-engine.js";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";

test("1. two concurrent run() calls with different providers trigger exactly one recoverBrowser call", async () => {
  let recoverCalls = 0;
  const mockRecover = async () => {
    recoverCalls++;
    await new Promise((r) => setTimeout(r, 20));
    return {
      action: "SAFE_START",
      chrome: { pid: 100, port: 9222 },
    };
  };

  const mockRunTurn = async () => {
    return { status: "completed", text: "done" };
  };

  const mockFetch = async () => {
    return { ok: true, status: 200 };
  };

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: mockRecover,
      runCdpTurn: mockRunTurn,
      fetch: mockFetch,
    },
  });

  const [res1, res2] = await Promise.all([
    runner.run({ id: "turn-1", provider: "chatgpt", prompt: "p1" }),
    runner.run({ id: "turn-2", provider: "gemini", prompt: "p2" }),
  ]);

  assert.equal(res1.status, "completed");
  assert.equal(res2.status, "completed");
  assert.equal(recoverCalls, 1, "recoverBrowser should only be called once for concurrent turns");
});

test("2. a failed probe re-runs recovery, and a successful probe reuses the cache", async () => {
  let recoverCalls = 0;
  let probeShouldFail = false;

  const mockRecover = async () => {
    recoverCalls++;
    return {
      action: "SAFE_START",
      chrome: { pid: 100 + recoverCalls, port: 9222 },
    };
  };

  const mockFetch = async () => {
    if (probeShouldFail) {
      throw new Error("connection refused");
    }
    return { ok: true, status: 200 };
  };

  const mockRunTurn = async () => ({ status: "completed", text: "done" });

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: mockRecover,
      fetch: mockFetch,
      runCdpTurn: mockRunTurn,
    },
  });

  // Call 1: initial recovery
  await runner.run({ id: "turn-1", provider: "chatgpt", prompt: "p1" });
  assert.equal(recoverCalls, 1);

  // Call 2: probe succeeds -> reuses cache
  await runner.run({ id: "turn-2", provider: "chatgpt", prompt: "p2" });
  assert.equal(recoverCalls, 1, "Cache should be reused on successful probe");

  // Call 3: probe fails -> re-runs recovery
  probeShouldFail = true;
  await runner.run({ id: "turn-3", provider: "chatgpt", prompt: "p3" });
  assert.equal(recoverCalls, 2, "Recovery should run again when probe fails");
});

test("3. RECOVERY_REQUIRED -> needs_human, runCdpTurn never called, no retry", async () => {
  let runTurnCalled = false;
  let recoverCalls = 0;

  const mockRecover = async () => {
    recoverCalls++;
    return {
      action: "RECOVERY_REQUIRED",
      reason: "profile_locked",
      evidence: { detail: "lock held" },
    };
  };

  const mockRunTurn = async () => {
    runTurnCalled = true;
    return { status: "completed" };
  };

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: mockRecover,
      runCdpTurn: mockRunTurn,
    },
  });

  const res = await runner.run({ id: "turn-1", provider: "chatgpt", prompt: "p1" });

  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "profile_locked");
  assert.deepEqual(res.evidence, { detail: "lock held" });
  assert.equal(runTurnCalled, false, "runCdpTurn must not be called on RECOVERY_REQUIRED");
  assert.equal(recoverCalls, 1, "Recovery must not retry");
});

test("4. run before cancel returns cancelled and the injected runCdpTurn sees an already-aborted signal", async () => {
  let seenSignalAborted = false;

  const mockRecover = async () => ({
    action: "ADOPT",
    chrome: { pid: 200, port: 9222 },
  });

  const mockRunTurn = async ({ signal }) => {
    seenSignalAborted = signal.aborted;
    if (signal.aborted) {
      return { status: "failed", reason: "cancelled", text: "" };
    }
    return { status: "completed", text: "done" };
  };

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: mockRecover,
      fetch: async () => ({ ok: true }),
      runCdpTurn: mockRunTurn,
    },
  });

  const controller = new AbortController();
  controller.abort();

  const res = await runner.run({ id: "turn-1", provider: "chatgpt", prompt: "p1" }, controller.signal);

  assert.equal(res.status, "failed");
  assert.equal(res.reason, "cancelled");
});

test("5. cancel(unknownId) is a no-op; chrome getter tracks ADOPT and SAFE_START", async () => {
  let currentAction = "SAFE_START";

  const mockRecover = async () => ({
    action: currentAction,
    chrome: { pid: currentAction === "SAFE_START" ? 111 : 222, port: 9222 },
  });

  const mockFetch = async () => ({ ok: false }); // force recovery to refresh
  const mockRunTurn = async () => ({ status: "completed", text: "done" });

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: mockRecover,
      fetch: mockFetch,
      runCdpTurn: mockRunTurn,
    },
  });

  assert.equal(runner.chrome, null);

  assert.doesNotThrow(() => runner.cancel("unknown-id"));

  await runner.run({ id: "t1", provider: "chatgpt", prompt: "p" });
  assert.deepEqual(runner.chrome, { pid: 111, port: 9222, mode: "background" });

  currentAction = "ADOPT";
  await runner.run({ id: "t2", provider: "gemini", prompt: "p" });
  assert.deepEqual(runner.chrome, { pid: 222, port: 9222, mode: "background" });
});

test("6. per-turn mode overrides the runner default; invalid default throws INVALID_ARGUMENT", async () => {
  assert.throws(() => createCdpRunner({ mode: "invalid_mode" }), {
    code: "INVALID_ARGUMENT",
  });

  let capturedMode = null;
  const mockRecover = async ({ mode }) => {
    capturedMode = mode;
    return { action: "ADOPT", chrome: { pid: 1, port: 9222 } };
  };
  const mockRunTurn = async ({ mode }) => {
    capturedMode = mode;
    return { status: "completed" };
  };

  const runner = createCdpRunner({
    mode: "background",
    deps: {
      recoverBrowser: mockRecover,
      fetch: async () => ({ ok: true }),
      runCdpTurn: mockRunTurn,
    },
  });

  // Turn with explicit valid mode
  await runner.run({ id: "t1", provider: "chatgpt", prompt: "p", mode: "visible" });
  assert.equal(capturedMode, "visible");

  // Turn with invalid mode falls back to runner default
  await runner.run({ id: "t2", provider: "chatgpt", prompt: "p", mode: "bogus" });
  assert.equal(capturedMode, "background");
});

test("7. a thrown runCdpTurn becomes failed with the error code and does not reject run", async () => {
  const mockRecover = async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } });
  const mockRunTurn = async () => {
    const err = new Error("CDP connection failed");
    err.code = "CDP_FAIL";
    throw err;
  };

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: mockRecover,
      fetch: async () => ({ ok: true }),
      runCdpTurn: mockRunTurn,
    },
  });

  const res = await runner.run({ id: "t1", provider: "chatgpt", prompt: "p" });
  assert.equal(res.status, "failed");
  assert.equal(res.reason, "cdp_fail");
});

test("waitForEditor: throws HUMAN_VERIFICATION_REQUIRED when challenge detected on timeout", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              found: false,
              title: "请稍候…",
              hasPassword: false,
              bodyLength: 0,
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
      assert.equal(err.code, "HUMAN_VERIFICATION_REQUIRED");
      assert.equal(err.details?.challenge, true);
      assert.equal(err.details?.bodyLength, 0);
      assert.equal(err.title, "请稍候…");
      return true;
    }
  );
});

test("typePrompt: supports textarea via native setter (kind === value)", async () => {
  const evaluations = [];
  const mockCdp = {
    send: async (method, params) => {
      if (method === "Runtime.evaluate") {
        evaluations.push(params.expression);
        if (evaluations.length === 1) {
          // Phase 1: focus returns kind === "value"
          return { result: { value: { kind: "value" } } };
        }
        // Phase 2b: value setter returns true
        return { result: { value: true } };
      }
      return {};
    },
  };

  const res = await typePrompt(mockCdp, "session-1", chatgptAdapter, "hello textarea");
  assert.equal(res.typedChars, "hello textarea".length);
  assert.equal(evaluations.length, 2);
  assert.match(evaluations[1], /HTMLTextAreaElement/);
});

test("waitForEditor: fast fails on challenge within 2 consecutive polls (< 10 calls)", async () => {
  let evalCalls = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        evalCalls++;
        if (evalCalls <= 2) {
          return {
            result: {
              value: {
                found: false,
                title: "请稍候…",
                bodyLength: 0,
              },
            },
          };
        }
        return {
          result: {
            value: {
              found: true,
            },
          },
        };
      }
      return {};
    },
  };

  await assert.rejects(
    waitForEditor(mockCdp, "session-1", chatgptAdapter, {
      timeoutMs: 900000,
      pollIntervalMs: 50,
      sleep: async () => {},
    }),
    (err) => {
      assert.equal(err.code, "HUMAN_VERIFICATION_REQUIRED");
      assert.equal(err.details?.challenge, true);
      assert.equal(err.details?.bodyLength, 0);
      assert.equal(err.title, "请稍候…");
      return true;
    }
  );

  assert.ok(evalCalls < 10, `Expected fewer than 10 calls, got ${evalCalls}`);
  assert.equal(evalCalls, 2, "Should fast-fail on the 2nd consecutive challenged poll");
});

test("waitForEditor: fast fails on challenge with non-empty body (bodyLength: 42) after exactly 2 polls", async () => {
  let evalCalls = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        evalCalls++;
        if (evalCalls <= 2) {
          return {
            result: {
              value: {
                found: false,
                title: "请稍候…",
                bodyLength: 42,
                hasPassword: false,
              },
            },
          };
        }
        return {
          result: {
            value: {
              found: true,
            },
          },
        };
      }
      return {};
    },
  };

  await assert.rejects(
    waitForEditor(mockCdp, "session-1", chatgptAdapter, {
      timeoutMs: 900000,
      pollIntervalMs: 50,
      sleep: async () => {},
    }),
    (err) => {
      assert.equal(err.code, "HUMAN_VERIFICATION_REQUIRED");
      assert.equal(err.details?.challenge, true);
      assert.equal(err.details?.bodyLength, 42);
      assert.equal(err.title, "请稍候…");
      return true;
    }
  );

  assert.equal(evalCalls, 2, "Must throw after exactly 2 polls");
});

test("runCdpTurn: returns needs_human / login_required and skips typing when loggedOut is true", async () => {
  let typePromptCalled = false;
  let submitTurnCalled = false;

  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({
      userTurns: 0,
      answerTurns: 0,
      loggedOut: true,
      title: "ChatGPT",
    }),
    typePrompt: async () => {
      typePromptCalled = true;
    },
    submitTurn: async () => {
      submitTurnCalled = true;
    },
    waitForCompletion: async () => ({ status: "completed" }),
  };

  const res = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    deps: {
      recoverBrowser: async () => ({ action: "SAFE_START", chrome: { pid: 1234, port: 9222 } }),
      connectCdp: async () => ({
        send: async () => ({}),
        close: () => {},
      }),
      driver: mockDriver,
    },
  });

  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "login_required");
  assert.equal(res.evidence?.loggedOut, true);
  assert.equal(typePromptCalled, false, "typePrompt must never be called when loggedOut");
  assert.equal(submitTurnCalled, false, "submitTurn must never be called when loggedOut");
});

test("recovery cache keyed by mode: run with mode A, then mode B (triggers 2 recoveries), then mode B again (hits cache, 2 recoveries total)", async () => {
  let recoverCalls = 0;
  const mockRecover = async ({ mode }) => {
    recoverCalls++;
    return {
      action: "SAFE_START",
      chrome: { pid: 100 + recoverCalls, port: 9222 },
    };
  };

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: mockRecover,
      fetch: async () => ({ ok: true, status: 200 }),
      runCdpTurn: async () => ({ status: "completed", text: "done" }),
    },
  });

  // Call 1: mode A (background)
  await runner.run({ id: "turn-1", provider: "chatgpt", prompt: "p1", mode: "background" });
  assert.equal(recoverCalls, 1);

  // Call 2: mode B (visible) -> triggers 2nd recovery
  await runner.run({ id: "turn-2", provider: "chatgpt", prompt: "p2", mode: "visible" });
  assert.equal(recoverCalls, 2);

  // Call 3: mode B (visible) again -> hits cache, 2 recoveries total
  await runner.run({ id: "turn-3", provider: "chatgpt", prompt: "p3", mode: "visible" });
  assert.equal(recoverCalls, 2, "Same mode should hit the recovery cache");
});

test("runner.chrome becomes null when recovery has no Chrome", async () => {
  let hasChrome = true;
  const mockRecover = async () => {
    if (hasChrome) {
      return { action: "SAFE_START", chrome: { pid: 1234, port: 9222 } };
    }
    return { action: "RECOVERY_REQUIRED", reason: "chrome_launch_failed" };
  };

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: mockRecover,
      fetch: async () => (hasChrome ? { ok: true } : { ok: false }),
      runCdpTurn: async () => ({ status: "completed" }),
    },
  });

  await runner.run({ id: "turn-1", provider: "chatgpt", prompt: "p1" });
  assert.deepEqual(runner.chrome, { pid: 1234, port: 9222, mode: "background" });

  hasChrome = false;
  await runner.run({ id: "turn-2", provider: "chatgpt", prompt: "p2" });
  assert.equal(runner.chrome, null, "runner.chrome must be cleared to null when recovery has no Chrome");
});

test("cancel after submit carries sendCommittedAt: engine outcome and runner.run preserve it", async () => {
  let submitTurnCalled = false;
  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({ userTurns: 0, answerTurns: 0, loggedOut: false }),
    typePrompt: async () => {},
    submitTurn: async () => {
      submitTurnCalled = true;
    },
    waitForCompletion: async () => {
      const err = new Error("Generation cancelled");
      err.code = "CANCELLED";
      throw err;
    },
  };

  const engineRes = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    deps: {
      recoverBrowser: async () => ({ action: "SAFE_START", chrome: { pid: 1234, port: 9222 } }),
      connectCdp: async () => ({
        send: async () => ({}),
        close: () => {},
      }),
      driver: mockDriver,
    },
  });

  assert.equal(engineRes.status, "failed");
  assert.equal(engineRes.reason, "cancelled");
  assert.equal(submitTurnCalled, true);
  assert.ok(typeof engineRes.sendCommittedAt === "number" && engineRes.sendCommittedAt > 0);

  const runner = createCdpRunner({
    deps: {
      recoverBrowser: async () => ({ action: "SAFE_START", chrome: { pid: 1234, port: 9222 } }),
      fetch: async () => ({ ok: true }),
      runCdpTurn: async () => engineRes,
    },
  });

  const runnerRes = await runner.run({ id: "t1", provider: "chatgpt", prompt: "p" });
  assert.equal(runnerRes.status, "failed");
  assert.equal(runnerRes.reason, "cancelled");
  assert.equal(runnerRes.sendCommittedAt, engineRes.sendCommittedAt);
});
