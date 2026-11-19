import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await store.transaction(({ tasks, sessions }) => {
      tasks.tasks["task-1"] = {
        taskId: "task-1",
        workspace: "repo",
        parentPid: 999999,
        children: {
          chatgpt: { provider: "chatgpt", state: "timed_out", childPid: null, threadUrl: "https://chatgpt.com/c/old" },
          gemini: { provider: "gemini", state: "completed", childPid: null, threadUrl: "https://gemini.google.com/app/ok" },
        },
      };
      sessions.workspaces.repo = { chatgpt: "https://chatgpt.com/c/old", gemini: "https://gemini.google.com/app/ok" };
    });
    await assert.rejects(
      () => abandonProvider("task-1", "chatgpt", { home, store, confirm: false }),
      /--confirm/,
    );
    const updated = await abandonProvider("task-1", "chatgpt", { home, store, confirm: true });
    assert.equal(updated.children.chatgpt.state, "abandoned");
    assert.equal(updated.state, "partial");
    const snapshot = await store.snapshot();
    assert.deepEqual(snapshot.sessions.workspaces.repo, {
      chatgpt: "https://chatgpt.com/c/old",
      gemini: "https://gemini.google.com/app/ok",
    });
    assert.equal(workspaceHasBlockingTask(snapshot.tasks.tasks, "repo", ["chatgpt"]), null);
    assert.equal(workspaceHasBlockingTask(snapshot.tasks.tasks, "repo", ["gemini"]), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a collection finishing after resolve cannot resurrect the abandoned provider", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-collect-"));
  try {
    const store = new Store(home);
    const threadUrl = "https://chatgpt.com/c/current";
    await store.transaction(({ tasks, sessions }) => {
      tasks.tasks.pending = {
        taskId: "pending", workspace: "repo", runDir: home, outputDir: path.join(home, "batch"),
        children: {
          chatgpt: { provider: "chatgpt", jobId: "chatgpt-job", state: "timed_out", threadUrl },
        },
      };
      sessions.workspaces.repo = { chatgpt: threadUrl };
    });

    let notifyStarted;
    let finish;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const release = new Promise((resolve) => { finish = resolve; });
    const pending = collectTask("pending", {
      provider: "chatgpt", confirmComplete: true, home, store, config: {},
      run: async (_command, args) => {
        notifyStarted();
        await release;
        await writeFile(args[args.indexOf("--output") + 1], "Recovered text");
        return { code: 0 };
      },
    });
    try {
      await Promise.race([started, pending]);
      await abandonProvider("pending", "chatgpt", { home, store, confirm: true });
    } finally {
      finish();
    }
    await assert.rejects(pending, { code: "COLLECT_STATE_CHANGED" });
    const { tasks, sessions } = await store.snapshot();
    assert.equal(tasks.tasks.pending.children.chatgpt.state, "abandoned");
    assert.equal(sessions.workspaces.repo.chatgpt, threadUrl);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
