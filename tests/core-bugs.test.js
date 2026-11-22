import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRepository, repositoryBlock, bundleRepository, repositoryFallbackCommand } from "../src/repository.js";
import { prepareChromeStartup, runProcess } from "../src/ask-bridge.js";
import { executeTask } from "../src/runner.js";
import { Store } from "../src/store.js";
import { abandonProvider } from "../src/recovery.js";
import { runDetachedBatchWorker } from "../src/runner.js";
import { main as runCli } from "../src/cli.js";
import { parseFileBlocks, stageTaskFiles, applyStagedFiles } from "../src/stage.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];
const config = { defaultProvider: "chatgpt", defaultProviders: ["chatgpt", "gemini"],
  defaultConcurrency: 1, defaultTimeoutSeconds: 1200, maxTimeoutSeconds: 7200,
  maxConcurrency: 3, downloadImages: false };

async function withRepo(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-fixes-repo-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-fixes-home-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "wfa@example.test");
    git(root, "config", "user.name", "wfa");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "main.js"), "export const a = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    git(root, "remote", "add", "origin", "https://github.com/acme/fake.git");
    return await fn({ root, home });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function completeJob(_command, args, opts = {}) {
  await opts.onSpawn?.(process.pid);
  const jobs = (await readFile(argAfter(args, "--input"), "utf8")).trim().split("\n").map(JSON.parse);
  for (const job of jobs) {
    const directory = path.join(argAfter(args, "--output-dir"), job.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "response.md"), `Answer from ${job.provider}\n`);
    await writeFile(path.join(directory, "metadata.json"), JSON.stringify({
      id: job.id, provider: job.provider, state: "completed", error: null,
      threadUrl: job.provider === "gemini" ? "https://gemini.google.com/app/fixes" : "https://chatgpt.com/c/fixes",
    }));
  }
  return { code: 0, signal: null, stdout: `done ${jobs[0].provider}\n`,
    stderr: `stderr ${jobs[0].provider}\n`, spawnError: null };
}

test("dirty files and commits unreachable from origin tracking are visibly warned about", async () => withRepo(async ({ root }) => {
  const initial = await resolveRepository({ cwd: root });
  assert.equal(initial.pushVerified, false);
  assert.equal(initial.safeToReference, false);
  assert.match(repositoryBlock(initial), /LOCAL STATE WARNINGS/);
  await writeFile(path.join(root, "src", "main.js"), "export const a = 2;\n");
  await writeFile(path.join(root, "not-tracked.txt"), "unknown");
  const dirty = await resolveRepository({ cwd: root });
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.dirtyFileCount, 2);
  assert.ok(dirty.dirtyFiles.includes("src/main.js"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "second");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD~1"));
  const afterCommit = await resolveRepository({ cwd: root });
  assert.equal(afterCommit.dirty, false);
  assert.equal(afterCommit.unpushedCommits, 1);
  assert.equal(afterCommit.safeToReference, false);
}));

test("repo bundle begins with tree and supports exclusions; code fallback remains code", async () => withRepo(async ({ root }) => {
  await writeFile(path.join(root, "src", "extra.js"), "export const extra = true;\n");
  git(root, "add", ".");
  const selected = await bundleRepository({ cwd: root, includes: ["src/main.js"], excludes: ["src/extra.js"] });
  assert.match(selected.content, /DIRECTORY TREE/);
  assert.match(selected.content, /FILE: src\/main.js/);
  assert.doesNotMatch(selected.content, /FILE: src\/extra.js/);
  assert.match(repositoryFallbackCommand("parent", "chatgpt", "demo", "code"), /^wfa code /);
  assert.match(repositoryFallbackCommand("parent", "chatgpt", "demo", "code"), /FILE: path/);
}));

test("managed runner serializes two providers as two single-job batches", async () => withRepo(async ({ root, home }) => {
  const store = new Store(home);
  const batches = [];
  const result = await executeTask({ prompt: "Analyze main.js", providers: ["chatgpt", "gemini"],
    workspace: "fixes", workspaceRoot: root }, {
    home, store, config, skipPreflight: true,
    runProcess: async (...args) => {
      const jobs = (await readFile(argAfter(args[1], "--input"), "utf8")).trim().split("\n").map(JSON.parse);
      batches.push(jobs.map((item) => item.provider));
      return completeJob(...args);
    },
  });
  assert.deepEqual(batches, [["chatgpt"], ["gemini"]]);
  assert.equal(result.task.state, "completed");
  for (const provider of ["chatgpt", "gemini"]) {
    assert.equal(result.task.children[provider].state, "completed");
    const logs = result.task.children[provider].batchLogs;
    assert.match(await readFile(logs.stdout, "utf8"), new RegExp(provider));
    assert.match(await readFile(logs.stderr, "utf8"), new RegExp(provider));
  }
}));

test("detached two-provider run launches a task-bound WFA worker, not a multi-job ask-bridge", async () => withRepo(async ({ root, home }) => {
  const store = new Store(home);
  let launched;
  const result = await executeTask({ prompt: "Analyze", providers: ["chatgpt", "gemini"],
    workspace: "fixes", workspaceRoot: root, detach: true }, {
    home, store, config, skipPreflight: true,
    spawnDetached: async (command, args) => { launched = { command, args }; return { pid: 2147483000 }; },
  });
  assert.equal(result.detached, true);
  assert.equal(launched.command, process.execPath);
  assert.equal(launched.args[1], "__batch-worker");
  assert.equal(launched.args[2], result.task.taskId);
  assert.equal(launched.args[3], result.task.workerToken);
  assert.ok(result.task.workerToken);
  await assert.rejects(() => runDetachedBatchWorker(result.task.taskId, "not-the-token", { home, store }),
    { code: "INVALID_BATCH_WORKER" });
  await store.transaction(({ tasks }) => {
    tasks.tasks[result.task.taskId].workerClaimedAt = new Date().toISOString();
  });
  await assert.rejects(() => runDetachedBatchWorker(result.task.taskId, result.task.workerToken, { home, store }),
    { code: "INVALID_BATCH_WORKER" });
  assert.equal(result.task.serialWorker, true);
  assert.equal(result.task.parentPid, 2147483000);
}));

test("leading ./ works; missing or repeated exact ANCHOR fails", async () => withRepo(async ({ root, home }) => {
  const store = new Store(home);
  const runDir = path.join(home, "runs", "manual");
  await mkdir(runDir, { recursive: true });
  const resultPath = path.join(runDir, "response.md");
  const answer = "FILE: ./src/main.js\nANCHOR:\n```js\nexport const a = 1;\n```\nREPLACE:\n```js\nexport const a = 2;\n```\n";
  await writeFile(resultPath, answer);
  await store.transaction(({ tasks }) => {
    tasks.tasks.manual = { taskId: "manual", kind: "code", mode: "full-file", runDir,
      workspaceRoot: root, children: { chatgpt: { state: "completed", resultPath } } };
  });
  assert.equal(parseFileBlocks(answer)[0].kind, "replace");
  const staged = await stageTaskFiles("manual", { provider: "chatgpt", home, store });
  assert.equal(staged.files[0].path, "src/main.js");
  assert.equal(await readFile(path.join(root, "src/main.js"), "utf8"), "export const a = 1;\n");
  await applyStagedFiles("manual", { provider: "chatgpt", home, store, confirm: true });
  assert.equal(await readFile(path.join(root, "src/main.js"), "utf8"), "export const a = 2;\n");
  await writeFile(resultPath, answer.replace("export const a = 1;", "missing anchor"));
  await assert.rejects(() => stageTaskFiles("manual", { provider: "chatgpt", home, store }), { code: "ANCHOR_NOT_FOUND" });
  await writeFile(path.join(root, "src/main.js"), "duplicate\nduplicate\n");
  await writeFile(resultPath, answer.replace("export const a = 1;", "duplicate"));
  await assert.rejects(() => stageTaskFiles("manual", { provider: "chatgpt", home, store }), { code: "ANCHOR_AMBIGUOUS" });
}));

test("LaTeX pollution blocks stage and apply, including after a prior valid stage", async () => withRepo(async ({ root, home }) => {
  const store = new Store(home);
  const runDir = path.join(home, "runs", "latex");
  await mkdir(runDir, { recursive: true });
  const resultPath = path.join(runDir, "response.md");
  await writeFile(resultPath, "FILE: src/main.js\n```js\nconst safe = true;\n```\n");
  await store.transaction(({ tasks }) => {
    tasks.tasks.latex = { taskId: "latex", kind: "code", mode: "full-file", runDir,
      workspaceRoot: root, children: { gemini: { state: "completed", resultPath } } };
  });
  await stageTaskFiles("latex", { provider: "gemini", home, store });
  await writeFile(resultPath, "FILE: src/main.js\n```js\nconst damaged = \\vert{};\n```\n");
  await assert.rejects(() => stageTaskFiles("latex", { provider: "gemini", home, store }),
    { code: "RESPONSE_LATEX_CORRUPTED" });
  await assert.rejects(() => applyStagedFiles("latex", { provider: "gemini", home, store, confirm: true }),
    { code: "RESPONSE_LATEX_CORRUPTED" });
}));

test("Chrome restore and log rotation are integrated and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-chrome-start-"));
  try {
    const profileDir = path.join(root, "chrome-profile", "Default");
    await mkdir(profileDir, { recursive: true });
    const prefs = path.join(profileDir, "Preferences");
    await writeFile(prefs, JSON.stringify({ profile: { exit_type: "Crashed" }, other: 42 }));
    const log = path.join(root, "chrome-devtools-mcp.log");
    await writeFile(log, Buffer.alloc(65 * 1024 * 1024, 65));
    const preview = await prepareChromeStartup({ root, apply: false });
    assert.equal(preview.repairedProfiles.length, 0);
    assert.equal(preview.crashedProfiles.length, 1);
    const fixed = await prepareChromeStartup({ root });
    assert.equal(fixed.repairedProfiles.length, 1);
    assert.equal(fixed.logRotated, true);
    assert.equal((await stat(log)).size, 4 * 1024 * 1024);
    assert.equal(JSON.parse(await readFile(prefs, "utf8")).profile.exit_type, "Normal");
    const again = await prepareChromeStartup({ root });
    assert.equal(again.repairedProfiles.length, 0);
    assert.equal(again.logRotated, false);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("aborting a foreground process retains already-emitted logs", async () => {
  const signal = new AbortController();
  let seen = "";
  const result = await runProcess(process.execPath,
    ["-e", "process.stdout.write('first-line\\n'); setInterval(() => {}, 1000)"], {
      timeoutMs: 3000, killGraceMs: 50, abortSignal: signal.signal,
      onStdoutLine: (line) => { seen = line; signal.abort(); },
    });
  assert.match(seen, /first-line/);
  assert.match(result.stdout, /first-line/);
  assert.equal(result.aborted, true);
});

test("single-job pre-submit retry saves per-provider logs and refresh can read them", async () => withRepo(async ({ root, home }) => {
  const store = new Store(home);
  const calls = [];
  const result = await executeTask({ prompt: "Retry a closed tab safely", providers: ["chatgpt", "gemini"],
    workspace: "retry", workspaceRoot: root }, {
    home, store, config, skipPreflight: true,
    runProcess: async (command, args, opts) => {
      const jobs = (await readFile(argAfter(args, "--input"), "utf8")).trim().split("\n").map(JSON.parse);
      const job = jobs[0];
      calls.push(job.provider);
      if (job.provider === "gemini" && calls.filter((p) => p === "gemini").length === 1) {
        const directory = path.join(argAfter(args, "--output-dir"), job.id);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "metadata.json"), JSON.stringify({
          id: job.id, provider: "gemini", state: "failed",
          error: "failed to open tab: list_pages failed: The selected page has been closed",
        }));
        return { code: 1, signal: null, stdout: "before retry", stderr: "tab closed", spawnError: null };
      }
      const completed = await completeJob(command, args, opts);
      return { ...completed, stdout: `final ${job.provider}\n`, stderr: `retry ${job.provider}\n` };
    },
  });
  assert.deepEqual(calls, ["chatgpt", "gemini", "gemini"]);
  assert.equal(result.task.children.gemini.state, "completed");
  assert.equal(result.task.children.gemini.retriedAsSingleBatch, true);
  const logs = result.task.children.gemini.retryLogs;
  assert.match(logs.stdout, /batch\.stdout\.gemini\.retry\.log$/);
  assert.equal(await readFile(logs.stderr, "utf8"), "retry gemini\n");
}));

test("exact ANCHOR/REPLACE preserves original CRLF line endings", async () => withRepo(async ({ root, home }) => {
  const sourcePath = path.join(root, "src", "main.js");
  await writeFile(sourcePath, "export const a = 1;\r\nexport const b = 2;\r\n");
  const store = new Store(home);
  const runDir = path.join(home, "runs", "crlf");
  await mkdir(runDir, { recursive: true });
  const resultPath = path.join(runDir, "response.md");
  await writeFile(resultPath, "FILE: ./src/main.js\nANCHOR:\n```js\nexport const a = 1;\n```\nREPLACE:\n```js\nexport const a = 3;\n```\n");
  await store.transaction(({ tasks }) => {
    tasks.tasks.crlf = { taskId: "crlf", kind: "code", mode: "full-file", runDir,
      workspaceRoot: root, children: { chatgpt: { state: "completed", resultPath } } };
  });
  await stageTaskFiles("crlf", { provider: "chatgpt", home, store });
  await applyStagedFiles("crlf", { provider: "chatgpt", home, store, confirm: true });
  assert.equal(await readFile(sourcePath, "utf8"), "export const a = 3;\r\nexport const b = 2;\r\n");
}));


test("install-skill --target accepts an explicit skills directory", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "wfa-skill-target-"));
  try {
    await runCli(["install-skill", "--target", target]);
    const installed = await readFile(path.join(target, "web-first", "SKILL.md"), "utf8");
    assert.equal(installed, await readFile(new URL("../skills/web-first/SKILL.md", import.meta.url), "utf8"));
  } finally { await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("a recycled parent pid with a stale heartbeat cannot lock the task forever", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-heartbeat-home-"));
  try {
    const store = new Store(home);
    const now = new Date().toISOString();
    await store.transaction(({ tasks }) => {
      tasks.tasks.recycled = {
        taskId: "recycled", workspace: "demo", kind: "ask", state: "needs_recovery",
        createdAt: now, updatedAt: now, parentPid: process.pid,
        heartbeatAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        children: { chatgpt: { state: "stalled", childPid: null, revision: 0 } },
      };
    });
    const task = await abandonProvider("recycled", "chatgpt", { confirm: true, home, store });
    assert.equal(task.children.chatgpt.state, "abandoned");
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("a live owner with a fresh heartbeat still blocks resolve", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-heartbeat-live-"));
  try {
    const store = new Store(home);
    const now = new Date().toISOString();
    await store.transaction(({ tasks }) => {
      tasks.tasks.owned = {
        taskId: "owned", workspace: "demo", kind: "ask", state: "needs_recovery",
        createdAt: now, updatedAt: now, parentPid: process.pid, heartbeatAt: now,
        children: { chatgpt: { state: "stalled", childPid: null, revision: 0 } },
      };
    });
    await assert.rejects(
      () => abandonProvider("owned", "chatgpt", { confirm: true, home, store }),
      /still running/i,
    );
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

// A directory can have more than one absolute spelling: a junction or symlink,
// an 8.3 short name such as the `RUNNER~1` temp path on the Windows CI runner,
// or a different drive-letter case. `git rev-parse` always answers with the
// resolved one, so comparing absolutes made `--bundle-repo` include nothing --
// while still telling the provider its (empty) bundle was authoritative.
test("an include reached through another spelling of the same directory still selects the file", async () => withRepo(async ({ root, home }) => {
  const link = path.join(home, "repo-link");
  await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
  const viaLink = await bundleRepository({ cwd: link, includes: ["src/main.js"] });
  assert.equal(viaLink.stats.files, 1);
  assert.match(viaLink.content, /FILE: src\/main\.js/);
}));

test("an include that matches no tracked file fails instead of sending an empty bundle", async () => withRepo(async ({ root }) => {
  await assert.rejects(
    () => bundleRepository({ cwd: root, includes: ["src/nope.js"] }),
    (error) => error.code === "BUNDLE_REPO_INCLUDE_UNMATCHED" && /src\/nope\.js/.test(error.message),
  );
}));

test("an include is matched case-insensitively on Windows", { skip: process.platform !== "win32" }, async () => withRepo(async ({ root }) => {
  const bundled = await bundleRepository({ cwd: root, includes: ["SRC/Main.JS"] });
  assert.equal(bundled.stats.files, 1);
  assert.match(bundled.content, /FILE: src\/main\.js/);
}));
