import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTask } from "../src/runner.js";
import { Store } from "../src/store.js";
import { workspaceHasBlockingTask } from "../src/state.js";

function argAfter(args, flag) {
  return args[args.indexOf(flag) + 1];
}

const config = {
  defaultProvider: "chatgpt",
  defaultTimeoutSeconds: 1200,
  maxTimeoutSeconds: 7200,
  maxConcurrency: 3,
  downloadImages: false,
};

test("dry-run previews a line-numbered bundle and never creates a task or launches ask-bridge", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-dry-run-home-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wfa-dry-run-repo-"));
  try {
    const source = path.join(workspaceRoot, "src.js");
    await writeFile(source, "const x = 1;\n");
    const store = new Store(home);
    let launches = 0;
    const result = await executeTask({
      kind: "code",
      prompt: "Update this file.",
      providers: ["chatgpt"],
      workspace: "repo",
      workspaceRoot,
      files: [source],
      bundleLines: true,
      dryRun: true,
      requestId: "dry-run-1",
    }, {
      home, store, config, skipPreflight: true,
      runProcess: async () => { launches += 1; throw new Error("must not launch"); },
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.preview.bundle.files[0].path, "src.js");
    assert.equal(result.preview.sendBlocked, false);
    assert.equal(launches, 0);
    assert.deepEqual((await store.snapshot()).tasks.tasks, {});
    await assert.rejects(access(path.join(home, "tasks.json")));
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("automatic project brief is injected only for providers creating a new session", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-brief-runner-home-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wfa-brief-runner-repo-"));
  try {
    await mkdir(path.join(workspaceRoot, ".wfa"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".wfa", "active-brief.md"), "# Project hot state\nCurrent focus: recovery.\n");
    const store = new Store(home);
    await store.transaction(({ sessions }) => {
      sessions.workspaces.repo = { chatgpt: "https://chatgpt.com/c/existing" };
    });

    const result = await executeTask({
      kind: "ask",
      prompt: "What should I do next?",
      providers: ["chatgpt", "gemini"],
      workspace: "repo",
      workspaceRoot,
      requestId: "brief-1",
    }, {
      home, store, config, skipPreflight: true,
      runProcess: async (_command, args, options) => {
        await options.onSpawn?.(process.pid);
        const jobs = (await readFile(argAfter(args, "--input"), "utf8")).trim().split("\n").map(JSON.parse);
        const byProvider = Object.fromEntries(jobs.map((job) => [job.provider, job]));
        assert.equal(byProvider.chatgpt.prompt.includes("Project hot state"), false);
        assert.equal(byProvider.gemini.prompt.includes("Project hot state"), true);
        assert.equal(byProvider.chatgpt.session, "https://chatgpt.com/c/existing");
        assert.equal(Object.hasOwn(byProvider.gemini, "session"), false);
        const outputDir = argAfter(args, "--output-dir");
        await Promise.all(jobs.map(async (job) => {
          const jobDir = path.join(outputDir, job.id);
          await mkdir(jobDir, { recursive: true });
          await writeFile(path.join(jobDir, "response.md"), `Answer from ${job.provider}`);
          await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
            id: job.id,
            provider: job.provider,
            state: "completed",
            threadUrl: job.provider === "chatgpt" ? "https://chatgpt.com/c/existing-2" : "https://gemini.google.com/app/new",
          }));
        }));
        return { code: 0, signal: null, stdout: "", stderr: "", spawnError: null };
      },
    });
    assert.deepEqual(result.task.briefInjectedProviders, ["gemini"]);
    assert.equal(result.task.children.chatgpt.state, "completed");
    assert.equal(result.task.children.gemini.state, "completed");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("WFA followup uses the completed parent's exact provider conversation and records lineage", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-followup-home-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wfa-followup-repo-"));
  try {
    const store = new Store(home);
    const parentRun = path.join(home, "runs", "parent");
    await mkdir(parentRun, { recursive: true });
    const parentResult = path.join(parentRun, "response.md");
    await writeFile(parentResult, "Parent answer, already stored in provider conversation.\n");
    await store.transaction(({ tasks }) => {
      tasks.tasks.parent = {
        taskId: "parent",
        kind: "ask",
        workspace: "repo",
        workspaceRoot,
        runDir: parentRun,
        children: {
          chatgpt: {
            provider: "chatgpt",
            jobId: "parent-job",
            state: "completed",
            threadUrl: "https://chatgpt.com/c/parent",
            resultPath: parentResult,
            revision: 3,
          },
        },
      };
    });

    const result = await executeTask({
      kind: "ask",
      prompt: "Continue with the next step.",
      providers: ["chatgpt"],
      workspace: "repo",
      workspaceRoot,
      followupTaskId: "parent",
      requestId: "followup-1",
    }, {
      home, store, config, skipPreflight: true,
      runProcess: async (_command, args, options) => {
        await options.onSpawn?.(process.pid);
        const jobs = (await readFile(argAfter(args, "--input"), "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(jobs[0].session, "https://chatgpt.com/c/parent");
        assert.match(jobs[0].prompt, /Continue with the next step/);
        assert.equal(jobs[0].prompt.includes("Parent answer"), false);
        const jobDir = path.join(argAfter(args, "--output-dir"), jobs[0].id);
        await mkdir(jobDir, { recursive: true });
        await writeFile(path.join(jobDir, "response.md"), "Follow-up answer");
        await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
          id: jobs[0].id, provider: "chatgpt", state: "completed",
          threadUrl: "https://chatgpt.com/c/parent",
        }));
        return { code: 0, signal: null, stdout: "", stderr: "", spawnError: null };
      },
    });
    assert.equal(result.task.parentTaskId, "parent");
    assert.equal(result.task.parentJobId, "parent-job");
    assert.equal(result.task.parentThreadUrl, "https://chatgpt.com/c/parent");
    assert.equal(result.task.children.chatgpt.state, "completed");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});


test("rate-limit cooldown survives an early explicit abandon and expires by timestamp", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const tasks = {
    task1: {
      taskId: "task1",
      workspace: "repo",
      children: {
        chatgpt: {
          state: "abandoned",
          errorCode: "RATE_LIMITED",
          retryAfterAt: future,
        },
      },
    },
  };
  const locked = workspaceHasBlockingTask(tasks, "repo", ["chatgpt"]);
  assert.equal(locked.cooldown, true);
  assert.equal(locked.cooldownUntil, future);

  tasks.task1.children.chatgpt.retryAfterAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(workspaceHasBlockingTask(tasks, "repo", ["chatgpt"]), null);
});

test("followup rejects a provider home URL and a mismatched repository root before launching", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-followup-unsafe-home-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wfa-followup-unsafe-repo-"));
  try {
    const store = new Store(home);
    const runDir = path.join(home, "runs", "parent");
    await mkdir(runDir, { recursive: true });
    const resultPath = path.join(runDir, "response.md");
    await writeFile(resultPath, "Parent result\n");
    await store.transaction(({ tasks }) => {
      tasks.tasks.parent = {
        taskId: "parent", workspace: "repo", workspaceRoot, runDir,
        children: { chatgpt: { state: "completed", provider: "chatgpt", jobId: "job-1",
          threadUrl: "https://chatgpt.com/", resultPath } },
      };
    });
    const task = {
      prompt: "Continue", workspace: "repo", workspaceRoot,
      providers: ["chatgpt"], followupTaskId: "parent", requestId: "followup-unsafe",
    };
    await assert.rejects(() => executeTask(task, { home, store, config, skipPreflight: true }),
      { code: "FOLLOWUP_URL_UNSAFE" });
    await store.transaction(({ tasks }) => {
      tasks.tasks.parent.children.chatgpt.threadUrl = "https://chatgpt.com/c/parent";
    });
    await assert.rejects(() => executeTask({ ...task, workspaceRoot: os.tmpdir() },
      { home, store, config, skipPreflight: true }), { code: "FOLLOWUP_WORKSPACE_MISMATCH" });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("HTTP 429 in stderr cannot make a provisional submitted job safely retryable", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-unknown-429-home-"));
  try {
    const store = new Store(home);
    const { task } = await executeTask({
      prompt: "Analyze safely", workspace: "repo", providers: ["chatgpt"],
      requestId: "unknown-429",
    }, { home, store, config, skipPreflight: true,
      runProcess: async (_command, args) => {
        const jobs = (await readFile(argAfter(args, "--input"), "utf8")).trim().split("\n").map(JSON.parse);
        const jobDir = path.join(argAfter(args, "--output-dir"), jobs[0].id);
        await mkdir(jobDir, { recursive: true });
        await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
          id: jobs[0].id, provider: "chatgpt", state: "in_progress", threadUrl: "https://chatgpt.com/c/pending",
        }));
        return { code: 1, stdout: "", stderr: `${jobs[0].id}: HTTP 429`, spawnError: null };
      },
    });
    assert.equal(task.children.chatgpt.state, "interrupted_unknown");
    await assert.rejects(() => executeTask({ prompt: "Do not resend", workspace: "repo", providers: ["chatgpt"] },
      { home, store, config, skipPreflight: true }), { code: "WORKSPACE_PROVIDER_LOCKED" });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
