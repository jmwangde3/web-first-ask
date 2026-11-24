import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTask } from "../src/runner.js";
import { collectTask, waitForTask } from "../src/recovery.js";
import { spawnDetached } from "../src/ask-bridge.js";
import { Store } from "../src/store.js";
import { main } from "../src/cli.js";

async function createUncertainTask(home, taskId = "unknown") {
  const store = new Store(home);
  const runDir = path.join(home, "runs", taskId);
  await mkdir(runDir, { recursive: true });
  await store.transaction(({ tasks }) => {
    tasks.tasks[taskId] = {
      taskId, workspace: "demo", workspaceRoot: home, kind: "ask",
      state: "interrupted_unknown", runDir,
      outputDir: path.join(runDir, "ask-bridge-output"), parentPid: null, childPid: null,
      children: {
        chatgpt: {
          provider: "chatgpt", jobId: "job1", state: "interrupted_unknown",
          threadUrl: "https://chatgpt.com/c/test-12345", childPid: null, revision: 1,
        },
      },
    };
  });
  return { store, runDir };
}

test("stale partial answer cannot be auto-collected even if its text is identical", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-safe-confirm-"));
  try {
    const { store } = await createUncertainTask(home);
    let getCalls = 0;
    await assert.rejects(
      () => collectTask("unknown", { home, store, autoConfirm: true,
        run: async () => { getCalls++; return { code: 0 }; } }),
      { code: "CONFIRMATION_REQUIRED" },
    );
    assert.equal(getCalls, 0);
    const task = (await store.snapshot()).tasks.tasks.unknown;
    assert.equal(task.children.chatgpt.state, "interrupted_unknown");
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("wait and attach remain read-only for an uncertain task", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-safe-wait-"));
  try {
    const { store } = await createUncertainTask(home);
    const result = await waitForTask("unknown", { home, store, timeoutSeconds: 0, pollMs: 250 });
    assert.equal(result.task.children.chatgpt.state, "interrupted_unknown");
    assert.deepEqual(result.collected, []);
    await assert.rejects(() => waitForTask("unknown", { home, store, timeoutSeconds: 1, pollMs: 0 }), { code: "INVALID_POLL_INTERVAL" });
    const after = (await store.snapshot()).tasks.tasks.unknown;
    assert.equal(after.children.chatgpt.resultPath ?? null, null);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("detached spawn resolves only after spawn event and rejects invalid command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-safe-spawn-"));
  try {
    await assert.rejects(
      () => spawnDetached("definitely-invalid-wfa-command-718", [], {
        cwd: root, stdoutPath: path.join(root, "stdout"), stderrPath: path.join(root, "stderr"),
      }),
      (error) => error.code === "ENOENT" || error.code === "EACCES",
    );
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("failed detached launch records failed_before_start rather than running", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-safe-home-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "wfa-safe-repo-"));
  try {
    const store = new Store(home);
    const output = await executeTask({ prompt: "Review task", providers: ["chatgpt"], workspace: "demo",
      workspaceRoot: repo, detach: true }, {
      home, store, skipPreflight: true,
      spawnDetached: async () => { throw new Error("executable not found"); },
    });
    assert.equal(output.detached, false);
    assert.equal(output.task.state, "failed");
    assert.equal(output.task.children.chatgpt.state, "failed_before_start");
    assert.match(output.task.children.chatgpt.error, /executable not found/);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("detached launch persists lineage and task log paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-safe-detach-home-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "wfa-safe-detach-repo-"));
  try {
    const store = new Store(home);
    const parentRunDir = path.join(home, "runs", "parent");
    await mkdir(parentRunDir, { recursive: true });
    await writeFile(path.join(parentRunDir, "response.md"), "already complete", "utf8");
    await store.transaction(({ tasks }) => {
      tasks.tasks.parent = { taskId: "parent", workspace: "demo", workspaceRoot: repo,
        runDir: parentRunDir, providers: ["chatgpt"], state: "completed", lineage: [],
        children: {chatgpt: { provider: "chatgpt", jobId: "parent-job", state: "completed",
          threadUrl: "https://chatgpt.com/c/test-12345", resultPath: path.join(parentRunDir, "response.md") }} };
    });
    let launchOpts;
    await writeFile(path.join(home, "config.json"), JSON.stringify({ browserMode: "headful" }));
    const output = await executeTask({ prompt: "Add tests", providers: ["chatgpt"],
      workspace: "demo", workspaceRoot: repo, followupTaskId: "parent", detach: true },
    { home, store, skipPreflight: true, spawnDetached: async (_cmd, args, opts) => {
      assert.deepEqual(args.slice(0, 4), ["--backend", "browser", "--headless=false", "batch"]);
      launchOpts = opts; return { pid: 999999 };
    }});
    assert.equal(output.detached, true);
    assert.equal(output.task.childPid, 999999);
    assert.equal(output.task.parentTaskId, "parent");
    assert.deepEqual(output.task.lineage, ["parent"]);
    assert.equal(launchOpts.stdoutPath, path.join(output.task.runDir, "batch.stdout.log"));
    assert.equal(launchOpts.stderrPath, path.join(output.task.runDir, "batch.stderr.log"));
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

