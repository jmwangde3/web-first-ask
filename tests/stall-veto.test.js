import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserIdleMs, browserStillWorking, createStallWatch } from "../src/stall-watch.js";
import { guardedBatch } from "../src/runner-stall.js";

async function withDir(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("a missing browser log gives no evidence instead of a fake 'quiet' verdict", async () => {
  await withDir("wfa-veto-", async (dir) => {
    assert.equal(await browserIdleMs(path.join(dir, "absent.log")), null);
    assert.equal(await browserIdleMs(null), null);
    assert.equal(await browserIdleMs(undefined), null);
  });
});

test("the browser log's age is measured, so a fresh write vetoes a stall", async () => {
  await withDir("wfa-veto-", async (dir) => {
    const log = path.join(dir, "chrome-devtools-mcp.log");
    await writeFile(log, "evaluate_script\n");
    const fresh = await browserIdleMs(log);
    assert.ok(fresh !== null && fresh < 5000, `expected a fresh mtime, got ${fresh}`);
    assert.equal(browserStillWorking(fresh, 900), true);

    const old = Date.now() - 30 * 60 * 1000;
    await utimes(log, new Date(old), new Date(old));
    const stale = await browserIdleMs(log);
    assert.ok(stale > 25 * 60 * 1000, `expected a stale mtime, got ${stale}`);
    assert.equal(browserStillWorking(stale, 900), false);
  });
});

test("no evidence keeps the old behaviour: silence alone is a stall", () => {
  assert.equal(browserStillWorking(null), false);
  assert.equal(browserStillWorking(119 * 1000), true);
  assert.equal(browserStillWorking(120 * 1000), false);
});

test("the snapshot reports how long each provider has been quiet", () => {
  let now = 1_000_000;
  const watch = createStallWatch([{ id: "job-a", provider: "gemini" }], ".", 900, () => now);
  watch.progress("job job-a running");
  now += 120_000;
  const [entry] = watch.snapshot();
  assert.equal(entry.provider, "gemini");
  assert.equal(entry.active, true);
  assert.equal(entry.idleSeconds, 120);
});

// guardedBatch is the layer that actually kills a batch, so the veto and the
// heartbeat are measured here rather than on a live provider.
async function guardedFixture(timeoutSeconds, { logAgeMs, heartbeatMs = 200, settleMs = 3600 }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-guard-"));
  const runDir = path.join(dir, "11111111-2222-3333-4444-555555555555");
  const outputDir = path.join(runDir, "ask-bridge-output");
  const job = { id: "job-guard", provider: "gemini" };
  await mkdir(outputDir, { recursive: true });
  const inputFile = path.join(runDir, "jobs.jsonl");
  await writeFile(inputFile, `${JSON.stringify(job)}\n`);
  const jobDir = path.join(outputDir, job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "in_progress" }));
  const log = path.join(dir, "browser.log");
  await writeFile(log, "evaluate_script\n");
  const stamp = new Date(Date.now() - logAgeMs);
  await utimes(log, stamp, stamp);
  const previous = process.env.ASK_BRIDGE_BROWSER_LOG;
  process.env.ASK_BRIDGE_BROWSER_LOG = log;

  const lines = [];
  const state = { aborted: false, killed: false };
  const run = (_cmd, _args, options) => new Promise((resolve) => {
    options.onSpawn?.(process.pid);
    options.onStdoutLine?.(`job ${job.id} running`);
    const finish = (killed) => resolve({
      code: killed ? null : 0, signal: killed ? "SIGTERM" : null,
      stdout: "", stderr: "", childMayRun: false, pid: process.pid,
    });
    options.abortSignal?.addEventListener("abort", () => {
      state.aborted = true;
      setTimeout(() => finish(true), 50);
    });
    // The page keeps "generating" without any output, exactly like a long answer.
    setTimeout(() => { if (!state.aborted) finish(false); }, settleMs);
  });
  const store = { stalls: new Map() };
  const result = await guardedBatch(run, "ask-bridge", ["batch", "--input", inputFile, "--output-dir", outputDir], {
    onStdoutLine: (line) => lines.push(line), heartbeatMs, cwd: dir,
  }, store, timeoutSeconds);
  if (previous === undefined) delete process.env.ASK_BRIDGE_BROWSER_LOG;
  else process.env.ASK_BRIDGE_BROWSER_LOG = previous;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  return { result, lines, state, job };
}

test("a silent batch is not killed while ask-bridge's browser log keeps moving", async () => {
  const { result, lines, state, job } = await guardedFixture(1, { logAgeMs: 0, settleMs: 2600, heartbeatMs: 300 });
  assert.equal(state.aborted, false, "must not abort a page that is still being driven");
  assert.ok(!result.stalled, `unexpected stall: ${JSON.stringify(result.stalled)}`);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const beats = lines.filter((line) => line.startsWith("[wfa] still waiting"));
  assert.ok(beats.length > 0 && beats[0].includes("gemini"), `heartbeat missing; got ${JSON.stringify(lines)}`);
  // The synthetic line must not read as job progress, or it would reset the
  // very silence it is reporting.
  assert.ok(beats.every((line) => !line.includes(job.id)));
});

test("a batch is killed once both wfa and the browser log go quiet", async () => {
  const { result, state } = await guardedFixture(1, { logAgeMs: 10 * 60 * 1000, settleMs: 8000, heartbeatMs: 60000 });
  assert.equal(state.aborted, true);
  assert.ok(result.stalled?.gemini, `expected a stall verdict, got ${JSON.stringify(result.stalled)}`);
  assert.ok(result.stalled.gemini.silentSeconds >= 1);
});
