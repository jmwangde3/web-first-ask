import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import { buildComparePrompt } from "../src/prompts.js";
import { executeTask } from "../src/runner.js";

const deprecatedCases = [
  ["--reasoning", ["ask", "--reasoning", "high", "--prompt", "test"]],
  ["--reasoning-map", ["compare", "--reasoning-map", "chatgpt=high", "--prompt", "test"]],
  ["--reasoning=value", ["ask", "--reasoning=high", "--prompt", "test"]],
];

for (const [label, args] of deprecatedCases) {
  test(`rejects disabled reasoning option ${label}`, async () => {
    await assert.rejects(
      () => main(args),
      (error) => error?.code === "REASONING_DISABLED",
    );
  });
}

test("browser-mode persists across CLI processes and preserves other config fields", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-browser-mode-"));
  try {
    const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
    const options = { env: { ...process.env, WFA_HOME: home }, encoding: "utf8" };
    const run = (...args) => spawnSync(process.execPath, [bin, "browser-mode", ...args], options);
    const config = path.join(home, "config.json");
    await writeFile(config, JSON.stringify({ defaultProvider: "gemini" }));

    assert.equal(run().stdout.trim(), "headless");
    assert.equal(run("headful").status, 0);
    assert.equal(run().stdout.trim(), "headful");
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
      defaultProvider: "gemini",
      browserMode: "headful",
    });
    assert.equal(run("invalid").status, 1);
    assert.equal(run().stdout.trim(), "headful");
    assert.equal(run("headless").status, 0);
    assert.equal(run().stdout.trim(), "headless");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("compare replay returns nonzero for a partial batch without losing the successful result", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-"));
  try {
    const prompt = "Compare the smoke-test inputs.";
    const { task } = await executeTask({
      kind: "compare", providers: ["chatgpt", "gemini"], prompt: buildComparePrompt(prompt),
      workspace: "repo", requestId: "partial-example", noRepo: true,
    }, {
      home,
      skipPreflight: true,
      runProcess: async (_command, args) => {
        const input = await readFile(args[args.indexOf("--input") + 1], "utf8");
        const output = args[args.indexOf("--output-dir") + 1];
        for (const line of input.trim().split("\n")) {
          const job = JSON.parse(line);
          const jobDir = path.join(output, job.id);
          const completed = job.provider === "chatgpt";
          await mkdir(jobDir, { recursive: true });
          if (completed) await writeFile(path.join(jobDir, "response.md"), "Sample answer");
          await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
            id: job.id,
            provider: job.provider,
            state: completed ? "completed" : "failed",
            threadUrl: job.provider === "chatgpt" ? "https://chatgpt.com/c/cli-test" : "https://gemini.google.com/app/cli-test",
            error: completed ? null : "synthetic failure",
          }));
        }
        return { code: 1, spawnError: null };
      },
    });
    const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
    const options = { env: { ...process.env, WFA_HOME: home }, encoding: "utf8" };
    const result = spawnSync(process.execPath, [
      bin, "compare", "--providers", "chatgpt,gemini", "--workspace", "repo",
      "--request-id", "partial-example", "--prompt", prompt,
      "--no-repo", "--continue-session", "--json",
    ], options);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.replayed, true);
    assert.equal(summary.state, "partial");
    assert.equal(await readFile(summary.providers.chatgpt.result, "utf8"), "Sample answer");
    assert.equal(summary.providers.gemini.state, "failed");
    const inspection = spawnSync(process.execPath, [bin, "status", task.taskId, "--json"], options);
    assert.equal(inspection.status, 0);
    assert.equal(JSON.parse(inspection.stdout).state, "partial");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("--version answers before any store, config or provider work", async () => {
  const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-version-"));
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const run = spawnSync(process.execPath, [bin, "--version"], {
      env: { ...process.env, WFA_HOME: home, NODE_OPTIONS: "" }, encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), `wfa ${pkg.version}`);
    // No store was created just to print a version.
    assert.deepEqual(await readdir(home).catch(() => []), []);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("unlock clears a dead owner's lock and says so", async () => {
  const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-unlock-"));
  try {
    await writeFile(path.join(home, ".store.lock"), JSON.stringify({
      pid: 999999, host: os.hostname(), createdAt: Date.now() - 60000, token: "dead",
    }));
    const cleared = spawnSync(process.execPath, [bin, "unlock", "--json"], {
      env: { ...process.env, WFA_HOME: home, NODE_OPTIONS: "" }, encoding: "utf8",
    });
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(JSON.parse(cleared.stdout).removed, true);
    const idle = spawnSync(process.execPath, [bin, "unlock"], {
      env: { ...process.env, WFA_HOME: home, NODE_OPTIONS: "" }, encoding: "utf8",
    });
    assert.equal(idle.status, 0);
    assert.match(idle.stdout, /Nothing to clear/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("list --no-refresh reads without taking the write lock", async () => {
  const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-list-"));
  try {
    await writeFile(path.join(home, "tasks.json"), JSON.stringify({
      version: 1, requestIndex: {},
      tasks: { "task-1": { taskId: "task-1", workspace: "demo", kind: "ask", state: "running",
        createdAt: new Date().toISOString(), children: { chatgpt: { state: "running", jobId: "wfa-chatgpt-1" } } } },
    }));
    // A lock owned by a live process: any lock-taking read would block for the
    // whole wait budget, so a fast answer proves the read path stays lock-free.
    await writeFile(path.join(home, ".store.lock"), JSON.stringify({
      pid: process.pid, host: os.hostname(), createdAt: Date.now(), token: "held",
    }));
    const started = Date.now();
    const run = spawnSync(process.execPath, [bin, "list", "--no-refresh"], {
      env: { ...process.env, WFA_HOME: home, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /task-1/);
    assert.ok(Date.now() - started < 10000, "list must not wait for the lock");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("list rejects non-integer and non-positive --limit values", async () => {
  const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-list-limit-"));
  try {
    for (const value of ["abc", "0", "-2", "1.5"]) {
      const run = spawnSync(process.execPath, [bin, "list", "--limit", value], {
        env: { ...process.env, WFA_HOME: home, NODE_OPTIONS: "" },
        encoding: "utf8",
      });
      assert.equal(run.status, 1, `--limit ${value}: ${run.stderr}`);
      assert.match(run.stderr, /Invalid --limit/);
      assert.match(run.stderr, /Hint: use --limit 20/);
      assert.equal(run.stdout, "");
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
