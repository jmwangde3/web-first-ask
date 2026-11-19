import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTask } from "../src/runner.js";
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
    defaultReasoning: { chatgpt: "high" },
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
    defaultReasoning: {},
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
