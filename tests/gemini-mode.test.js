import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateGeminiMode } from "../src/config.js";
import { CLICK_TASK_SOURCE, geminiTaskModeNeeded, isGeminiAppPage, startGeminiTaskModeForTask } from "../src/gemini-mode.js";

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

test("the Task switch is pressed only while the composer is empty", () => {
  const empty = runClickSource("");
  assert.equal(empty.parsed.step, "clicked");
  assert.equal(empty.clicks, 1);

  // Clicking after ask-bridge has typed can rebuild the editor and drop the
  // prompt. Refusing is the only safe outcome wfa can guarantee.
  const typed = runClickSource("请复核这段代码");
  assert.equal(typed.parsed.step, "typed");
  assert.equal(typed.parsed.typed, 7);
  assert.equal(typed.clicks, 0);
});
