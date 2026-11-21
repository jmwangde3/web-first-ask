import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateGeminiMode } from "../src/config.js";
import { geminiTaskModeNeeded, startGeminiTaskModeForTask } from "../src/gemini-mode.js";

test("gemini mode defaults to chat and rejects anything else", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-gmode-"));
  try {
    assert.equal((await loadConfig(home)).geminiMode, "chat");
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
