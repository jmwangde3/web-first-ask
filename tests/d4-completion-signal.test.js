import assert from "node:assert/strict";
import test from "node:test";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { readTurnState, waitForCompletion } from "../src/browser/driver.js";

function createStateCdp(getState) {
  return {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify(getState()),
          },
        };
      }
      return {};
    },
  };
}

function makeGeminiDom({ hasActions = false, actionsVisible = true, pendingNodes = 0, text = "Hello world" } = {}) {
  const actionsEl = hasActions
    ? { getBoundingClientRect: () => ({ width: actionsVisible ? 80 : 0, height: actionsVisible ? 24 : 0 }) }
    : null;
  const lastModelEl = {
    querySelector(selector) {
      if (selector === "message-actions") return actionsEl;
      if (selector.includes("message-content")) return { innerText: text, querySelectorAll: () => [] };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "span.pending, p.pending") {
        return Array.from({ length: pendingNodes }, () => ({}));
      }
      return [];
    },
  };
  return {
    title: "Google Gemini",
    querySelectorAll(selector) {
      if (selector === "user-query") return [{}];
      if (selector === "model-response") return [lastModelEl];
      return [];
    },
    querySelector(selector) {
      if (selector.includes("rich-textarea") || selector.includes("ql-editor")) {
        return { innerText: "" };
      }
      if (selector.includes("Google 账号") || selector.includes("SignOutOptions")) {
        return { nodeName: "BUTTON" };
      }
      return null;
    },
  };
}

test("gemini adapter: message-actions 缺失时 pending>0 返回 false，否则返回 null，并回传 pendingCount", () => {
  const evalState = (doc) => {
    const fn = new Function("document", "window", "return " + geminiAdapter.buildReadStateJs());
    return JSON.parse(fn(doc, {}));
  };

  const withPending = evalState(makeGeminiDom({ hasActions: false, pendingNodes: 3 }));
  assert.equal(withPending.answerActionsVisible, false);
  assert.equal(withPending.pendingCount, 3);

  const withoutPending = evalState(makeGeminiDom({ hasActions: false, pendingNodes: 0 }));
  assert.equal(withoutPending.answerActionsVisible, null);
  assert.equal(withoutPending.pendingCount, 0);

  const withActions = evalState(makeGeminiDom({ hasActions: true, actionsVisible: true, pendingNodes: 0 }));
  assert.equal(withActions.answerActionsVisible, true);
  assert.equal(withActions.pendingCount, 0);
});

test("readTurnState: 解析 pendingCount 并在缺省时兜底为 0", async () => {
  const withCount = await readTurnState(
    createStateCdp(() => ({ userTurns: 1, answerTurns: 1, answerText: "hi", answerActionsVisible: false, pendingCount: 7 })),
    "s1",
    geminiAdapter,
  );
  assert.equal(withCount.pendingCount, 7);

  const missingCount = await readTurnState(
    createStateCdp(() => ({ userTurns: 1, answerTurns: 1, answerText: "hi", answerActionsVisible: null })),
    "s1",
    geminiAdapter,
  );
  assert.equal(missingCount.pendingCount, 0);
});

test("gemini pending 存在时不得 completed", async () => {
  let virtualTime = 0;
  const fixedText = "Fixed 23 chars answer!!";
  assert.equal(fixedText.length, 23);

  const mockCdp = createStateCdp(() => ({
    userTurns: 1,
    answerTurns: 1,
    answerText: fixedText,
    answerActionsVisible: null,
    pendingCount: Math.min(198, 18 + Math.floor(virtualTime / 500)),
    stopVisible: virtualTime < 5000,
    editorEmpty: true,
    title: "Google Gemini",
  }));

  const res = await waitForCompletion(mockCdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    stallTimeoutMs: 180000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.notEqual(res.status, "completed");
  assert.equal(res.status, "stalled");
  assert.equal(res.reason, "no_progress");
  assert.ok(res.elapsedMs >= 180000);
});

test("gemini pending 冻结后 180s 退出 stalled", async () => {
  let virtualTime = 0;
  const fixedText = "Fixed 23 chars answer!!";

  const mockCdp = createStateCdp(() => ({
    userTurns: 1,
    answerTurns: 1,
    answerText: fixedText,
    answerActionsVisible: null,
    pendingCount: 198,
    stopVisible: virtualTime < 5000,
    editorEmpty: true,
    title: "Google Gemini",
  }));

  const res = await waitForCompletion(mockCdp, "session-2", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    stallTimeoutMs: 180000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "stalled");
  assert.equal(res.reason, "no_progress");
  assert.equal(res.elapsedMs, 180000);
});

test("gemini pending 清零后正常完成", async () => {
  let virtualTime = 0;
  const answer = "Complete Gemini response text";

  const mockCdp = createStateCdp(() => ({
    userTurns: 1,
    answerTurns: 1,
    answerText: answer,
    answerActionsVisible: null,
    pendingCount: virtualTime < 10000 ? 18 : 0,
    stopVisible: false,
    editorEmpty: true,
    title: "Google Gemini",
  }));

  const res = await waitForCompletion(mockCdp, "session-3", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    stallTimeoutMs: 180000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.reason, "completed");
  assert.equal(res.text, answer);
  assert.ok(res.elapsedMs >= 10000 && res.elapsedMs <= 14000);
});

test("gemini 快回答（事实 M）", async () => {
  let virtualTime = 0;
  const quickText = "Quick 15 chars!";
  assert.equal(quickText.length, 15);

  const mockCdp = createStateCdp(() => ({
    userTurns: 1,
    answerTurns: 1,
    answerText: quickText,
    answerActionsVisible: null,
    pendingCount: 0,
    stopVisible: false,
    editorEmpty: true,
    title: "Google Gemini",
  }));

  const res = await waitForCompletion(mockCdp, "session-4", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    stallTimeoutMs: 180000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.reason, "completed");
  assert.equal(res.text, quickText);
  assert.equal(res.elapsedMs, 4000);
});

test("gemini pending 变化刷新 stall 计时", async () => {
  let virtualTime = 0;
  const seenTimes = [];
  const fixedText = "Fixed 23 chars answer!!";

  const mockCdp = createStateCdp(() => {
    seenTimes.push(virtualTime);
    let pendingCount = 201;
    if (virtualTime < 60000) pendingCount = 198;
    else if (virtualTime < 120000) pendingCount = 199;
    else if (virtualTime < 180000) pendingCount = 200;
    return {
      userTurns: 1,
      answerTurns: 1,
      answerText: fixedText,
      answerActionsVisible: null,
      pendingCount,
      stopVisible: false,
      editorEmpty: true,
      title: "Google Gemini",
    };
  });

  const res = await waitForCompletion(mockCdp, "session-5", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    stallTimeoutMs: 180000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.ok(seenTimes.includes(180000));
  assert.equal(res.status, "stalled");
  assert.equal(res.reason, "no_progress");
  assert.equal(res.elapsedMs, 360000);
});

test("chatgpt 行为零变化", async () => {
  let virtualTime = 0;
  const answer = "ChatGPT final answer";

  const mockCdp = createStateCdp(() => ({
    userTurns: 1,
    answerTurns: 1,
    answerText: answer,
    answerActionsVisible: virtualTime >= 4000,
    pendingCount: virtualTime < 3000 ? 5 : 12,
    stopVisible: true,
    editorEmpty: true,
    title: "ChatGPT",
  }));

  const res = await waitForCompletion(mockCdp, "session-6", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    stallTimeoutMs: 180000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.deepEqual(Object.keys(res), ["status", "reason", "text", "elapsedMs", "evidence"]);
  assert.deepEqual(Object.keys(res.evidence), [
    "userTurns",
    "answerTurns",
    "answerChars",
    "stopVisible",
    "editorEmpty",
    "title",
    "pageError",
    "lastProgressAgoMs",
    "stopVisibleForMs",
    "stopSignalDegraded",
  ]);
  assert.equal(res.status, "completed");
  assert.equal(res.reason, "completed");
  assert.equal(res.text, answer);
  assert.equal(res.elapsedMs, 4000);
  assert.equal(res.evidence.answerChars, answer.length);
  assert.equal(res.evidence.stopVisible, true);
  assert.equal(res.evidence.lastProgressAgoMs, 4000);
  assert.equal(res.evidence.stopVisibleForMs, 4000);
  assert.equal(res.evidence.stopSignalDegraded, false);
});

test("G3 R2: 长思考正文冻结 5 分钟后恢复增长并出现完成信号 -> completed 且正文完整", async () => {
  let virtualTime = 0;
  const fullAnswer = "Initial thinking chunk...\nComplete long-thinking answer after 5 minutes!";

  const mockCdp = createStateCdp(() => {
    const resumed = virtualTime >= 300000;
    const done = virtualTime >= 305000;
    const answerText = done
      ? fullAnswer
      : (resumed ? "Initial thinking chunk...\nResuming..." : "Initial thinking chunk...");
    return {
      userTurns: 1,
      answerTurns: 1,
      answerText,
      answerActionsVisible: done,
      pendingCount: 0,
      stopVisible: !done,
      editorEmpty: true,
      title: "ChatGPT",
    };
  });

  const res = await waitForCompletion(mockCdp, "session-long-think", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    pollIntervalMs: 1000,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.reason, "completed");
  assert.equal(res.text, fullAnswer);
  assert.equal(res.elapsedMs, 309000);
});

test("G3 R2: 永久断流正文与 pending 都不动，达到超时前退出 stalled 且不无限挂起", async () => {
  let virtualTime = 0;

  const mockCdp = createStateCdp(() => ({
    userTurns: 1,
    answerTurns: 1,
    answerText: "Frozen partial stream",
    answerActionsVisible: null,
    pendingCount: 12,
    stopVisible: false,
    editorEmpty: true,
    title: "Google Gemini",
  }));

  const res = await waitForCompletion(mockCdp, "session-perm-stall", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    pollIntervalMs: 1000,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "stalled");
  assert.equal(res.reason, "no_progress");
  assert.equal(res.elapsedMs, 420000);
  assert.ok(res.elapsedMs <= 900000);
});
