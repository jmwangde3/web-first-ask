import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

test("store transactions serialize concurrent writes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-store-"));
  try {
    const store = new Store(home);
    // 12 serialized transactions at a 50ms poll interval can exceed the 15s
    // default when the whole suite runs in parallel on a busy machine.
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.transaction(({ tasks }) => {
        tasks.tasks[`task-${index}`] = { taskId: `task-${index}` };
      }, 120000)
    ));
    const snapshot = await store.snapshot();
    assert.equal(Object.keys(snapshot.tasks.tasks).length, 12);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The read path used to take the exclusive write lock, so one wedged or merely
// busy writer made `wfa list` unusable. A snapshot now reads the files.
test("a snapshot does not wait for a held write lock", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-store-"));
  try {
    const store = new Store(home);
    await store.transaction(({ tasks }) => { tasks.tasks["task-1"] = { taskId: "task-1", state: "completed" }; });
    // A lock owned by this very process is definitely alive, so any lock-taking
    // read would block for the full timeout.
    await writeFile(store.paths.lock, JSON.stringify({
      pid: process.pid, host: os.hostname(), createdAt: Date.now(), token: "held-by-test",
    }));
    const started = Date.now();
    const snapshot = await store.snapshot();
    assert.ok(Date.now() - started < 2000, "snapshot must not queue behind the lock");
    assert.equal(snapshot.tasks.tasks["task-1"].state, "completed");
    await rm(store.paths.lock, { force: true });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a lock left by a dead pid is reclaimed instead of blocking every command", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-store-"));
  try {
    const store = new Store(home);
    // pid 1 is not a live process on Windows, and a dead pid on POSIX.
    await writeFile(store.paths.lock, JSON.stringify({
      pid: 999999, host: os.hostname(), createdAt: Date.now() - 60_000, token: "dead-owner",
    }));
    const started = Date.now();
    await store.transaction(({ tasks }) => { tasks.tasks["after-reclaim"] = { taskId: "after-reclaim" }; });
    assert.ok(Date.now() - started < 10000, "a dead owner must not cost the full wait budget");
    // The dead generation was taken over and the fresh lock released again, so
    // nothing is left claiming ownership.
    await assert.rejects(() => readFile(store.paths.lock), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("unlock refuses a live owner and clears a dead one", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-store-"));
  try {
    const store = new Store(home);
    await writeFile(store.paths.lock, JSON.stringify({
      pid: process.pid, host: os.hostname(), createdAt: Date.now(), token: "live",
    }));
    const refused = await store.unlock();
    assert.equal(refused.removed, false);
    assert.match(refused.reason, /live pid/i);
    await writeFile(store.paths.lock, JSON.stringify({
      pid: 999999, host: os.hostname(), createdAt: Date.now() - 60_000, token: "dead",
    }));
    const cleared = await store.unlock();
    assert.equal(cleared.removed, true);
    await assert.rejects(() => readFile(store.paths.lock), /ENOENT/);
    const idle = await store.unlock();
    assert.equal(idle.reason, "no lock file");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Every avoided rewrite is 15-30 s the next lock holder does not wait for on a
// volume where a filter driver intercepts writes to existing files.
test("a transaction leaves unchanged files alone", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-store-"));
  try {
    const store = new Store(home);
    await store.transaction(({ sessions }) => { sessions.workspaces["demo"] = { threadUrl: "https://chatgpt.com/c/one" }; });
    const sessionsBefore = await stat(store.paths.sessions);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await store.transaction(({ tasks }) => { tasks.tasks["only-tasks"] = { taskId: "only-tasks" }; });
    const sessionsAfter = await stat(store.paths.sessions);
    assert.equal(sessionsAfter.mtimeMs, sessionsBefore.mtimeMs, "sessions.json must not be rewritten when it did not change");
    const snapshot = await store.snapshot();
    assert.ok(snapshot.tasks.tasks["only-tasks"]);
    assert.ok(snapshot.sessions.workspaces.demo);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The reviewer's objection to rename-based takeover: two waiters that both saw
// the same dead generation could rename the lock the other one just created.
// The reclaim claim plus the generation re-check is supposed to prevent that.
// Only a real multi-process race can show whether it does, so this spawns six
// processes against one stale lock and fails if any two critical sections overlap.
test("six processes racing one stale lock never enter the critical section together", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-race-home-"));
  const work = await mkdtemp(path.join(os.tmpdir(), "wfa-race-"));
  try {
    const store = new Store(home);
    await writeFile(store.paths.lock, JSON.stringify({
      pid: 999999, host: os.hostname(), createdAt: Date.now() - 60_000, token: "dead-race",
    }));
    const childPath = path.join(work, "child.mjs");
    const logPath = path.join(work, "sections.log");
    await writeFile(childPath, `import { appendFileSync } from "node:fs";
import { Store } from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};
const store = new Store(process.env.WFA_RACE_HOME);
await store.transaction(async () => {
  appendFileSync(process.env.WFA_RACE_LOG, \`start \${process.pid} \${Date.now()}\\n\`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  appendFileSync(process.env.WFA_RACE_LOG, \`end \${process.pid} \${Date.now()}\\n\`);
});
`);
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, [childPath], {
      env: { ...process.env, NODE_OPTIONS: "", WFA_RACE_HOME: home, WFA_RACE_LOG: logPath },
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    }));
    const failures = await Promise.all(children.map((child) => new Promise((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => resolve(code === 0 ? null : `${code}: ${stderr.slice(0, 300)}`));
    })));
    assert.deepEqual(failures.filter(Boolean), [], "every contender must finish its transaction");
    const sections = new Map();
    for (const line of (await readFile(logPath, "utf8")).trim().split("\n")) {
      const [kind, pid, at] = line.split(" ");
      const entry = sections.get(pid) ?? {};
      entry[kind] = Number(at);
      sections.set(pid, entry);
    }
    assert.equal(sections.size, 6);
    const spans = [...sections.values()].map(({ start, end }) => ({ start, end }));
    assert.ok(spans.every(({ start, end }) => Number.isFinite(start) && Number.isFinite(end)));
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i += 1) {
      assert.ok(spans[i].start >= spans[i - 1].end,
        `critical sections overlapped: ${JSON.stringify(spans[i - 1])} and ${JSON.stringify(spans[i])}`);
    }
    const snapshot = await store.snapshot();
    assert.equal(Object.keys(snapshot.tasks.tasks).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
