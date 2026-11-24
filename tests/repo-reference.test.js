import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRepoUrl, resolveRepository, repositoryBlock, matchRepoUnreadable, bundleRepository } from "../src/repository.js";
import { createStallWatch } from "../src/stall-watch.js";
import { executeTask } from "../src/runner.js";
import { Store } from "../src/store.js";
import { isLockCollision } from "../src/store.js";
import { workspaceHasBlockingTask } from "../src/state.js";

const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];
const config = { defaultProvider: "chatgpt", defaultProviders: ["chatgpt", "gemini"],
  defaultConcurrency: 1, defaultTimeoutSeconds: 1200, maxTimeoutSeconds: 7200,
  maxConcurrency: 3, downloadImages: false };

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-repo-root-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-repo-home-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "a@example.test");
    git(root, "config", "user.name", "Test");
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "main.js"), "export const answer = 42;\n");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, "ignored.txt"), "not tracked");
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    git(root, "remote", "add", "origin", "git@github.com:test-org/test-repo.git");
    return await fn({ root, home });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function successfulBatch(answer, urlForProvider) {
  return async (_command, args, options = {}) => {
    await options.onSpawn?.(process.pid);
    const jobs = (await readFile(argAfter(args, "--input"), "utf8")).trim().split("\n").map(JSON.parse);
    for (const job of jobs) {
      const jobDir = path.join(argAfter(args, "--output-dir"), job.id);
      await mkdir(jobDir, { recursive: true });
      await writeFile(path.join(jobDir, "response.md"), answer);
      await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
        id: job.id, provider: job.provider, state: "completed",
        threadUrl: urlForProvider(job.provider), error: null,
      }));
    }
    return { code: 0, signal: null, stdout: "", stderr: "", spawnError: null };
  };
}

test("normalizes HTTPS, SSH, scp-style and .git remotes", () => {
  assert.equal(normalizeRepoUrl("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(normalizeRepoUrl("https://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(normalizeRepoUrl("ssh://git@gitlab.example.com/o/r.git"), "https://gitlab.example.com/o/r");
  assert.equal(normalizeRepoUrl("git://github.com/o/r.git"), "https://github.com/o/r");
});

test("detects repo metadata without source reads and inlines tracked files only on request", async () => fixture(async ({ root }) => {
  const repo = await resolveRepository({ cwd: root });
  assert.equal(repo.url, "https://github.com/test-org/test-repo");
  assert.equal(repo.commit, git(root, "rev-parse", "HEAD"));
  assert.match(repositoryBlock(repo), /REPO_UNREADABLE/);
  assert.equal((await resolveRepository({ cwd: root, noRepo: true })).available, false);
  assert.equal((await resolveRepository({ cwd: root, repoUrl: "https://gitlab.com/new/repo.git" })).url,
    "https://gitlab.com/new/repo");
  const bundled = await bundleRepository({ cwd: root, prompt: "Read main.js" });
  assert.equal(bundled.stats.files, 1);
  assert.ok(bundled.stats.skipped >= 1);
  assert.match(bundled.content, /FILE: main.js/);
  assert.doesNotMatch(bundled.content, /not tracked/);
}));

test("repo block reaches each provider in isolated single-job batches and fresh sessions", async () => fixture(async ({ root, home }) => {
  const store = new Store(home);
  await store.transaction(({ sessions }) => { sessions.workspaces.x = { chatgpt: "https://chatgpt.com/c/previous" }; });
  const seen = [];
  const result = await executeTask({
    prompt: "Analyze main.js", providers: ["chatgpt", "gemini"], workspace: "x", workspaceRoot: root,
  }, { home, store, config, skipPreflight: true,
    runProcess: async (_cmd, args, opts) => {
      const jobs = (await readFile(argAfter(args, "--input"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(jobs.length, 1);
      assert.ok(jobs.every((job) => job.prompt.includes("REPOSITORY\nURL: https://github.com/test-org/test-repo")));
      assert.ok(jobs.every((job) => !Object.hasOwn(job, "session")));
      seen.push(...jobs);
      return successfulBatch("Answer", (provider) => provider === "chatgpt"
        ? "https://chatgpt.com/c/previous" : "https://gemini.google.com/app/new")(_cmd, args, opts);
    },
  });
  assert.equal(result.task.sessionPolicy, "fresh");
  assert.deepEqual(result.task.children.chatgpt.threadMismatch, {
    expected: "a new conversation (not the previous workspace thread)",
    actual: "https://chatgpt.com/c/previous",
  });
  assert.equal((await store.snapshot()).sessions.workspaces.x.chatgpt, undefined);
  assert.equal(seen.length, 2);
}));

test("--continue-session includes saved conversation and checks expected URL", async () => fixture(async ({ root, home }) => {
  const store = new Store(home);
  const previous = "https://chatgpt.com/c/known";
  await store.transaction(({ sessions }) => { sessions.workspaces.x = { chatgpt: previous }; });
  const result = await executeTask({
    prompt: "Continue", provider: "chatgpt", workspace: "x", workspaceRoot: root, continueSession: true,
  }, { home, store, config, skipPreflight: true, runProcess: async (cmd, args, opts) => {
    const job = JSON.parse((await readFile(argAfter(args, "--input"), "utf8")).trim());
    assert.equal(job.session, previous);
    return successfulBatch("Answer", () => "https://chatgpt.com/c/unexpected")(cmd, args, opts);
  } });
  assert.equal(result.task.sessionPolicy, "continue");
  assert.deepEqual(result.task.children.chatgpt.threadMismatch,
    { expected: previous, actual: "https://chatgpt.com/c/unexpected" });
  assert.equal((await store.snapshot()).sessions.workspaces.x.chatgpt, previous);
}));

test("REPO_UNREADABLE is unresolved; code fallback keeps code delivery and source authority", async () => fixture(async ({ root, home }) => {
  const store = new Store(home);
  const first = await executeTask({
    prompt: "Explain main.js", kind: "code", provider: "chatgpt", workspace: "x", workspaceRoot: root,
  }, { home, store, config, skipPreflight: true,
    runProcess: successfulBatch("REPO_UNREADABLE", () => "https://chatgpt.com/c/sentinel"),
  });
  assert.equal(first.task.children.chatgpt.state, "repo_unreadable");
  assert.equal(first.task.children.chatgpt.repoUnreadable, true);
  assert.match(first.task.children.chatgpt.repoFallbackCommand, /wfa code .*--bundle-repo/);
  assert.ok(workspaceHasBlockingTask((await store.snapshot()).tasks.tasks, "x", ["chatgpt"]));
  const followup = await executeTask({
    prompt: "Use the inline source of main.js to finish the original request.", provider: "chatgpt", workspace: "x",
    kind: "code", workspaceRoot: root, followupTaskId: first.task.taskId, bundleRepo: true,
  }, { home, store, config, skipPreflight: true, runProcess: async (cmd, args, opts) => {
    const job = JSON.parse((await readFile(argAfter(args, "--input"), "utf8")).trim());
    assert.equal(job.session, "https://chatgpt.com/c/sentinel");
    assert.match(job.prompt, /FILE: main.js/);
    assert.doesNotMatch(job.prompt, /^REPOSITORY\nURL:/);
    assert.deepEqual(job.files, []);
    return successfulBatch("Resolved answer", () => "https://chatgpt.com/c/sentinel")(cmd, args, opts);
  } });
  assert.equal(followup.task.children.chatgpt.state, "completed");
  assert.equal(followup.task.parentTaskId, first.task.taskId);
  assert.equal(followup.task.repoReference, null);
}));

test("sentinel matching avoids quoted or explanatory false positives", () => {
  assert.equal(matchRepoUnreadable("REPO_UNREADABLE")?.kind, "sentinel");
  assert.equal(matchRepoUnreadable("I cannot access the repository.")?.kind, "high-confidence-unreadable");
  assert.equal(matchRepoUnreadable("The identifier REPO_UNREADABLE is in the test file."), null);
});

test("stall watcher needs active job and both progress/metadata silence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-stall-"));
  try {
    let now = 1000;
    const watch = createStallWatch([{ id: "wfa-chatgpt-1", provider: "chatgpt" }], dir, 5, () => now);
    now = 9000;
    assert.equal(await watch.check(), null);
    watch.progress("job wfa-chatgpt-1 running");
    const jobDir = path.join(dir, "wfa-chatgpt-1");
    await mkdir(jobDir);
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "in_progress" }));
    assert.equal(await watch.check(), null);
    now = 15000;
    const evidence = await watch.check();
    assert.ok(evidence.chatgpt.silentSeconds >= 5);
    assert.match(evidence.chatgpt.lastProgressLine, /running/);
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "completed" }));
    assert.equal(await watch.check(), null);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("EPERM is lock collision and dead owner's lock is reclaimed", async () => {
  assert.equal(isLockCollision({ code: "EPERM" }), true);
  assert.equal(isLockCollision({ code: "EEXIST" }), true);
  assert.equal(isLockCollision({ code: "EACCES" }), false);
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-lock-"));
  try {
    const store = new Store(home);
    await writeFile(path.join(home, ".store.lock"), JSON.stringify({ host: os.hostname(), pid: 2147483000, createdAt: 0 }));
    assert.equal(await store.withLock(async () => "recovered", 500), "recovered");
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("silent in-progress batch becomes stalled rather than completed or retryable", async () => fixture(async ({ root, home }) => {
  const store = new Store(home);
  // The watchdog vetoes a stall while ask-bridge's browser log is moving. Point
  // it at a file that does not exist so this test measures the no-evidence path
  // instead of whatever Chrome happens to be doing on the machine.
  const previousLog = process.env.ASK_BRIDGE_BROWSER_LOG;
  process.env.ASK_BRIDGE_BROWSER_LOG = path.join(root, "no-browser.log");
  try {
  const result = await executeTask({
    prompt: "Check a hanging provider", workspace: "stall-example", provider: "chatgpt",
    workspaceRoot: root, stallTimeoutSeconds: 1,
  }, { home, store, config, skipPreflight: true,
    runProcess: async (_command, args, options) => {
      const job = JSON.parse((await readFile(argAfter(args, "--input"), "utf8")).trim());
      const jobDir = path.join(argAfter(args, "--output-dir"), job.id);
      await mkdir(jobDir, { recursive: true });
      await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
        id: job.id, provider: job.provider, state: "in_progress",
        threadUrl: "https://chatgpt.com/c/uncertain",
      }));
      options.onStdoutLine?.(`job ${job.id} running`);
      return new Promise(() => {});
    },
  });
  assert.equal(result.task.children.chatgpt.state, "stalled");
  assert.equal(result.task.state, "needs_recovery");
  assert.ok(result.task.children.chatgpt.stall.silentSeconds >= 1);
  assert.ok(workspaceHasBlockingTask((await store.snapshot()).tasks.tasks, "stall-example", ["chatgpt"]));
  } finally {
    if (previousLog === undefined) delete process.env.ASK_BRIDGE_BROWSER_LOG;
    else process.env.ASK_BRIDGE_BROWSER_LOG = previousLog;
  }
}));

test("zip bundles are a repository payload, so they get no remote reference and no sentinel check", async () => fixture(async ({ root, home }) => {
  const store = new Store(home);
  const result = await executeTask({
    prompt: "Explain the attached sources", provider: "chatgpt", workspace: "zip", workspaceRoot: root,
    bundleRepo: true, bundleRepoMode: "zip",
  }, { home, store, config, skipPreflight: true, runProcess: async (cmd, args, opts) => {
    const job = JSON.parse((await readFile(argAfter(args, "--input"), "utf8")).trim());
    assert.match(job.prompt, /REPOSITORY ARCHIVE/);
    assert.doesNotMatch(job.prompt, /^REPOSITORY\nURL:/m);
    assert.equal(job.files.length, 1);
    assert.ok(job.files[0].endsWith(".zip"));
    // The provider answers with the sentinel anyway; the archive already told
    // it not to fetch, so this must not be classified as an unreadable repo.
    return successfulBatch("REPO_UNREADABLE", () => "https://chatgpt.com/c/zip")(cmd, args, opts);
  } });
  assert.equal(result.task.repoReference, null);
  assert.equal(result.task.bundleRepo, true);
  assert.notEqual(result.task.children.chatgpt.repoUnreadable, true);
  assert.equal(result.task.children.chatgpt.state, "completed");
}));
