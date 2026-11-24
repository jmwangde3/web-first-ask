import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCdpRunner } from "../src/broker/runner.js";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as conversationStore from "../src/browser/conversation-store.js";
import { runCdpTurn, isSameProviderConversationUrl } from "../src/engines/cdp-engine.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { classifyRunError } from "../src/browser/driver.js";

const CHATGPT_URL = "https://chatgpt.com/c/thread-123";
const CHATGPT_NEW_URL = "https://chatgpt.com/c/thread-456";

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cdp-conversation-"));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function createEngineDeps({
  actualUrls = [CHATGPT_URL],
  completion = {
    status: "completed",
    reason: "completed",
    text: "answer",
    evidence: {},
  },
  initialState = {
    userTurns: 0,
    answerTurns: 0,
    answerText: "",
    stopVisible: false,
    editorEmpty: true,
    loggedOut: false,
    pageError: null,
  },
  conversationStore: store = conversationStore,
  adapters = null,
  openUrls = [],
  closedTargets = [],
  evalResults = [],
  counters = {},
} = {}) {
  let urlIndex = 0;
  let targetIndex = 0;
  let evalIndex = 0;
  const cdp = {
    send: async (method, params = {}) => {
      if (method === "Runtime.evaluate") {
        const expression = params?.expression || "";
        // 会话清理脚本：按 evalResults 顺序返回，默认成功
        if (/menuitem|Delete|删除/.test(expression)) {
          if (evalResults.length > 0) {
            const res = evalResults[Math.min(evalIndex, evalResults.length - 1)];
            evalIndex += 1;
            return { result: { value: res } };
          }
          return { result: { value: { success: true } } };
        }
        const index = Math.min(urlIndex, actualUrls.length - 1);
        const value = actualUrls[index] ?? "";
        urlIndex += 1;
        return { result: { value } };
      }
      if (method === "Target.closeTarget") {
        closedTargets.push(params.targetId);
        return { success: true };
      }
      return {};
    },
    close() {},
  };

  return {
    conversationStore: store,
    ...(adapters ? { adapters } : {}),
    enforceCooldown: async () => {},
    recordLastTurn: async () => {},
    // 并发锁与人类节奏在单测中旁路（三方裁决：测试默认关闭，保持毫秒级）
    skipTurnLock: true,
    pace: async () => 0,
    recoverBrowser: async () => ({
      action: "ADOPT",
      chrome: { pid: 1234, port: 9222 },
    }),
    connectCdp: async () => cdp,
    driver: {
      openTab: async (_cdp, url) => {
        openUrls.push(url);
        targetIndex += 1;
        return {
          targetId: `target-${targetIndex}`,
          sessionId: `session-${targetIndex}`,
        };
      },
      waitForEditor: async () => true,
      readTurnState: async () => initialState,
      typePrompt: async (_cdp, _sessionId, _adapter, prompt) => {
        counters.typed = (counters.typed || 0) + 1;
        return { typedChars: prompt.length, replacedChars: 0 };
      },
      submitTurn: async () => {
        counters.submitted = (counters.submitted || 0) + 1;
        return { submittedAt: Date.now() };
      },
      waitForCompletion: async () => completion,
    },
  };
}

async function runEngine(home, conversationId, deps, extra = {}) {
  return runCdpTurn({
    provider: "chatgpt",
    prompt: "continue this conversation",
    home,
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...extra,
    deps,
  });
}

test("first turn opens the provider home; the next turn restores the stored conversation URL", async () => {
  await withHome(async (home) => {
    const firstOpenUrls = [];
    const first = await runEngine(
      home,
      "logical-thread",
      createEngineDeps({ actualUrls: [CHATGPT_URL], openUrls: firstOpenUrls })
    );

    assert.equal(first.status, "completed");
    assert.equal(firstOpenUrls[0], chatgptAdapter.url);

    const firstSession = await conversationStore.loadSession(home, "chatgpt", "logical-thread");
    assert.equal(firstSession.conversationUrl, CHATGPT_URL);
    assert.equal(firstSession.turnCount, 1);

    const secondOpenUrls = [];
    const second = await runEngine(
      home,
      "logical-thread",
      createEngineDeps({
        actualUrls: [CHATGPT_URL, CHATGPT_URL],
        openUrls: secondOpenUrls,
      })
    );

    assert.equal(second.status, "completed");
    assert.deepEqual(secondOpenUrls, [CHATGPT_URL]);

    const secondSession = await conversationStore.loadSession(home, "chatgpt", "logical-thread");
    assert.equal(secondSession.turnCount, 2);
  });
});

test("a restored URL redirected to the provider home is invalidated without submitting a prompt", async () => {
  await withHome(async (home) => {
    await conversationStore.saveSession(home, "chatgpt", "redirect-thread", {
      conversationUrl: CHATGPT_URL,
      turnCount: 4,
    });

    const openUrls = [];
    const counters = {};
    const result = await runEngine(
      home,
      "redirect-thread",
      createEngineDeps({
        actualUrls: ["https://chatgpt.com/"],
        openUrls,
        counters,
      })
    );

    assert.equal(result.status, "needs_human");
    assert.equal(result.reason, "conversation_restore_failed");
    assert.deepEqual(openUrls, [CHATGPT_URL]);
    assert.equal(counters.typed || 0, 0);
    assert.equal(counters.submitted || 0, 0);

    const session = await conversationStore.loadSession(home, "chatgpt", "redirect-thread");
    assert.equal(session.invalidated, true);
    assert.equal(session.invalidatedReason, "conversation_restore_failed");
  });
});

test("a restored conversation that remains blank when editor loading fails is invalidated", async () => {
  await withHome(async (home) => {
    await conversationStore.saveSession(home, "chatgpt", "blank-thread", {
      conversationUrl: CHATGPT_URL,
      turnCount: 2,
    });

    const openUrls = [];
    const counters = {};
    const deps = createEngineDeps({
      actualUrls: ["about:blank"],
      openUrls,
      counters,
    });
    deps.driver.waitForEditor = async () => {
      throw new Error("Editor not found within timeout");
    };

    const result = await runEngine(home, "blank-thread", deps);

    assert.equal(result.status, "needs_human");
    assert.equal(result.reason, "conversation_restore_failed");
    assert.deepEqual(openUrls, [CHATGPT_URL]);
    assert.equal(counters.typed || 0, 0);

    const session = await conversationStore.loadSession(home, "chatgpt", "blank-thread");
    assert.equal(session.invalidated, true);
  });
});

test("the fortieth completed turn includes the conversation warning evidence", async () => {
  await withHome(async (home) => {
    await conversationStore.saveSession(home, "chatgpt", "long-thread", {
      conversationUrl: CHATGPT_URL,
      turnCount: 39,
    });

    const result = await runEngine(
      home,
      "long-thread",
      createEngineDeps({ actualUrls: [CHATGPT_URL, CHATGPT_URL] })
    );

    assert.equal(result.status, "completed");
    assert.equal(result.evidence.conversationTurns, 40);
    assert.equal(result.evidence.conversationWarning, "CONVERSATION_40_TURNS");
    const session = await conversationStore.loadSession(home, "chatgpt", "long-thread");
    assert.equal(session.turnCount, 40);
  });
});

test("context invalidation marks the session; the next turn starts from the provider home", async () => {
  await withHome(async (home) => {
    await conversationStore.saveSession(home, "chatgpt", "invalid-thread", {
      conversationUrl: CHATGPT_URL,
      turnCount: 7,
    });

    const failed = await runEngine(
      home,
      "invalid-thread",
      createEngineDeps({
        actualUrls: [CHATGPT_URL, CHATGPT_URL],
        completion: {
          status: "needs_human",
          reason: "provider_error",
          text: "",
          evidence: {
            pageError: {
              reason: "provider_error",
              message: "Maximum context length exceeded",
            },
          },
        },
      })
    );

    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "conversation_invalidated");

    const invalidated = await conversationStore.loadSession(home, "chatgpt", "invalid-thread");
    assert.equal(invalidated.invalidated, true);
    assert.equal(invalidated.invalidatedReason, "conversation_invalidated");
    assert.equal(invalidated.turnCount, 7);

    const nextOpenUrls = [];
    const next = await runEngine(
      home,
      "invalid-thread",
      createEngineDeps({
        actualUrls: [CHATGPT_NEW_URL],
        adapters: {
          chatgpt: {
            ...chatgptAdapter,
            buildDeleteConversationJs: () => "/* menuitem mock delete */",
          },
        },
        openUrls: nextOpenUrls,
      })
    );

    assert.equal(next.status, "completed");
    // 新会话从 provider 首页打开；旧会话会被独立 tab 打开用于清理
    assert.equal(nextOpenUrls[0], chatgptAdapter.url);
    assert.ok(nextOpenUrls.includes(CHATGPT_URL));
    assert.equal(next.evidence?.sessionCleanup?.status, "deleted");
    const renewed = await conversationStore.loadSession(home, "chatgpt", "invalid-thread");
    assert.equal(renewed.invalidated, false);
    assert.equal(renewed.conversationUrl, CHATGPT_NEW_URL);
    assert.equal(renewed.turnCount, 8);
  });
});

test("conversation-store write failures are recorded without changing a completed turn", async () => {
  const errors = [];
  const store = {
    loadSession: async () => null,
    saveSession: async () => { throw new Error("disk unavailable"); },
    markInvalid: async () => {},
  };
  const deps = createEngineDeps({
    actualUrls: [CHATGPT_URL],
    conversationStore: store,
  });
  deps.onConversationStoreError = (operation, error) => {
    errors.push({ operation, message: error.message });
  };
  const result = await runEngine(
    "/tmp/wfa-conversation-store-failure",
    "store-failure-thread",
    deps
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(errors, [{ operation: "saveSession", message: "disk unavailable" }]);
});

test("without conversationId the engine keeps opening the provider home and does not touch the store", async () => {
  const openUrls = [];
  let storeCalls = 0;
  const store = {
    loadSession: async () => { storeCalls += 1; throw new Error("unexpected load"); },
    saveSession: async () => { storeCalls += 1; throw new Error("unexpected save"); },
    markInvalid: async () => { storeCalls += 1; throw new Error("unexpected invalidation"); },
  };

  const result = await runEngine(
    "/tmp/wfa-no-conversation-id",
    undefined,
    createEngineDeps({
      actualUrls: [CHATGPT_URL],
      conversationStore: store,
      openUrls,
    })
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(openUrls, [chatgptAdapter.url]);
  assert.equal(storeCalls, 0);
});

test("parallel turns with different conversationIds persist independent session records", async () => {
  await withHome(async (home) => {
    await Promise.all([
      runEngine(
        home,
        "parallel-thread-a",
        createEngineDeps({ actualUrls: ["https://chatgpt.com/c/parallel-a"] })
      ),
      runEngine(
        home,
        "parallel-thread-b",
        createEngineDeps({ actualUrls: ["https://chatgpt.com/c/parallel-b"] })
      ),
    ]);

    const [a, b] = await Promise.all([
      conversationStore.loadSession(home, "chatgpt", "parallel-thread-a"),
      conversationStore.loadSession(home, "chatgpt", "parallel-thread-b"),
    ]);
    assert.equal(a.conversationUrl, "https://chatgpt.com/c/parallel-a");
    assert.equal(b.conversationUrl, "https://chatgpt.com/c/parallel-b");
  });
});

test("broker runner forwards a non-empty conversationId and omits an empty one", async () => {
  const captured = [];
  const runner = createCdpRunner({
    home: "/tmp/wfa-runner-conversation-forwarding",
    deps: {
      recoverBrowser: async () => ({
        action: "ADOPT",
        chrome: { pid: 9876, port: 9222 },
      }),
      isPidAlive: () => true,
      fetch: async () => ({ ok: true }),
      runCdpTurn: async (args) => {
        captured.push(args);
        return { status: "completed", text: "ok" };
      },
    },
  });

  await runner.run({
    id: "turn-with-conversation",
    provider: "chatgpt",
    prompt: "hello",
    conversationId: "conversation-abc",
  });
  await runner.run({
    id: "turn-without-conversation",
    provider: "gemini",
    prompt: "hello",
    conversationId: "  ",
  });

  assert.equal(captured[0].conversationId, "conversation-abc");
  assert.equal(Object.hasOwn(captured[1], "conversationId"), false);
});

test("cdp CLI writes the forty-turn warning to stderr", async () => {
  const stdout = { output: "", write(value) { this.output += value; } };
  const stderr = { output: "", write(value) { this.output += value; } };

  const result = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "hello", "--conversation-id", "cli-thread"],
    {
      stdout,
      stderr,
      home: "/tmp/wfa-cdp-cli-conversation-warning",
      ensureBroker: async () => ({ host: "127.0.0.1", port: 43210, token: "test-token" }),
      createTurn: async () => ({ status: 202, json: { id: "turn-40" } }),
      waitForTurn: async () => ({
        id: "turn-40",
        provider: "chatgpt",
        state: "completed",
        text: "answer",
        evidence: {
          conversationTurns: 40,
          conversationWarning: "CONVERSATION_40_TURNS",
        },
        createdAt: "2026-11-23T00:00:00.000Z",
        startedAt: "2026-11-23T00:00:00.000Z",
        finishedAt: "2026-11-23T00:00:01.000Z",
      }),
    }
  );

  assert.equal(result.code, 0);
  assert.match(stderr.output, /CONVERSATION_40_TURNS/);
  assert.match(stderr.output, /40 turns/);
});


test("driver classifies expired conversations and context-limit errors", () => {
  for (const message of [
    "conversation not found",
    "chat not found",
    "context length exceeded",
    "maximum context reached",
    "对话不存在",
    "上下文过长",
    "会话已失效",
  ]) {
    const classified = classifyRunError(new Error(message));
    assert.equal(classified.state, "failed", message);
    assert.equal(classified.code, "CONVERSATION_INVALIDATED", message);
  }
});

test("successful conversation restore does not trigger cleanup", async () => {
  await withHome(async (home) => {
    await conversationStore.saveSession(home, "chatgpt", "thread-ok", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      invalidated: false,
    });

    const openUrls = [];
    const deps = createEngineDeps({
      actualUrls: [CHATGPT_URL, CHATGPT_URL],
      openUrls,
    });

    const result = await runEngine(home, "thread-ok", deps);
    assert.equal(result.status, "completed");
    assert.deepEqual(openUrls, [CHATGPT_URL]);
    assert.equal(result.evidence.sessionCleanup, undefined);
  });
});

test("when conversation is invalidated and new session starts, old cloud session is cleaned up", async () => {
  await withHome(async (home) => {
    await conversationStore.saveSession(home, "chatgpt", "thread-inv", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      invalidated: true,
      invalidatedReason: "conversation_restore_failed",
    });

    const openUrls = [];
    const closedTargets = [];
    const deps = createEngineDeps({
      actualUrls: [CHATGPT_NEW_URL],
      evalResults: [{ success: true }],
      adapters: {
        chatgpt: {
          ...chatgptAdapter,
          buildDeleteConversationJs: () => "/* menuitem mock delete */",
        },
      },
      openUrls,
      closedTargets,
    });

    const result = await runEngine(home, "thread-inv", deps);
    assert.equal(result.status, "completed");
    assert.equal(result.conversationUrl, CHATGPT_NEW_URL);
    assert.deepEqual(openUrls, [chatgptAdapter.url, CHATGPT_URL]);
    assert.ok(closedTargets.includes("target-2"));
    assert.equal(result.evidence.sessionCleanup?.status, "deleted");
    assert.equal(result.evidence.sessionCleanup?.url, CHATGPT_URL);

    const updated = await conversationStore.loadSession(home, "chatgpt", "thread-inv");
    assert.equal(updated.conversationUrl, CHATGPT_NEW_URL);
    const retired = updated.retired.find((r) => r.conversationUrl === CHATGPT_URL);
    assert.ok(retired);
    assert.equal(retired.cleanupStatus, "deleted");
  });
});

test("cleanup failure does not affect turn completion status", async () => {
  await withHome(async (home) => {
    await conversationStore.saveSession(home, "chatgpt", "thread-fail", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      invalidated: true,
    });

    const openUrls = [];
    const deps = createEngineDeps({
      actualUrls: [chatgptAdapter.url, CHATGPT_NEW_URL],
      evalResults: [{ success: false, reason: "menu_button_not_found" }],
      adapters: {
        chatgpt: {
          ...chatgptAdapter,
          buildDeleteConversationJs: () => "/* menuitem mock delete */",
        },
      },
      openUrls,
    });

    const result = await runEngine(home, "thread-fail", deps);
    assert.equal(result.status, "completed");
    assert.equal(result.evidence.sessionCleanup?.status, "failed");
    assert.equal(result.evidence.sessionCleanup?.reason, "menu_button_not_found");
  });
});

test("aborted signal skips cleanup execution", async () => {
  await withHome(async (home) => {
    await conversationStore.saveSession(home, "chatgpt", "thread-abort", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      invalidated: true,
    });

    const controller = new AbortController();
    const openUrls = [];
    const deps = createEngineDeps({
      actualUrls: [chatgptAdapter.url],
      openUrls,
    });

    controller.abort();
    const result = await runEngine(home, "thread-abort", deps, { signal: controller.signal });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "cancelled");
    assert.equal(openUrls.length, 0);
  });
});

test("no conversationId does not trigger cleanup", async () => {
  await withHome(async (home) => {
    const openUrls = [];
    const deps = createEngineDeps({
      actualUrls: [chatgptAdapter.url, CHATGPT_URL],
      openUrls,
    });

    const result = await runEngine(home, undefined, deps);
    assert.equal(result.status, "completed");
    assert.deepEqual(openUrls, [chatgptAdapter.url]);
    assert.equal(result.evidence.sessionCleanup, undefined);
  });
});

test("isSameProviderConversationUrl: only same https host is accepted", () => {
  assert.equal(isSameProviderConversationUrl("https://chatgpt.com/", "https://chatgpt.com/c/x"), true);
  assert.equal(isSameProviderConversationUrl("https://gemini.google.com/app", "https://gemini.google.com/app/x"), true);
  assert.equal(isSameProviderConversationUrl("https://chatgpt.com/", "https://evil.example.com/c/x"), false);
  assert.equal(isSameProviderConversationUrl("https://chatgpt.com/", "http://chatgpt.com/c/x"), false);
  assert.equal(isSameProviderConversationUrl("https://chatgpt.com/", "not-a-url"), false);
  assert.equal(isSameProviderConversationUrl(undefined, "https://chatgpt.com/c/x"), false);
});
