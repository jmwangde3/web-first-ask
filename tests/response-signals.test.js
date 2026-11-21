import test from "node:test";
import assert from "node:assert/strict";
import { inspectResponseHeuristics } from "../src/metadata.js";
import { detectSessionIsolationWarning } from "../src/state.js";

test("a short download stub is reported as a Canvas artifact", () => {
  const text = `[下载完整补丁](sandbox:/mnt/data/fix.patch)\nSHA256: ${"a".repeat(64)}`;
  const result = inspectResponseHeuristics(text);
  assert.equal(result.canvasStub, true);
  assert.equal(result.latexEscaping, false);
  assert.equal(result.reasons.length, 1);
});

test("LaTeX escaping in a response is reported", () => {
  const result = inspectResponseHeuristics(String.raw`| a \vert{}\vert{} b |`);
  assert.equal(result.canvasStub, false);
  assert.equal(result.latexEscaping, true);
});

test("ordinary prose and code are not flagged", () => {
  const text = [
    "The function returns a valid result.",
    "```js",
    "export const value = { ready: true };",
    "```",
    "See https://example.com/docs for details.",
  ].join("\n");
  assert.deepEqual(inspectResponseHeuristics(text), { canvasStub: false, latexEscaping: false, reasons: [] });
});

test("a fresh request that returns the previous conversation URL is flagged", () => {
  const shared = "https://chatgpt.com/c/previous";
  const tasks = {
    old: { taskId: "old", workspace: "repo", children: { chatgpt: { state: "completed", threadUrl: shared } } },
    current: { taskId: "current", workspace: "repo", fresh: true, children: { chatgpt: {} } },
  };
  const current = tasks.current;

  assert.match(detectSessionIsolationWarning(tasks, current, "chatgpt", shared), /THREAD_MISMATCH \(chatgpt\)/);
  assert.deepEqual(current.children.chatgpt.threadMismatch, {
    expected: "a new conversation (not the previously saved thread)",
    actual: shared,
  });
  assert.equal(detectSessionIsolationWarning(tasks, current, "chatgpt", "https://chatgpt.com/c/new"), null);
  assert.equal(detectSessionIsolationWarning(tasks, { ...current, fresh: false }, "chatgpt", shared), null);
  assert.equal(detectSessionIsolationWarning(tasks, current, "chatgpt", null), null);
});

test("only the most recent prior completed task is compared", () => {
  const tasks = {
    old: { taskId: "old", workspace: "repo", children: { chatgpt: { state: "completed", threadUrl: "https://chatgpt.com/c/old" } } },
    mid: { taskId: "mid", workspace: "repo", children: { chatgpt: { state: "failed", threadUrl: null } } },
    current: { taskId: "current", workspace: "repo", fresh: true, children: { chatgpt: {} } },
  };
  assert.match(
    detectSessionIsolationWarning(tasks, tasks.current, "chatgpt", "https://chatgpt.com/c/old"),
    /chatgpt\.com\/c\/old/,
  );
  assert.equal(
    detectSessionIsolationWarning(tasks, tasks.current, "chatgpt", "https://chatgpt.com/c/mid"),
    null,
  );
});
