import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { collectTask, abandonProvider } from "../src/recovery.js";
import { workspaceHasBlockingTask } from "../src/state.js";

test("collect refuses to read a possibly partial response without explicit confirmation", async () => {
  await assert.rejects(
    () => collectTask("task-1", { confirmComplete: false }),
    /--confirm-complete/,
  );
});

test("abandon requires confirmation and releases only the selected unresolved provider", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-recovery-"));
  try {
    const store = new Store(home);
    await store.transaction(({ tasks }) => {
      tasks.tasks["task-1"] = {
        taskId: "task-1",
        workspace: "repo",
        parentPid: 999999,
        children: {
          chatgpt: { provider: "chatgpt", state: "timed_out", childPid: null, threadUrl: "https://chatgpt.com/c/old" },
          gemini: { provider: "gemini", state: "completed", childPid: null, threadUrl: "https://gemini.google.com/app/ok" },
        },
      };
    });
    await assert.rejects(
      () => abandonProvider("task-1", "chatgpt", { home, store, confirm: false }),
      /--confirm/,
    );
    const updated = await abandonProvider("task-1", "chatgpt", { home, store, confirm: true });
    assert.equal(updated.children.chatgpt.state, "abandoned");
    assert.equal(updated.state, "partial");
    const snapshot = await store.snapshot();
    assert.equal(workspaceHasBlockingTask(snapshot.tasks.tasks, "repo", ["chatgpt"]), null);
    assert.equal(workspaceHasBlockingTask(snapshot.tasks.tasks, "repo", ["gemini"]), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
