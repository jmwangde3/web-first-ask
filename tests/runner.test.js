import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTask, refreshTask } from "../src/runner.js";
import { Store } from "../src/store.js";

function argAfter(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test("one CLI task runs ChatGPT and Gemini in parallel and persists independent results/sessions", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-runner-"));
  let launches = 0;
  const store = new Store(home);
  const config = {
    defaultProvider: "chatgpt",
    defaultTimeoutSeconds: 1200,
    maxTimeoutSeconds: 7200,
    maxConcurrency: 3,

    downloadImages: false,
  };
  try {
    const result = await executeTask({
      kind: "compare",
      prompt: "Compare independently.",
      providers: ["chatgpt", "gemini"],
      workspace: "sample-repo",
      timeoutSeconds: 1200,
      requestId: "compare-001",
    }, {
      home,
      store,
      config,
      skipPreflight: true,
      runProcess: async (_command, args, options) => {
        launches += 1;
        await options.onSpawn?.(999999);
        const inputFile = argAfter(args, "--input");
        const outputDir = argAfter(args, "--output-dir");
        const jobs = (await readFile(inputFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(jobs.length, 2);
        assert.equal(jobs[0].prompt, jobs[1].prompt);
        assert.equal(Object.hasOwn(jobs[0], "reasoning"), false);
        assert.equal(Object.hasOwn(jobs[1], "reasoning"), false);
        await Promise.all(jobs.map(async (job) => {
          const jobDir = path.join(outputDir, job.id);
          await mkdir(jobDir, { recursive: true });
          await writeFile(path.join(jobDir, "response.md"), `Answer from ${job.provider}`);
          await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
            id: job.id,
            provider: job.provider,
            state: "completed",
            threadUrl: job.provider === "chatgpt" ? "https://chatgpt.com/c/c1" : "https://gemini.google.com/app/g1",
            elapsedSeconds: 12,
          }));
        }));
        return { code: 0, signal: null, stdout: "Completed: 2", stderr: "", spawnError: null };
      },
    });

    assert.equal(result.task.state, "completed");
    assert.equal(result.task.providers.length, 2);
    assert.equal(launches, 1);
    assert.equal(result.task.children.chatgpt.state, "completed");
    assert.equal(result.task.children.gemini.state, "completed");
    const snapshot = await store.snapshot();
    assert.equal(snapshot.sessions.workspaces["sample-repo"].chatgpt, "https://chatgpt.com/c/c1");
    assert.equal(snapshot.sessions.workspaces["sample-repo"].gemini, "https://gemini.google.com/app/g1");

    const replay = await executeTask({
      kind: "compare",
      prompt: "Compare independently.",
      providers: ["chatgpt", "gemini"],
      workspace: "sample-repo",
      timeoutSeconds: 1200,
      requestId: "compare-001",
    }, { home, store, config, skipPreflight: true, runProcess: async () => { launches += 1; throw new Error("must not relaunch"); } });
    assert.equal(replay.replayed, true);
    assert.equal(launches, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("request ID with changed content is rejected and ambiguous task blocks duplicate provider send", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-runner-"));
  const store = new Store(home);
  const config = {
    defaultProvider: "chatgpt",
    defaultTimeoutSeconds: 1200,
    maxTimeoutSeconds: 7200,
    maxConcurrency: 3,

    downloadImages: false,
  };
  try {
    await executeTask({
      prompt: "Original",
      providers: ["chatgpt"],
      workspace: "sample-repo",
      requestId: "same-id",
    }, {
      home, store, config, skipPreflight: true,
      runProcess: async (_command, args) => {
        const outputDir = argAfter(args, "--output-dir");
        const inputFile = argAfter(args, "--input");
        const job = JSON.parse((await readFile(inputFile, "utf8")).trim());
        const jobDir = path.join(outputDir, job.id);
        await mkdir(jobDir, { recursive: true });
        await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
          id: job.id, provider: "chatgpt", state: "timed_out",
          threadUrl: "https://chatgpt.com/c/pending", error: "response did not complete",
        }));
        return { code: 1, signal: null, stdout: "", stderr: "", spawnError: null };
      },
    });

    await assert.rejects(() => executeTask({
      prompt: "Changed prompt",
      providers: ["chatgpt"],
      workspace: "sample-repo",
      requestId: "same-id",
    }, { home, store, config, skipPreflight: true }), /different payload/);

    await assert.rejects(() => executeTask({
      prompt: "A new question",
      providers: ["chatgpt"],
      workspace: "sample-repo",
      requestId: "new-id",
    }, { home, store, config, skipPreflight: true }), /unresolved chatgpt task/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status preserves the current legacy session and an already collected result", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-status-"));
  try {
    const store = new Store(home);
    const outputDir = path.join(home, "batch");
    const jobDir = path.join(outputDir, "old-job");
    const oldUrl = "https://chatgpt.com/c/old";
    const newUrl = "https://chatgpt.com/c/new";
    const recoveredPath = path.join(home, "recovered.md");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "completed", threadUrl: oldUrl }));
    await writeFile(path.join(jobDir, "response.md"), "Old batch response");
    await writeFile(recoveredPath, "Verified recovered response");
    await store.transaction(({ tasks, sessions }) => {
      tasks.tasks.old = {
        taskId: "old", workspace: "repo", outputDir, createdAt: "2026-01-01T00:00:00Z",
        children: {
          chatgpt: { provider: "chatgpt", jobId: "old-job", state: "completed", threadUrl: oldUrl, resultPath: recoveredPath },
        },
      };
      tasks.tasks.new = {
        taskId: "new", workspace: "repo", createdAt: "2026-01-02T00:00:00Z",
        children: {
          chatgpt: { provider: "chatgpt", state: "completed", threadUrl: newUrl },
        },
      };
      sessions.workspaces.repo = { chatgpt: newUrl, gemini: "https://gemini.google.com/app/unchanged" };
    });

    const task = await refreshTask("old", { home, store });
    assert.equal(task.children.chatgpt.resultPath, recoveredPath);
    const { sessions } = await store.snapshot();
    assert.equal(sessions.workspaces.repo.chatgpt, newUrl);
    assert.equal(sessions.workspaces.repo.gemini, "https://gemini.google.com/app/unchanged");

    await store.transaction(({ tasks }) => {
      const child = tasks.tasks.old.children.chatgpt;
      child.state = "interrupted_unknown";
      child.resultPath = null;
    });
    const reconciled = await refreshTask("old", { home, store });
    assert.equal(reconciled.children.chatgpt.state, "completed");
    assert.equal(reconciled.children.chatgpt.resultPath, path.join(jobDir, "response.md"));
    assert.equal((await store.snapshot()).sessions.workspaces.repo.chatgpt, newUrl);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a post-launch process error preserves a finished result and keeps the uncertain provider locked", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-process-error-"));
  try {
    const store = new Store(home);
    const { task } = await executeTask({
      prompt: "Compare two independent results.", providers: ["chatgpt", "gemini"], workspace: "repo",
    }, {
      home, store, skipPreflight: true,
      runProcess: async (_command, args) => {
        const jobs = (await readFile(argAfter(args, "--input"), "utf8")).trim().split("\n").map(JSON.parse);
        const jobDir = path.join(argAfter(args, "--output-dir"), jobs[0].id);
        await mkdir(jobDir, { recursive: true });
        await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "completed" }));
        await writeFile(path.join(jobDir, "response.md"), "Completed ChatGPT answer");
        return {
          code: null, spawnError: null, processError: new Error("Termination failed"),
          childMayRun: true, pid: process.pid,
        };
      },
    });
    assert.equal(task.state, "needs_recovery");
    assert.equal(task.children.chatgpt.state, "completed");
    assert.equal(await readFile(task.children.chatgpt.resultPath, "utf8"), "Completed ChatGPT answer");
    assert.equal(task.children.gemini.state, "interrupted_unknown");
    assert.equal(task.children.gemini.childPid, process.pid);
    await assert.rejects(
      () => executeTask({ prompt: "Do not resend.", provider: "gemini", workspace: "repo" }, { home, store, skipPreflight: true }),
      { code: "WORKSPACE_PROVIDER_LOCKED" },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
