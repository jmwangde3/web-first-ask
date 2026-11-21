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
        assert.deepEqual(args.slice(0, 4), ["--backend", "browser", "--headless=true", "batch"]);
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    }, { home, store, config, skipPreflight: true }), /locked by chatgpt task/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("status preserves the current legacy session and an already collected result", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-status-"));
  try {
    const store = new Store(home);
    const runDir = path.join(home, "old-run");
    const outputDir = path.join(runDir, "ask-bridge-output");
    const jobDir = path.join(outputDir, "old-job");
    const oldUrl = "https://chatgpt.com/c/old";
    const newUrl = "https://chatgpt.com/c/new";
    const recoveredPath = path.join(home, "recovered.md");
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
      id: "old-job", provider: "chatgpt", state: "completed", threadUrl: oldUrl, error: null,
    }));
    await writeFile(path.join(jobDir, "response.md"), "Old batch response");
    await writeFile(recoveredPath, "Verified recovered response");
    await store.transaction(({ tasks, sessions }) => {
      tasks.tasks.old = {
        taskId: "old", workspace: "repo", runDir, outputDir, createdAt: "2026-01-01T00:00:00Z",
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
        await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
          id: jobs[0].id, provider: jobs[0].provider, state: "completed",
          threadUrl: "https://chatgpt.com/c/completed", error: null,
        }));
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
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("new task reconciles a stale completed-task cleanup lock before checking workspace/provider locks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-stale-execution-lock-"));
  const store = new Store(home);
  const runDir = path.join(home, "runs", "old-task");
  const outputDir = path.join(runDir, "ask-bridge-output");
  const savedResult = path.join(runDir, "saved.md");
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(savedResult, "old completed result");
    await store.transaction(({ tasks }) => {
      tasks.tasks["old-task"] = {
        taskId: "old-task", workspace: "repo", workspaceRoot: home, runDir, outputDir,
        state: "completed", executionPending: true, childPid: 2147483000, parentPid: null,
        children: { chatgpt: {
          provider: "chatgpt", jobId: "old-job", state: "completed",
          resultPath: savedResult, threadUrl: "https://chatgpt.com/c/old", revision: 2,
        } },
      };
    });
    let launches = 0;
    const result = await executeTask({
      prompt: "Start the next independent request.", provider: "chatgpt", workspace: "repo",
    }, {
      home, store, skipPreflight: true,
      runProcess: async (_command, args) => {
        launches += 1;
        const input = (await readFile(argAfter(args, "--input"), "utf8")).trim();
        const job = JSON.parse(input);
        const jobDir = path.join(argAfter(args, "--output-dir"), job.id);
        await mkdir(jobDir, { recursive: true });
        await writeFile(path.join(jobDir, "response.md"), "new answer");
        await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
          id: job.id, provider: job.provider, state: "completed",
          threadUrl: "https://chatgpt.com/c/new", elapsedSeconds: 1, error: null,
        }));
        return { code: 0, signal: null, stdout: "Completed", stderr: "", spawnError: null };
      },
    });
    assert.equal(launches, 1);
    assert.equal(result.task.state, "completed");
    assert.equal((await store.snapshot()).tasks.tasks["old-task"].executionPending, false);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a provider left behind by a serial batch is retried alone and the retry is recorded", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-runner-"));
  const store = new Store(home);
  const config = {
    defaultProvider: "chatgpt",
    defaultProviders: ["chatgpt", "gemini"],
    defaultConcurrency: 1,
    defaultTimeoutSeconds: 1200,
    maxTimeoutSeconds: 7200,
    maxConcurrency: 3,
    downloadImages: false,
  };
  const tabClosed = "failed to open tab: list_pages failed: The selected page has been closed";
  const progress = [];
  const batches = [];
  try {
    const result = await executeTask({
      prompt: "Explain why the second job loses its tab.",
      providers: ["chatgpt", "gemini"],
      workspace: "sample-repo",
      timeoutSeconds: 1200,
      onProgressLine: (stream, line) => progress.push(line),
    }, {
      home, store, config, skipPreflight: true,
      runProcess: async (_command, args) => {
        assert.equal(argAfter(args, "--concurrency"), "1");
        const outputDir = argAfter(args, "--output-dir");
        const jobs = (await readFile(argAfter(args, "--input"), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line));
        batches.push(jobs.map((job) => job.provider));

        if (jobs.length === 2) {
          // Serial batch: the first job completes, then ask-bridge closes the tab
          // and the second job fails before submitting anything.
          await mkdir(path.join(outputDir, jobs[0].id), { recursive: true });
          await writeFile(path.join(outputDir, jobs[0].id, "response.md"), "first answer");
          await writeFile(path.join(outputDir, jobs[0].id, "metadata.json"), JSON.stringify({
            id: jobs[0].id, provider: jobs[0].provider, state: "completed",
            threadUrl: "https://chatgpt.com/c/c1", elapsedSeconds: 16,
          }));
          await mkdir(path.join(outputDir, jobs[1].id), { recursive: true });
          await writeFile(path.join(outputDir, jobs[1].id, "metadata.json"), JSON.stringify({
            id: jobs[1].id, provider: jobs[1].provider, state: "failed", error: tabClosed,
          }));
          return { code: 1, signal: null, stdout: "", stderr: "", spawnError: null };
        }

        assert.deepEqual(jobs.map((job) => job.provider), ["gemini"]);
        const jobDir = path.join(outputDir, jobs[0].id);
        await mkdir(jobDir, { recursive: true });
        await writeFile(path.join(jobDir, "response.md"), "retried answer");
        await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
          id: jobs[0].id, provider: "gemini", state: "completed",
          threadUrl: "https://gemini.google.com/app/g1", elapsedSeconds: 10,
        }));
        return { code: 0, signal: null, stdout: "", stderr: "", spawnError: null };
      },
    });

    assert.deepEqual(batches, [["chatgpt", "gemini"], ["gemini"]]);
    assert.equal(result.task.state, "completed");
    assert.equal(result.task.children.gemini.state, "completed");
    assert.equal(result.task.children.gemini.retriedAsSingleBatch, true);
    assert.equal(result.task.children.chatgpt.retriedAsSingleBatch, undefined);
    assert.equal(await readFile(result.task.children.gemini.resultPath, "utf8"), "retried answer");
    assert.equal(result.task.retryWarnings.length, 1);
    assert.match(result.task.retryWarnings[0], /Retried gemini as a single batch/);
    assert.ok(progress.some((line) => line.includes("retrying gemini alone")));
    assert.equal((await store.snapshot()).sessions.workspaces["sample-repo"].gemini, "https://gemini.google.com/app/g1");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a provider that failed after submitting is never retried automatically", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-runner-"));
  const store = new Store(home);
  const config = {
    defaultProvider: "chatgpt",
    defaultProviders: ["chatgpt", "gemini"],
    defaultConcurrency: 1,
    defaultTimeoutSeconds: 1200,
    maxTimeoutSeconds: 7200,
    maxConcurrency: 3,
    downloadImages: false,
  };
  let launches = 0;
  try {
    const result = await executeTask({
      prompt: "Do not double-submit.",
      providers: ["chatgpt", "gemini"],
      workspace: "sample-repo",
      timeoutSeconds: 1200,
    }, {
      home, store, config, skipPreflight: true,
      runProcess: async (_command, args) => {
        launches += 1;
        const outputDir = argAfter(args, "--output-dir");
        const jobs = (await readFile(argAfter(args, "--input"), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line));
        for (const job of jobs) {
          const jobDir = path.join(outputDir, job.id);
          await mkdir(jobDir, { recursive: true });
          await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
            id: job.id, provider: job.provider, state: "failed",
            // Same wording, but the tab URL proves the prompt already reached a conversation.
            threadUrl: job.provider === "gemini" ? "https://gemini.google.com/app/g1" : null,
            error: job.provider === "gemini"
              ? "list_pages failed: The selected page has been closed"
              : "response did not complete",
          }));
        }
        return { code: 1, signal: null, stdout: "", stderr: "", spawnError: null };
      },
    });

    assert.equal(launches, 1);
    assert.equal(result.task.children.gemini.state, "failed");
    assert.equal(result.task.children.gemini.retriedAsSingleBatch, undefined);
    assert.equal(result.task.retryWarnings, undefined);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
