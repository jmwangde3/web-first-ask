import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { collectTask, abandonProvider, waitForTask } from "../src/recovery.js";
import { workspaceHasBlockingTask } from "../src/state.js";

test("collect requires confirmation only when no trusted ask-bridge terminal artifact exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-recovery-unverified-"));
  try {
    const store = new Store(home);
    const runDir = path.join(home, "runs", "task-1");
    const outputDir = path.join(runDir, "ask-bridge-output");
    const jobDir = path.join(outputDir, "job-1");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
      id: "job-1", provider: "chatgpt", state: "in_progress",
      threadUrl: "https://chatgpt.com/c/pending", error: null,
    }));
    await writeFile(path.join(jobDir, "response.md"), "possibly partial answer");
    await store.transaction(({ tasks }) => {
      tasks.tasks["task-1"] = {
        taskId: "task-1", workspace: "repo", runDir, outputDir, state: "interrupted_unknown",
        children: { chatgpt: { provider: "chatgpt", jobId: "job-1", state: "interrupted_unknown",
          threadUrl: "https://chatgpt.com/c/pending", revision: 1 } },
      };
    });
    let getCalls = 0;
    await assert.rejects(
      () => collectTask("task-1", { home, store, confirmComplete: false,
        run: async () => { getCalls += 1; return { code: 0 }; } }),
      { code: "CONFIRMATION_REQUIRED" },
    );
    assert.equal(getCalls, 0);
    assert.equal((await store.snapshot()).tasks.tasks["task-1"].children.chatgpt.state, "interrupted_unknown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("collect automatically returns a verified completed batch result without ask-bridge get or confirmation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-recovery-auto-"));
  try {
    const store = new Store(home);
    const runDir = path.join(home, "runs", "task-auto");
    const outputDir = path.join(runDir, "ask-bridge-output");
    const jobDir = path.join(outputDir, "job-auto");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, "response.md"), "Final provider answer\n");
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
      id: "job-auto", provider: "chatgpt", state: "completed",
      threadUrl: "https://chatgpt.com/c/auto", elapsedSeconds: 42, error: null,
    }));
    await store.transaction(({ tasks }) => {
      tasks.tasks["task-auto"] = {
        taskId: "task-auto", workspace: "repo", workspaceRoot: home, runDir, outputDir,
        state: "interrupted_unknown", parentPid: null, childPid: null,
        children: { chatgpt: { provider: "chatgpt", jobId: "job-auto", state: "interrupted_unknown",
          threadUrl: null, resultPath: null, revision: 1 } },
      };
    });
    let getCalls = 0;
    const result = await collectTask("task-auto", {
      home, store, provider: "chatgpt", confirmComplete: false,
      run: async () => { getCalls += 1; throw new Error("ask-bridge get must not be called"); },
    });
    assert.equal(result.autoCollected, true);
    assert.equal(result.alreadyCollected, true);
    assert.equal(result.task.children.chatgpt.state, "completed");
    assert.equal(await readFile(result.resultPath, "utf8"), "Final provider answer\n");
    assert.equal(getCalls, 0);
    const repeated = await collectTask("task-auto", { home, store, provider: "chatgpt", confirmComplete: false });
    assert.equal(repeated.autoCollected, true);
    assert.equal(repeated.resultPath, result.resultPath);
    await writeFile(result.resultPath, "tampered after terminal verification\n");
    await assert.rejects(
      () => collectTask("task-auto", { home, store, provider: "chatgpt", confirmComplete: false }),
      { code: "RESULT_INTEGRITY_FAILED" },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("wait automatically adopts only ask-bridge completed metadata and reports the result", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-wait-auto-"));
  try {
    const store = new Store(home);
    const runDir = path.join(home, "runs", "task-wait");
    const outputDir = path.join(runDir, "ask-bridge-output");
    const jobDir = path.join(outputDir, "job-wait");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, "response.md"), "Completed without a get call");
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
      id: "job-wait", provider: "gemini", state: "completed",
      threadUrl: "https://gemini.google.com/app/wait", elapsedSeconds: 7, error: null,
    }));
    await store.transaction(({ tasks }) => {
      tasks.tasks["task-wait"] = {
        taskId: "task-wait", workspace: "repo", workspaceRoot: home, runDir, outputDir,
        state: "running", parentPid: null, childPid: null,
        children: { gemini: { provider: "gemini", jobId: "job-wait", state: "running",
          threadUrl: null, resultPath: null, revision: 1 } },
      };
    });
    const result = await waitForTask("task-wait", { home, store, timeoutSeconds: 0, pollMs: 250 });
    assert.equal(result.task.children.gemini.state, "completed");
    assert.equal(result.collected.length, 1);
    assert.equal(result.collected[0].provider, "gemini");
    assert.match(result.collected[0].resultPath, /response\.md$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("verified result can be read while batch cleanup is pending, but workspace remains locked until exit", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-execution-pending-"));
  try {
    const store = new Store(home);
    const runDir = path.join(home, "runs", "task-pending");
    const outputDir = path.join(runDir, "ask-bridge-output");
    const jobDir = path.join(outputDir, "job-pending");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, "response.md"), "Terminal response");
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
      id: "job-pending", provider: "chatgpt", state: "completed",
      threadUrl: "https://chatgpt.com/c/pending", elapsedSeconds: 9, error: null,
    }));
    await store.transaction(({ tasks }) => {
      tasks.tasks["task-pending"] = {
        taskId: "task-pending", workspace: "repo", workspaceRoot: home, runDir, outputDir,
        state: "running", parentPid: null, childPid: process.pid, executionPending: true,
        children: { chatgpt: { provider: "chatgpt", jobId: "job-pending", state: "running",
          threadUrl: null, resultPath: null, revision: 1, childPid: process.pid } },
      };
    });
    const result = await collectTask("task-pending", { home, store, provider: "chatgpt" });
    assert.equal(result.autoCollected, true);
    assert.equal(result.executionPending, true);
    assert.ok(workspaceHasBlockingTask((await store.snapshot()).tasks.tasks, "repo", ["chatgpt"]));
    await store.transaction(({ tasks }) => { tasks.tasks["task-pending"].childPid = 99999999; });
    const refreshed = await (await import("../src/runner.js")).refreshTask("task-pending", { home, store });
    assert.equal(refreshed.executionPending, false);
    assert.equal(workspaceHasBlockingTask((await store.snapshot()).tasks.tasks, "repo", ["chatgpt"]), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test("manual collection refuses a conversation URL outside the selected provider", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-collect-unsafe-url-"));
  try {
    const store = new Store(home);
    const runDir = path.join(home, "runs", "unsafe-url");
    await mkdir(runDir, { recursive: true });
    await store.transaction(({ tasks }) => {
      tasks.tasks["unsafe-url"] = {
        taskId: "unsafe-url", workspace: "repo", runDir,
        outputDir: path.join(runDir, "ask-bridge-output"), state: "needs_recovery",
        parentPid: null, childPid: null,
        children: { chatgpt: { provider: "chatgpt", jobId: "unsafe-job", state: "timed_out",
          threadUrl: "https://example.com/not-a-chatgpt-conversation", revision: 1 } },
      };
    });
    let getCalls = 0;
    await assert.rejects(
      () => collectTask("unsafe-url", { home, store, provider: "chatgpt", confirmComplete: true,
        run: async () => { getCalls += 1; return { code: 0 }; } }),
      { code: "NO_RECOVERY_URL" },
    );
    assert.equal(getCalls, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
