import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import * as claudeAdapter from "../src/browser/adapters/claude.js";
import { runCdpTurn, normalizeGeminiMode, resolveGeminiMode, applyGeminiMode } from "../src/engines/cdp-engine.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { WfaError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Fake-DOM harness (same pattern as tests/cdp-attach-d3-f4.test.js): the
// adapter builders return JS strings evaluated in the page. Executing them
// here against minimal document stubs proves the generated code itself is
// correct; no test here touches a live browser, and no selector in this
// file is claimed to be verified against a live DOM.
// ---------------------------------------------------------------------------

function makeElement({ text = "", ariaLabel = null, title = null, download = null, disabled = false, hidden = false } = {}) {
  const el = {
    innerText: text,
    textContent: text,
    disabled,
    clicked: false,
    tagName: "BUTTON",
    parentElement: null,
    getAttribute: (name) => {
      if (name === "aria-label") return ariaLabel;
      if (name === "title") return title;
      if (name === "download") return download;
      if (name === "aria-disabled") return disabled ? "true" : null;
      return null;
    },
    getBoundingClientRect: () => (hidden ? { width: 0, height: 0 } : { width: 12, height: 12 }),
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    click() { el.clicked = true; },
  };
  return el;
}

function makeTaskButton(initialPressed, text = "Task") {
  let pressed = initialPressed;
  const el = {
    innerText: text,
    textContent: text,
    clicked: false,
    getAttribute: (name) => (name === "aria-pressed" ? String(pressed) : null),
    getBoundingClientRect: () => ({ width: 12, height: 12 }),
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    click() { el.clicked = true; pressed = !pressed; },
  };
  return el;
}

function runPageJs(js, documentStub, locationStub = { hostname: "gemini.google.com", pathname: "/app" }) {
  return new Function("document", "location", `"use strict"; return (${js});`)(documentStub, locationStub);
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-f1f5-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createMockStream() {
  let content = "";
  return {
    write: (chunk) => { content += chunk; return true; },
    get output() { return content; },
  };
}

// ---------------------------------------------------------------------------
// F1 — Gemini Task mode toggle (adapter JS, fake DOM)
// ---------------------------------------------------------------------------

function makeGeminiModeDocument({ segmentButton = null, labelButtons = [], editor = makeElement({ text: "" }) } = {}) {
  return {
    title: "Gemini",
    querySelector: (selector) => {
      if (selector.includes('gem-segmented-button[data-value="40"]')) return segmentButton;
      if (selector === '[contenteditable="true"]') return editor;
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector === "gem-segmented-button button") return labelButtons;
      return [];
    },
  };
}

test("F1 gemini mode toggle: Task not pressed -> clicks, confirms pressed, records task mode", async () => {
  const button = makeTaskButton(false);
  const res = await runPageJs(
    geminiAdapter.buildTaskModeJs("task"),
    makeGeminiModeDocument({ segmentButton: button }),
  );
  assert.equal(res.success, true);
  assert.equal(res.step, "clicked");
  assert.equal(res.mode, "task");
  assert.equal(button.clicked, true);
  assert.equal(res.typedBeforeClick, 0);
});

test("F1 gemini mode toggle: already on Task -> no click, step already", async () => {
  const button = makeTaskButton(true);
  const res = await runPageJs(
    geminiAdapter.buildTaskModeJs("task"),
    makeGeminiModeDocument({ segmentButton: button }),
  );
  assert.equal(res.success, true);
  assert.equal(res.step, "already");
  assert.equal(res.mode, "task");
  assert.equal(button.clicked, false);
});

test("F1 gemini mode toggle: back to Chat clicks the pressed switch off", async () => {
  const button = makeTaskButton(true);
  const res = await runPageJs(
    geminiAdapter.buildTaskModeJs("chat"),
    makeGeminiModeDocument({ segmentButton: button }),
  );
  assert.equal(res.success, true);
  assert.equal(res.step, "clicked");
  assert.equal(res.mode, "chat");
  assert.equal(button.clicked, true);
});

test("F1 gemini mode toggle: no segment control -> fails closed with a distinct reason, no click", async () => {
  const res = await runPageJs(
    geminiAdapter.buildTaskModeJs("task"),
    makeGeminiModeDocument({ segmentButton: null, labelButtons: [] }),
  );
  assert.equal(res.success, false);
  assert.equal(res.reason, "task_mode_control_not_found");
  assert.equal(res.mode, "unknown");
});

test("F1 gemini mode toggle: label fallback finds the Task button when the segment selector misses", async () => {
  const button = makeTaskButton(false);
  const res = await runPageJs(
    geminiAdapter.buildTaskModeJs("task"),
    makeGeminiModeDocument({ segmentButton: null, labelButtons: [button] }),
  );
  assert.equal(res.success, true);
  assert.equal(res.step, "clicked");
  assert.equal(button.clicked, true);
});

test("F1 gemini mode state JS: pressed -> task, unpressed -> chat, absent -> unknown", () => {
  const docTask = makeGeminiModeDocument({ segmentButton: makeTaskButton(true) });
  assert.deepEqual(runPageJs(geminiAdapter.buildGeminiModeStateJs(), docTask),
    { mode: "task", pressed: true, controlFound: true });
  const docChat = makeGeminiModeDocument({ segmentButton: makeTaskButton(false) });
  assert.deepEqual(runPageJs(geminiAdapter.buildGeminiModeStateJs(), docChat),
    { mode: "chat", pressed: false, controlFound: true });
  const docAbsent = makeGeminiModeDocument({ segmentButton: null, labelButtons: [] });
  assert.deepEqual(runPageJs(geminiAdapter.buildGeminiModeStateJs(), docAbsent),
    { mode: "unknown", pressed: null, controlFound: false });
});

test("F1 gemini mode toggle reports typed text instead of failing on it", async () => {
  const button = makeTaskButton(false);
  const res = await runPageJs(
    geminiAdapter.buildTaskModeJs("task"),
    makeGeminiModeDocument({ segmentButton: button, editor: makeElement({ text: "draft" }) }),
  );
  assert.equal(res.success, true);
  assert.equal(res.typedBeforeClick, 5);
});

// ---------------------------------------------------------------------------
// F1 — mode resolution (engine registry)
// ---------------------------------------------------------------------------

test("F1 normalizeGeminiMode: chat is the default; task/chat pass; anything else is null", () => {
  assert.equal(normalizeGeminiMode(undefined), "chat");
  assert.equal(normalizeGeminiMode(null), "chat");
  assert.equal(normalizeGeminiMode(""), "chat");
  assert.equal(normalizeGeminiMode("task"), "task");
  assert.equal(normalizeGeminiMode("TASK"), "task");
  assert.equal(normalizeGeminiMode("chat"), "chat");
  assert.equal(normalizeGeminiMode("deep"), null);
});

test("F1 resolveGeminiMode: task is Gemini-only; other providers reject it", () => {
  assert.equal(resolveGeminiMode("gemini", "task"), "task");
  assert.equal(resolveGeminiMode("gemini", undefined), "chat");
  assert.equal(resolveGeminiMode("chatgpt", "chat"), "chat");
  assert.throws(() => resolveGeminiMode("chatgpt", "task"), /only applies to.*gemini/i);
  assert.throws(() => resolveGeminiMode("claude", "task"), /only applies to.*gemini/i);
  assert.throws(() => resolveGeminiMode("gemini", "deep"), /chat or task/i);
});

// ---------------------------------------------------------------------------
// F1/F5 — engine turns (mock CDP + mock driver, no live browser)
// ---------------------------------------------------------------------------

function makeEngineHarness({ toggleResult, stateResult } = {}) {
  const counters = { typed: 0, submitted: 0 };
  const evaluated = [];
  const cdp = {
    send: async (method, params = {}) => {
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression || "");
        evaluated.push(expression);
        if (expression === "window.location.href") return { result: { value: "" } };
        if (expression.includes("typedBeforeClick")) return { result: { value: toggleResult } };
        if (expression.includes("controlFound")) return { result: { value: stateResult } };
        return { result: { value: "" } };
      }
      return {};
    },
    close() {},
  };
  const driver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({
      userTurns: 0, answerTurns: 0, answerText: "", stopVisible: false,
      editorEmpty: true, loggedOut: false, pageError: null,
    }),
    waitForComposerReady: async () => ({ ok: true, status: "ready" }),
    typePrompt: async () => { counters.typed += 1; return { typedChars: 1, replacedChars: 0 }; },
    submitTurn: async () => { counters.submitted += 1; return { submittedAt: Date.now() }; },
    waitForCompletion: async () => ({ status: "completed", reason: "completed", text: "answer", evidence: {} }),
  };
  const deps = {
    enforceCooldown: async () => {},
    skipTurnLock: true,
    pace: async () => 0,
    recordLastTurn: async () => {},
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1234, port: 9222 } }),
    connectCdp: async () => cdp,
    driver,
  };
  return { deps, counters, evaluated };
}

test("F1 engine: gemini --gemini-mode task toggles before typing and the turn records task mode", async () => {
  await withTempDir(async (home) => {
    const { deps, counters, evaluated } = makeEngineHarness({
      toggleResult: { success: true, step: "clicked", mode: "task", typedBeforeClick: 0 },
      stateResult: { mode: "task", pressed: true, controlFound: true },
    });
    const result = await runCdpTurn({
      provider: "gemini", prompt: "run the checks", home, geminiMode: "task", deps,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.geminiMode, "task");
    assert.equal(result.evidence.geminiMode.mode, "task");
    assert.equal(result.evidence.geminiMode.applied, true);
    assert.equal(counters.typed, 1);
    assert.equal(counters.submitted, 1);
    assert.ok(evaluated.some((e) => e.includes("gem-segmented-button")),
      "the toggle JS must have been evaluated before typing");
  });
});

test("F1 engine: a failed Task toggle fails closed before typing or submitting", async () => {
  await withTempDir(async (home) => {
    const { deps, counters } = makeEngineHarness({
      toggleResult: { success: false, reason: "task_mode_control_not_found", mode: "unknown", typedBeforeClick: 0 },
      stateResult: { mode: "unknown", pressed: null, controlFound: false },
    });
    const result = await runCdpTurn({
      provider: "gemini", prompt: "run the checks", home, geminiMode: "task", deps,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "gemini_mode_failed");
    assert.equal(result.text, "");
    assert.equal(counters.typed, 0);
    assert.equal(counters.submitted, 0);
  });
});

test("F1 engine: gemini chat mode performs no toggle evaluation", async () => {
  await withTempDir(async (home) => {
    const { deps, evaluated } = makeEngineHarness({
      toggleResult: null,
      stateResult: { mode: "chat", pressed: false, controlFound: true },
    });
    const result = await runCdpTurn({
      provider: "gemini", prompt: "hello", home, deps,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.geminiMode, "chat");
    assert.equal(evaluated.some((e) => e.includes("typedBeforeClick")), false);
  });
});

test("F1 engine: --gemini-mode task on chatgpt and an unknown mode are rejected before any browser work", async () => {
  await withTempDir(async (home) => {
    const { deps } = makeEngineHarness({});
    await assert.rejects(
      () => runCdpTurn({ provider: "chatgpt", prompt: "hi", home, geminiMode: "task", deps }),
      (err) => err?.code === "INVALID_ARGUMENT" && /only applies to.*gemini/i.test(err.message),
    );
    await assert.rejects(
      () => runCdpTurn({ provider: "gemini", prompt: "hi", home, geminiMode: "deep", deps }),
      (err) => err?.code === "INVALID_ARGUMENT" && /chat or task/i.test(err.message),
    );
  });
});

test("F1 applyGeminiMode: mode mismatch after toggle throws instead of recording the wrong mode", async () => {
  const cdp = {
    send: async (method, params = {}) => {
      const expression = String(params?.expression || "");
      if (expression.includes("typedBeforeClick")) {
        return { result: { value: { success: true, step: "clicked", mode: "task", typedBeforeClick: 0 } } };
      }
      if (expression.includes("controlFound")) {
        return { result: { value: { mode: "chat", pressed: false, controlFound: true } } };
      }
      return {};
    },
  };
  await assert.rejects(
    () => applyGeminiMode(cdp, "sess-1", geminiAdapter, "task"),
    (err) => err?.code === "GEMINI_MODE_FAILED" && /mismatch/i.test(err.message),
  );
});

test("F5 engine: a claude turn runs through the registered adapter", async () => {
  await withTempDir(async (home) => {
    const { deps, counters } = makeEngineHarness({});
    const result = await runCdpTurn({
      provider: "claude", prompt: "hello", home, deps,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "answer");
    assert.equal(counters.typed, 1);
    assert.equal(counters.submitted, 1);
  });
});

test("F5 engine: an unknown provider is still rejected", async () => {
  await withTempDir(async (home) => {
    const { deps } = makeEngineHarness({});
    await assert.rejects(
      () => runCdpTurn({ provider: "bogus", prompt: "hi", home, deps }),
      (err) => err?.code === "INVALID_ARGUMENT" && /chatgpt, gemini, or claude/i.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// F5 — Claude adapter JS (fake DOM)
// ---------------------------------------------------------------------------

function makeClaudeLoginDocument({ editor = null, loginLink = null } = {}) {
  return {
    title: "Claude",
    querySelector: (selector) => {
      if (selector.includes("contenteditable")) return editor;
      if (selector.includes("/login") || selector.includes("login")) return loginLink;
      return null;
    },
    querySelectorAll: () => [],
  };
}

test("F5 claude adapter exposes the full provider interface", () => {
  assert.equal(claudeAdapter.id, "claude");
  assert.equal(claudeAdapter.url, "https://claude.ai/new");
  for (const name of [
    "editorSelector", "stopSelector", "sendSelector",
    "challengeTitlePattern", "turnChallengeTitlePattern",
    "fileInputSelector", "attachmentChipSelector", "downloadTriggerSelector",
    "assistantMessageSelector", "userMessageSelector",
  ]) {
    assert.ok(claudeAdapter[name] !== undefined, `missing export: ${name}`);
  }
  for (const name of [
    "buildUploadJs", "buildAttachmentVerifyJs", "buildDownloadClickJs",
    "buildLoginProbeJs", "buildAnswerTextJs", "buildReadStateJs",
    "buildDeleteConversationJs",
  ]) {
    assert.equal(typeof claudeAdapter[name], "function", `missing builder: ${name}`);
  }
  assert.equal(claudeAdapter.buildUploadJs(), null);
});

test("F5 claude login probe JS: editor with no login link -> logged in; login link -> logged out; off-origin -> offOrigin", () => {
  const loggedIn = runPageJs(
    claudeAdapter.buildLoginProbeJs(),
    makeClaudeLoginDocument({ editor: makeElement({ text: "" }), loginLink: null }),
    { hostname: "claude.ai", pathname: "/new" },
  );
  assert.equal(loggedIn.loggedIn, true);
  assert.equal(loggedIn.offOrigin, undefined);

  const loggedOut = runPageJs(
    claudeAdapter.buildLoginProbeJs(),
    makeClaudeLoginDocument({ editor: null, loginLink: makeElement({ text: "Log in" }) }),
    { hostname: "claude.ai", pathname: "/" },
  );
  assert.equal(loggedOut.loggedIn, false);
  assert.equal(loggedOut.signedOut, true);

  const offOrigin = runPageJs(
    claudeAdapter.buildLoginProbeJs(),
    makeClaudeLoginDocument({}),
    { hostname: "accounts.google.com", pathname: "/signin" },
  );
  assert.equal(offOrigin.loggedIn, false);
  assert.equal(offOrigin.offOrigin, true);
});

function makeClaudeReadDocument({ userCount = 0, assistants = [], editor = null, stop = null, alerts = [] } = {}) {
  const userEls = Array.from({ length: userCount }, () => makeElement({ text: "user turn" }));
  return {
    title: "Claude",
    querySelectorAll: (selector) => {
      if (selector.includes("assistant-message") || selector.includes('data-message-author-role="assistant"')) return assistants;
      if (selector.includes('data-message-author-role="user"') || selector.includes("user-message")) return userEls;
      if (selector.includes("alert") || selector.includes("error") || selector.includes("text-red-")) return alerts;
      return [];
    },
    querySelector: (selector) => {
      if (selector.includes("contenteditable")) return editor;
      if (selector.includes("Stop")) return stop;
      return null;
    },
  };
}

test("F5 claude read-state JS: counts turns, extracts the last answer, reports stop/editor state", () => {
  const assistant = makeElement({ text: "final answer" });
  const doc = makeClaudeReadDocument({
    userCount: 1,
    assistants: [makeElement({ text: "old answer" }), assistant],
    editor: makeElement({ text: "" }),
    stop: null,
  });
  const state = JSON.parse(runPageJs(claudeAdapter.buildReadStateJs(), doc));
  assert.equal(state.userTurns, 1);
  assert.equal(state.answerTurns, 2);
  assert.equal(state.answerText, "final answer");
  assert.equal(state.stopVisible, false);
  assert.equal(state.editorEmpty, true);
  assert.equal(state.loggedOut, false);
  assert.equal(state.pageError, null);
  // No copy/regenerate control observed -> null (no gate), not false.
  assert.equal(state.answerActionsVisible, null);
});

test("F5 claude read-state JS: stop button visible blocks the stop gate; empty page is unconfirmed-shaped", () => {
  const stop = makeElement({ ariaLabel: "Stop response" });
  const doc = makeClaudeReadDocument({
    userCount: 1,
    assistants: [makeElement({ text: "partial" })],
    editor: makeElement({ text: "" }),
    stop,
  });
  const state = JSON.parse(runPageJs(claudeAdapter.buildReadStateJs(), doc));
  assert.equal(state.stopVisible, true);
  assert.equal(state.answerText, "partial");

  const empty = JSON.parse(runPageJs(claudeAdapter.buildReadStateJs(), makeClaudeReadDocument({})));
  assert.equal(empty.userTurns, 0);
  assert.equal(empty.answerTurns, 0);
  assert.equal(empty.answerText, "");
});

test("F5 claude answer-text JS: last assistant turn wins; none -> empty string", () => {
  const doc = makeClaudeReadDocument({
    assistants: [makeElement({ text: "first" }), makeElement({ text: "second" })],
  });
  assert.equal(runPageJs(claudeAdapter.buildAnswerTextJs(), doc), "second");
  assert.equal(runPageJs(claudeAdapter.buildAnswerTextJs(), makeClaudeReadDocument({})), "");
});

test("F5 claude attachment verify JS: filename must appear in a chip, like the other adapters", () => {
  const js = claudeAdapter.buildAttachmentVerifyJs(["/tmp/bundle.zip"]);
  const docWith = {
    querySelectorAll: (selector) => {
      if (selector.includes("file-chip") || selector.includes("attachment-chip")) {
        return [makeElement({ text: "bundle.zip" })];
      }
      if (selector.includes("Send")) return [makeElement()];
      return [];
    },
    querySelector: (selector) => (selector.includes("file") ? { files: [] } : null),
  };
  const ok = runPageJs(js, docWith);
  assert.equal(ok.present, true);
  assert.deepEqual(ok.matched, [true]);

  const docWithout = {
    querySelectorAll: (selector) => {
      if (selector.includes("file-chip") || selector.includes("attachment-chip")) {
        return [makeElement({ text: "other.zip" })];
      }
      if (selector.includes("Send")) return [makeElement()];
      return [];
    },
    querySelector: (selector) => (selector.includes("file") ? { files: [] } : null),
  };
  const bad = runPageJs(js, docWithout);
  assert.equal(bad.present, false);
  assert.deepEqual(bad.matched, [false]);
});

test("F5 claude download click JS: named control clicked, miss fails closed", () => {
  const target = makeElement({ text: "Download report.zip", ariaLabel: "Download report.zip" });
  const other = makeElement({ text: "Download other.zip", ariaLabel: "Download other.zip" });
  const doc = {
    querySelectorAll: (selector) => (/download/i.test(selector) ? [other, target] : []),
    querySelector: () => null,
  };
  const hit = runPageJs(claudeAdapter.buildDownloadClickJs("report.zip"), doc);
  assert.equal(hit.clicked, true);
  assert.equal(target.clicked, true);
  assert.equal(other.clicked, false);

  const miss = runPageJs(claudeAdapter.buildDownloadClickJs("missing.zip"), doc);
  assert.equal(miss.clicked, false);
  assert.equal(miss.reason, "download_control_not_found");
});

test("F5 claude delete JS: a URL that is not the target is refused without touching the page", async () => {
  const js = claudeAdapter.buildDeleteConversationJs("https://claude.ai/chat/abc-123");
  const fakeWindow = {
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  const res = await new Function("document", "location", "window", `"use strict"; return (${js});`)(
    { querySelectorAll: () => [], querySelector: () => null, title: "Claude", body: { innerText: "" } },
    { hostname: "claude.ai", pathname: "/chat/other-id" },
    fakeWindow,
  );
  assert.equal(res.success, false);
  assert.equal(res.reason, "target_url_mismatch");
  assert.equal(res.expected, "/chat/abc-123");
  assert.equal(res.actual, "/chat/other-id");
});

// ---------------------------------------------------------------------------
// CLI — provider lists, --gemini-mode, claude login (mock broker/CDP)
// ---------------------------------------------------------------------------

test("F1/F5 CLI help lists claude and the separate --gemini-mode flag", async () => {
  const stdout = createMockStream();
  const res = await runCdpCommand(["--help"], { stdout });
  assert.equal(res.code, 0);
  assert.match(stdout.output, /chatgpt\|gemini\|claude/);
  assert.match(stdout.output, /--gemini-mode <chat\|task>/);
});

test("F5 CLI ask accepts --provider claude and forwards it to the broker turn", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let captured = null;
  const deps = {
    stdout,
    stderr,
    ensureBroker: async () => ({ instanceId: "mock-inst", pid: 5000, port: 9444, host: "127.0.0.1", token: "tok" }),
    createTurn: async (record, payload) => { captured = payload; return { status: 202, json: { id: "mock-turn-1" } }; },
    waitForTurn: async () => ({
      id: "mock-turn-1", state: "completed", provider: "claude",
      text: "hi", reason: null, evidence: null, sendCommittedAt: null,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }),
  };
  const res = await runCdpCommand(["ask", "--provider", "claude", "--prompt", "hi", "--json"], deps);
  assert.equal(res.code, 0);
  assert.equal(captured.provider, "claude");
  assert.equal(JSON.parse(stdout.output).provider, "claude");
});

test("F1 CLI ask forwards --gemini-mode task for gemini, rejects it for chatgpt and for fan-out", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let captured = null;
  const deps = {
    stdout,
    stderr,
    ensureBroker: async () => ({ instanceId: "mock-inst", pid: 5000, port: 9444, host: "127.0.0.1", token: "tok" }),
    createTurn: async (record, payload) => { captured = payload; return { status: 202, json: { id: "mock-turn-1" } }; },
    waitForTurn: async () => ({
      id: "mock-turn-1", state: "completed", provider: "gemini",
      text: "hi", reason: null, evidence: null, sendCommittedAt: null,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }),
  };
  const res = await runCdpCommand(
    ["ask", "--provider", "gemini", "--gemini-mode", "task", "--prompt", "hi", "--json"], deps,
  );
  assert.equal(res.code, 0);
  assert.equal(captured.geminiMode, "task");

  const badProvider = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--gemini-mode", "task", "--prompt", "hi"], { stdout, stderr },
  );
  assert.equal(badProvider.code, 1);
  assert.match(stderr.output, /only applies to.*gemini/i);

  const badValue = await runCdpCommand(
    ["ask", "--provider", "gemini", "--gemini-mode", "deep", "--prompt", "hi"], { stdout, stderr },
  );
  assert.equal(badValue.code, 1);
  assert.match(stderr.output, /chat or task/i);

  const fanout = await runCdpCommand(
    ["ask", "--providers", "chatgpt,gemini", "--gemini-mode", "task", "--prompt", "hi"], { stdout, stderr },
  );
  assert.equal(fanout.code, 1);
  assert.match(stderr.output, /fan-out/i);
});

test("F5 CLI login accepts --provider claude through the existing login path", async () => {
  await withTempDir(async (home) => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    let now = 1000;
    const cdp = {
      send: async (method) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: { loggedIn: true, user: null, title: "Claude", origin: "https://claude.ai" } } };
        }
        if (method === "Browser.getWindowForTarget") return { windowId: 1 };
        return {};
      },
      close() {},
    };
    const res = await runCdpCommand(["login", "--provider", "claude", "--json"], {
      stdout,
      stderr,
      home,
      recoverBrowser: async () => ({ chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: { openTab: async () => ({ targetId: "t-1", sessionId: "s-1" }) },
      readBrokerRecord: async () => null,
      isInstanceAlive: async () => false,
      now: () => now,
      sleep: async () => { now += 1000; },
    });
    assert.equal(res.code, 0);
    const out = JSON.parse(stdout.output);
    assert.equal(out.status, "completed");
    assert.equal(out.provider, "claude");
  });
});

test("F5 CLI login still rejects an unknown provider", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const res = await runCdpCommand(["login", "--provider", "bogus"], { stdout, stderr });
  assert.equal(res.code, 1);
  assert.match(stderr.output, /chatgpt, gemini, or claude/i);
});
