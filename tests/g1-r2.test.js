import assert from "node:assert/strict";
import test from "node:test";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import { waitForComposerReady, waitForCompletion } from "../src/browser/driver.js";
import { runCdpTurn } from "../src/engines/cdp-engine.js";

const DOM_NODE = {
  DOCUMENT_POSITION_DISCONNECTED: 1,
  DOCUMENT_POSITION_FOLLOWING: 4,
};

function makeBody(text, codeBlocks = []) {
  return {
    innerText: text,
    textContent: text,
    querySelectorAll(selector) {
      return selector === "pre, code-block, code[class*=block]" ? codeBlocks : [];
    },
  };
}

function makeArticle(bodyNodes) {
  return {
    querySelectorAll(selector) {
      if (selector === "[data-message-content]") return [];
      if (selector === ".markdown") return bodyNodes;
      if (selector === ".prose") return [];
      return [];
    },
  };
}

function makeChatGptDocument(messages, { actions = true } = {}) {
  const userArticle = {};
  const assistantArticles = messages.map((message) => makeArticle(
    message.bodyNodes || [makeBody(message.text, message.codeBlocks || [])]
  ));
  const assistantHeaders = messages.map(() => ({
    innerText: "ChatGPT said:",
    compareDocumentPosition: () => 0,
  }));
  const lastHeader = assistantHeaders[assistantHeaders.length - 1];
  if (lastHeader) {
    lastHeader.compareDocumentPosition = () => actions ? DOM_NODE.DOCUMENT_POSITION_FOLLOWING : 0;
  }
  const actionContainer = { querySelector: () => ({}) };
  const editor = { innerText: "", isContentEditable: true };

  return {
    title: "ChatGPT conversation",
    querySelectorAll(selector) {
      if (selector === "h4") return [{ innerText: "You said:" }, ...assistantHeaders];
      if (selector === 'article[data-message-author-role="user"]') return [userArticle];
      if (selector === 'article[data-message-author-role="assistant"]') return assistantArticles;
      if (selector === ".turn-action-controls") return actions ? [actionContainer] : [];
      if (selector === 'button[data-testid="copy-turn-action-button"]') return [];
      return [];
    },
    querySelector(selector) {
      if (selector.includes("ProseMirror")) return editor;
      return null;
    },
  };
}

function evaluateAdapter(code, document) {
  return new Function("document", "window", "Node", `return ${code}`)(document, {}, DOM_NODE);
}

test("G1 R2 ChatGPT extraction takes the final full assistant message, not shrinking h4 siblings", () => {
  const expected = "F".repeat(818);
  const document = makeChatGptDocument([
    { text: "A".repeat(43) },
    { text: "B".repeat(4) },
    { text: expected },
  ]);

  const state = JSON.parse(evaluateAdapter(chatgptAdapter.buildReadStateJs(), document));
  assert.equal(state.answerText, expected);
  assert.equal(state.answerText.length, 818);
  assert.equal(state.answerActionsVisible, true);
  assert.equal(evaluateAdapter(chatgptAdapter.buildAnswerTextJs(), document), expected);
});

test("G1 R2 ChatGPT extraction never falls back to a user message", () => {
  const document = makeChatGptDocument([]);
  const state = JSON.parse(evaluateAdapter(chatgptAdapter.buildReadStateJs(), document));
  assert.equal(state.answerText, "");
  assert.equal(evaluateAdapter(chatgptAdapter.buildAnswerTextJs(), document), "");
});

test("G1 R2 ChatGPT extraction excludes commentary/thinking before the final answer", () => {
  const document = makeChatGptDocument([{
    bodyNodes: [
      makeBody("Thought for 3 seconds"),
      makeBody("The official final answer."),
    ],
  }]);

  const state = JSON.parse(evaluateAdapter(chatgptAdapter.buildReadStateJs(), document));
  assert.equal(state.answerText, "The official final answer.");
  assert.equal(state.answerText.includes("Thought for 3 seconds"), false);
});

test("G1 R2 ChatGPT code fences retain the existing pre/code-block reconstruction", () => {
  const code = "const value = 1;";
  const document = makeChatGptDocument([{
    text: `Example\nJavaScript\n${code}`,
    codeBlocks: [{ innerText: code, textContent: code, parentElement: null }],
  }]);

  const state = JSON.parse(evaluateAdapter(chatgptAdapter.buildReadStateJs(), document));
  assert.equal(state.answerText, `Example\n\`\`\`\n${code}\n\`\`\``);
  assert.equal(evaluateAdapter(chatgptAdapter.buildAnswerTextJs(), document), `Example\nJavaScript\n${code}`);
});

function makeEditor({
  editable = true,
  visible = true,
  innerText = "",
  rect = visible ? { width: 320, height: 48 } : { width: 0, height: 0 },
} = {}) {
  return {
    tagName: "DIV",
    isConnected: true,
    isContentEditable: editable,
    disabled: false,
    readOnly: false,
    innerText,
    getAttribute(name) {
      return name === "contenteditable" ? (editable ? "true" : "false") : null;
    },
    getBoundingClientRect() {
      return rect;
    },
  };
}

function makeStopButton({
  disabled = false,
  ariaDisabled = null,
  rect = { width: 32, height: 32 },
  isConnected = true,
} = {}) {
  return {
    isConnected,
    disabled,
    getAttribute: (name) => (name === "aria-disabled" ? ariaDisabled : null),
    getBoundingClientRect: () => rect,
  };
}

function makeComposerCdp({
  getEditor = () => makeEditor(),
  getStopElements = () => [],
  computedStyle = { display: "block", visibility: "visible", opacity: "1" },
} = {}) {
  const document = {
    querySelector(selector) {
      assert.equal(selector, chatgptAdapter.editorSelector);
      return getEditor();
    },
    querySelectorAll(selector) {
      assert.equal(selector, chatgptAdapter.stopSelector);
      return getStopElements();
    },
  };
  const window = {
    getComputedStyle: () => computedStyle,
  };
  return {
    async send(method, params) {
      assert.equal(method, "Runtime.evaluate");
      const value = new Function("document", "window", `return ${params.expression}`)(document, window);
      return { result: { value } };
    },
  };
}

test("G1 R2 composer pre-gate is ready when editor is editable and visible with no stop control", async () => {
  const cdp = makeComposerCdp({
    getEditor: () => makeEditor({ innerText: "  hello  " }),
    getStopElements: () => [],
  });
  let virtualTime = 0;

  const result = await waitForComposerReady(cdp, "session-1", chatgptAdapter, {
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.editorFound, true);
  assert.equal(result.editorEditable, true);
  assert.equal(result.editorVisible, true);
  assert.equal(result.editorChars, 5);
  assert.equal(result.stopActive, false);
  assert.equal(result.stopMatched, false);
  assert.equal("sendFound" in result, false);
  assert.equal("sendReady" in result, false);
});

test("G1 R2 composer pre-gate treats 0x0 active stop control as blocking and times out with composer_stop_state", async () => {
  const zeroRectStop = makeStopButton({
    disabled: false,
    ariaDisabled: null,
    rect: { width: 0, height: 0 },
  });
  const cdp = makeComposerCdp({
    getEditor: () => makeEditor({ innerText: "" }),
    getStopElements: () => [zeroRectStop],
  });
  let virtualTime = 0;

  const result = await waitForComposerReady(cdp, "session-1", chatgptAdapter, {
    timeoutMs: 25,
    pollIntervalMs: 10,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "composer_stop_state");
  assert.equal(result.ready, false);
  assert.equal(result.editorEditable, true);
  assert.equal(result.editorVisible, true);
  assert.equal(result.editorChars, 0);
  assert.equal(result.stopActive, true);
  assert.equal(result.stopMatched, true);
});

test("G1 R2 composer pre-gate treats aria-disabled=true or disabled=true stop controls as inactive", async () => {
  for (const stopBtn of [
    makeStopButton({ disabled: false, ariaDisabled: "true" }),
    makeStopButton({ disabled: true, ariaDisabled: null }),
  ]) {
    const cdp = makeComposerCdp({
      getEditor: () => makeEditor(),
      getStopElements: () => [stopBtn],
    });
    let virtualTime = 0;

    const result = await waitForComposerReady(cdp, "session-1", chatgptAdapter, {
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(result.ready, true);
    assert.equal(result.stopActive, false);
    assert.equal(result.stopMatched, false);
  }
});

test("G1 R2 composer pre-gate blocks 0x0 editor and times out with composer_not_ready_timeout when no stop is active", async () => {
  const cdp = makeComposerCdp({
    getEditor: () => makeEditor({ visible: false, rect: { width: 0, height: 0 } }),
    getStopElements: () => [],
  });
  let virtualTime = 0;

  const result = await waitForComposerReady(cdp, "session-1", chatgptAdapter, {
    timeoutMs: 25,
    pollIntervalMs: 10,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "composer_not_ready_timeout");
  assert.equal(result.ready, false);
  assert.equal(result.editorFound, true);
  assert.equal(result.editorEditable, true);
  assert.equal(result.editorVisible, false);
  assert.equal(result.stopActive, false);
  assert.equal(result.stopMatched, false);
});

test("G1 R2 engine returns needs_human before typePrompt when composer readiness times out", async () => {
  const events = [];
  const cdp = { async send() { return {}; }, close() {} };
  const result = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Do not type while the provider is still generating",
    mode: "background",
    minIntervalMs: 0,
    deps: {
      skipTurnLock: true,
      enforceCooldown: async () => {},
      recordLastTurn: async () => {},
      withSendSlot: async (_provider, fn) => fn(),
      pace: async () => {},
      recoverBrowser: async ({ mode }) => {
        assert.equal(mode, "background");
        return { action: "ADOPT", chrome: { pid: 123, port: 9222 } };
      },
      connectCdp: async () => cdp,
      driver: {
        openTab: async () => ({ targetId: "work-target", sessionId: "work-session" }),
        waitForEditor: async () => true,
        readTurnState: async () => ({
          userTurns: 0,
          answerTurns: 0,
          answerText: "",
          answerActionsVisible: null,
          stopVisible: true,
          editorEmpty: true,
          loggedOut: false,
          pageError: null,
        }),
        waitForComposerReady: async () => {
          events.push("composer-gate");
          return {
            ok: false,
            status: "needs_human",
            reason: "composer_stop_state",
            ready: false,
            editorFound: true,
            editorEditable: true,
            editorVisible: true,
            editorChars: 0,
            stopActive: true,
            stopMatched: true,
          };
        },
        typePrompt: async () => {
          events.push("typePrompt");
          return { typedChars: 1, replacedChars: 0 };
        },
        submitTurn: async () => {
          events.push("submitTurn");
          return { submittedAt: Date.now() };
        },
      },
    },
  });

  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "composer_stop_state");
  assert.equal(result.evidence.editorChars, 0);
  assert.equal(result.evidence.stopActive, true);
  assert.deepEqual(events, ["composer-gate"]);
});

function makeCompletionCdp(state) {
  return {
    async send(method) {
      assert.equal(method, "Runtime.evaluate");
      return { result: { value: JSON.stringify(state) } };
    },
  };
}

test("G1 R2 completion still requires actions and still tolerates a persistent stop control", async () => {
  let virtualTime = 0;
  const noSignal = await waitForCompletion(
    makeCompletionCdp({
      userTurns: 1,
      answerTurns: 1,
      answerText: "Partial answer",
      answerActionsVisible: false,
      stopVisible: false,
      editorEmpty: true,
      title: "ChatGPT",
    }),
    "session-1",
    chatgptAdapter,
    {
      baselineUserTurns: 0,
      baselineAnswerTurns: 0,
      settleMs: 0,
      stallTimeoutMs: 10,
      pollIntervalMs: 5,
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
    }
  );
  assert.equal(noSignal.status, "stalled");
  assert.equal(noSignal.reason, "no_completion_signal");

  virtualTime = 0;
  const withSignal = await waitForCompletion(
    makeCompletionCdp({
      userTurns: 1,
      answerTurns: 1,
      answerText: "Final answer",
      answerActionsVisible: true,
      stopVisible: true,
      editorEmpty: true,
      title: "ChatGPT",
    }),
    "session-1",
    chatgptAdapter,
    {
      baselineUserTurns: 0,
      baselineAnswerTurns: 0,
      settleMs: 0,
      pollIntervalMs: 5,
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
    }
  );
  assert.equal(withSignal.status, "completed");
  assert.equal(withSignal.text, "Final answer");
});

test("G1 R2 composer pre-gate rejects ready:true when cdp.send exceeds timeoutMs deadline", async () => {
  let virtualTime = 0;
  let capturedSendOpts = null;
  const cdp = {
    async send(method, _params, _sessionId, opts) {
      assert.equal(method, "Runtime.evaluate");
      capturedSendOpts = opts;
      virtualTime += 100;
      return { result: { value: { ready: true, stopActive: false } } };
    },
  };

  const result = await waitForComposerReady(cdp, "session-1", chatgptAdapter, {
    timeoutMs: 50,
    pollIntervalMs: 10,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(capturedSendOpts?.timeoutMs, 50);
  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "composer_not_ready_timeout");
});

test("G1 R2 composer pre-gate still returns ok:true when ready:true arrives within timeoutMs", async () => {
  let virtualTime = 0;
  let capturedSendOpts = null;
  const cdp = {
    async send(method, _params, _sessionId, opts) {
      assert.equal(method, "Runtime.evaluate");
      capturedSendOpts = opts;
      virtualTime += 10;
      return { result: { value: { ready: true, stopActive: false } } };
    },
  };

  const result = await waitForComposerReady(cdp, "session-1", chatgptAdapter, {
    timeoutMs: 50,
    pollIntervalMs: 10,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(capturedSendOpts?.timeoutMs, 50);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ready");
  assert.equal(result.ready, true);
});
