import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateGeminiMode } from "../src/config.js";
import {
  CLICK_TASK_SOURCE, geminiTaskModeNeeded, isGeminiAppPage,
  startGeminiTaskMode, startGeminiTaskModeForTask,
} from "../src/gemini-mode.js";

test("gemini mode defaults to task, and anything else is rejected", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-gmode-"));
  try {
    assert.equal((await loadConfig(home)).geminiMode, "task");
    assert.equal(validateGeminiMode("chat"), "chat");
    assert.equal(validateGeminiMode("task"), "task");
    assert.throws(() => validateGeminiMode("tasks"), /chat.*or.*task/i);
    assert.throws(() => validateGeminiMode(undefined), /chat.*or.*task/i);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a saved gemini mode survives a reload, and a bad one is reported not ignored", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-gmode-"));
  try {
    await writeFile(path.join(home, "config.json"), JSON.stringify({ geminiMode: "task" }), "utf8");
    assert.equal((await loadConfig(home)).geminiMode, "task");
    await writeFile(path.join(home, "config.json"), JSON.stringify({ geminiMode: "deep" }), "utf8");
    await assert.rejects(loadConfig(home), /chat.*or.*task/i);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the task switch is only pressed for a task-mode run that actually has a gemini job", () => {
  assert.equal(geminiTaskModeNeeded({ geminiMode: "task", providers: ["gemini"] }), true);
  assert.equal(geminiTaskModeNeeded({ geminiMode: "task", providers: ["chatgpt", "gemini"] }), true);
  assert.equal(geminiTaskModeNeeded({ geminiMode: "chat", providers: ["gemini"] }), false);
  assert.equal(geminiTaskModeNeeded({ geminiMode: "task", providers: ["chatgpt"] }), false);
  assert.equal(geminiTaskModeNeeded({ providers: ["gemini"] }), false);
  assert.equal(geminiTaskModeNeeded(null), false);
});

test("no clicker is started when the task cannot use it, so no connection is opened", () => {
  assert.equal(startGeminiTaskModeForTask({ geminiMode: "chat", providers: ["gemini"] }), null);
  assert.equal(startGeminiTaskModeForTask({ geminiMode: "task", providers: ["chatgpt"] }), null);
});

test("every Gemini app URL shape ask-bridge opens is recognised", () => {
  for (const url of [
    "https://gemini.google.com/app",
    "https://gemini.google.com/app/",
    "https://gemini.google.com/app?hl=en",
    "https://gemini.google.com/app/ba22855df654c75a",
    "https://gemini.google.com/u/1/app",
    "https://gemini.google.com/u/1/app/ba22855df654c75a?hl=en",
  ]) {
    assert.equal(isGeminiAppPage(url), true, url);
  }
  for (const url of [
    "https://gemini.google.com/apps",
    "https://gemini.google.com/u/1/apps",
    "https://gemini.google.com/share/abc",
    "https://example.com/app",
    "http://gemini.google.com/app",
  ]) {
    assert.equal(isGeminiAppPage(url), false, url);
  }
});

function runClickSource(editorText) {
  let clicks = 0;
  const button = {
    getAttribute: () => "false",
    click: () => { clicks += 1; },
  };
  const document = {
    querySelector: (selector) => (selector.includes("gem-segmented-button") ? button
      : (selector.includes("contenteditable") ? { innerText: editorText } : null)),
    querySelectorAll: () => [button],
  };
  const parsed = JSON.parse(new Function("document", `return ${CLICK_TASK_SOURCE}`)(document));
  return { parsed, clicks };
}

test("the Task switch is pressed even when the composer already holds text", () => {
  const empty = runClickSource("");
  assert.equal(empty.parsed.step, "clicked");
  assert.equal(empty.parsed.typed, 0);
  assert.equal(empty.clicks, 1);

  // The switch is page state: switching back and forth keeps the composer
  // content until something is submitted, so the count is recorded, not
  // treated as a reason to skip the click.
  const typed = runClickSource("请复核这段代码");
  assert.equal(typed.parsed.step, "clicked");
  assert.equal(typed.parsed.typed, 7);
  assert.equal(typed.clicks, 1);
});

const TEST_PAGE = "https://gemini.google.com/app/test-task";

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for the simulated Gemini browser");
}

async function withFakeBrowser(behavior, runTest) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let evaluations = 0;

  class FakeWebSocket {
    readyState = 1;

    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, listener) {
      const group = this.listeners.get(type) ?? [];
      group.push(listener);
      this.listeners.set(type, group);
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    send(raw) {
      const request = JSON.parse(raw);
      let result = {};
      let error = null;

      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "test-session" };
      } else if (request.method === "Runtime.evaluate") {
        evaluations += 1;
        if (request.params.expression === CLICK_TASK_SOURCE) {
          if (behavior === "evaluation-error") {
            error = { message: "original CDP evaluation failure" };
          } else {
            result = { result: { value: JSON.stringify(
              behavior === "confirmation-error"
                ? { step: "clicked", typed: 7 }
                : { step: "absent" },
            ) } };
          }
        } else if (behavior === "confirmation-error") {
          error = { message: "confirmation target disappeared" };
        } else {
          result = { result: { value: "false" } };
        }
      }

      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ id: request.id, result, ...(error ? { error } : {}) }),
        });
      });
    }

    close() {
      this.readyState = 3;
      this.emit("close", {});
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/json/version")) {
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://localhost/fake" }) };
    }
    if (String(url).endsWith("/json/list")) {
      return { json: async () => [{ id: "test-page", type: "page", url: TEST_PAGE }] };
    }
    throw new Error(`Unexpected CDP request: ${url}`);
  };

  try {
    await runTest(() => evaluations);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
}

test("click window expiry reports an unavailable Task switch", async () => {
  await withFakeBrowser("absent", async (evaluations) => {
    const clicker = startGeminiTaskMode({ clickWindowMs: 20 });
    try {
      await waitUntil(() => evaluations() > 0);
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      const report = await clicker.stop();
      assert.equal(report.applied, false);
      assert.match(report.error ?? "", /not found or not clickable within 20 ms/i);
      assert.match(report.error, /gemini\.google\.com\/app\/test-task/);
    }
  });
});

test("exhausted attempts report retry exhaustion instead of an empty error", async () => {
  await withFakeBrowser("confirmation-error", async () => {
    const clicker = startGeminiTaskMode({
      clickWindowMs: 1000,
      retryDelayMs: 0,
    });
    try {
      await waitUntil(() => /after 3 attempts/.test(clicker.state.error ?? ""));
    } finally {
      const report = await clicker.stop();
      assert.equal(report.applied, false);
      assert.match(report.error ?? "", /not confirmed after 3 attempts/);
      assert.equal(report.typedBeforeClick, 7);
      assert.equal(report.clicks, 3);
    }
  });
});

test("stopping before confirmation identifies the last observed Gemini URL", async () => {
  await withFakeBrowser("absent", async (evaluations) => {
    const clicker = startGeminiTaskMode({ clickWindowMs: 5000 });
    await waitUntil(() => evaluations() > 0);
    const report = await clicker.stop();
    assert.equal(report.applied, false);
    assert.match(report.error ?? "", /Task mode not confirmed when task ended/);
    assert.match(report.error, /gemini\.google\.com\/app\/test-task/);
  });
});

test("a genuine earlier CDP error is not overwritten by final fallback diagnostics", async () => {
  await withFakeBrowser("evaluation-error", async (evaluations) => {
    const clicker = startGeminiTaskMode({ retryDelayMs: 0 });
    await waitUntil(() => evaluations() > 0);
    const report = await clicker.stop();
    assert.equal(report.applied, false);
    assert.equal(report.error, "original CDP evaluation failure");
  });
});
