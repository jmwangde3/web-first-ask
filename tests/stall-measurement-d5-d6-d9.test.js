// D5 + D6 + D9 (backlog items). Pure functions + fake timers only —
// no live browser, no real sleeps. The live runs these harnesses exist for
// are documented in src/stall-measurement.js (D5),
// src/browser/composer-capture.js (D6) and
// docs/gemini-conversation-reuse-test.md (D9).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PROVISIONAL_STALL_TIMEOUT_MS,
  STALL_TIMEOUT_DECISION,
  appendPauseEvents,
  createPauseTracker,
  formatPauseSummary,
  readPauseEvents,
  summarizePauseLogFile,
  summarizePauses,
} from "../src/stall-measurement.js";
import { createStallWatch } from "../src/stall-watch.js";
import {
  appendComposerCapture,
  buildComposerCaptureJs,
  captureComposerState,
  createStopStateSampler,
  formatComposerCapture,
  normalizeComposerCapture,
  summarizeStopPersistence,
} from "../src/browser/composer-capture.js";
import { compareReuseRuns, buildReuseReport } from "../scripts/gemini-conversation-reuse.mjs";
import { Store } from "../src/store.js";
import { refreshTask } from "../src/runner.js";

// --- D5: pause tracker -------------------------------------------------------

test("D5 pause tracker: silence past the threshold starts a pause, progress ends it", () => {
  let now = 0;
  const tracker = createPauseTracker({ now: () => now, pauseThresholdMs: 5000, provider: "gemini", mode: "background", taskId: "t1" });

  assert.equal(tracker.sample({ pendingCount: 378, answerChars: 100, answerTurns: 1 }), null);
  now = 4000;
  assert.equal(tracker.sample({ pendingCount: 378, answerChars: 100, answerTurns: 1 }), null);
  now = 5000;
  const started = tracker.sample({ pendingCount: 378, answerChars: 100, answerTurns: 1 });
  assert.equal(started?.type, "pause_start");
  assert.equal(started.atMs, 0);
  assert.equal(started.pendingCount, 378);
  assert.equal(started.answerChars, 100);
  now = 6000;
  assert.equal(tracker.sample({ pendingCount: 378, answerChars: 100, answerTurns: 1 }), null);
  assert.equal(tracker.inPause(), true);

  now = 200000;
  const ended = tracker.sample({ pendingCount: 0, answerChars: 500, answerTurns: 1 });
  assert.equal(ended?.type, "pause_end");
  assert.equal(ended.durationMs, 200000);
  assert.equal(tracker.inPause(), false);

  const runEnd = tracker.finish({ status: "completed" });
  assert.equal(runEnd.type, "run_end");
  assert.equal(runEnd.openPauseMs, null);

  const summary = summarizePauses(tracker.events());
  assert.equal(summary.pauseCount, 1);
  assert.equal(summary.completedPauses, 1);
  assert.equal(summary.openPauses, 0);
  assert.equal(summary.p50Ms, 200000);
  assert.equal(summary.maxMs, 200000);
});

test("D5 pause tracker: a pause still open at finish is censored, not fabricated", () => {
  let now = 0;
  const tracker = createPauseTracker({ now: () => now, pauseThresholdMs: 5000 });
  tracker.sample({ pendingCount: 10, answerChars: 0, answerTurns: 0 });
  now = 5000;
  tracker.sample({ pendingCount: 10, answerChars: 0, answerTurns: 0 });
  assert.equal(tracker.inPause(), true);
  now = 10000;
  const runEnd = tracker.finish({ status: "stalled" });
  // Pause is measured from last progress (t=0), not from detection (t=5000).
  assert.equal(runEnd.openPauseMs, 10000);
  const summary = summarizePauses(tracker.events());
  assert.equal(summary.pauseCount, 1);
  assert.equal(summary.completedPauses, 0);
  assert.equal(summary.openPauses, 1);
  assert.equal(summary.p50Ms, null);
  assert.equal(summary.maxMs, null);
});

test("D5 summarizePauses: p50/p90/max over completed pauses, open ones excluded", () => {
  const events = [
    { type: "pause_start", atMs: 0 },
    { type: "pause_end", atMs: 300000, durationMs: 300000 },
    { type: "pause_start", atMs: 400000 },
    { type: "pause_end", atMs: 1000000, durationMs: 600000 },
    { type: "pause_start", atMs: 1100000 },
  ];
  const summary = summarizePauses(events);
  assert.equal(summary.pauseCount, 3);
  assert.equal(summary.completedPauses, 2);
  assert.equal(summary.openPauses, 1);
  assert.deepEqual(summary.durationsMs, [300000, 600000]);
  assert.equal(summary.totalPauseMs, 900000);
  assert.equal(summary.p50Ms, 300000);
  assert.equal(summary.p90Ms, 600000);
  assert.equal(summary.maxMs, 600000);
  assert.equal(summary.meanMs, 450000);
  assert.match(formatPauseSummary(summary), /p90: 600000 ms/);
});

test("D5 pause events round-trip through a JSONL log file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-pause-log-"));
  try {
    const file = path.join(dir, "pause-events.jsonl");
    assert.deepEqual(await readPauseEvents(path.join(dir, "missing.jsonl")), []);
    await appendPauseEvents(file, [
      { type: "pause_start", atMs: 0, pendingCount: 378, answerChars: 100 },
      { type: "pause_end", atMs: 300000, durationMs: 300000, pendingCount: 0, answerChars: 7803 },
    ]);
    const events = await readPauseEvents(file);
    assert.equal(events.length, 2);
    assert.equal(events[1].answerChars, 7803);
    const { summary } = await summarizePauseLogFile(file);
    assert.equal(summary.completedPauses, 1);
    assert.equal(summary.maxMs, 300000);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("D5 decision: 420 s default is kept and marked PROVISIONAL, not endorsed", () => {
  assert.equal(PROVISIONAL_STALL_TIMEOUT_MS, 420000);
  assert.equal(STALL_TIMEOUT_DECISION.stallTimeoutMs, 420000);
  assert.equal(STALL_TIMEOUT_DECISION.decision, "keep");
  assert.equal(STALL_TIMEOUT_DECISION.status, "PROVISIONAL");
  assert.match(STALL_TIMEOUT_DECISION.basis, /378/);
  assert.match(STALL_TIMEOUT_DECISION.requires, /measurement/i);
});

// --- D5 wiring: stall-watch onStallEvent + runner-stall stallEvents --------

test("D5 stall watch: one stall_declared event per silence episode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-stall-event-"));
  try {
    let now = 1000;
    const events = [];
    const watch = createStallWatch(
      [{ id: "wfa-gemini-1", provider: "gemini" }],
      dir, 5, () => now,
      { onStallEvent: (event) => events.push(event) },
    );
    const jobDir = path.join(dir, "wfa-gemini-1");
    await mkdir(jobDir);
    watch.progress("job wfa-gemini-1 running");
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "in_progress" }));
    assert.equal(await watch.check(), null);

    now = 7000;
    assert.ok((await watch.check())?.gemini);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "stall_declared");
    assert.equal(events[0].provider, "gemini");
    assert.ok(events[0].silentSeconds >= 5);

    // Still silent: no duplicate event for the same episode.
    now = 8000;
    assert.ok((await watch.check())?.gemini);
    assert.equal(events.length, 1);

    // Progress resets the episode; the next silence reports again.
    watch.progress("job wfa-gemini-1 running");
    now = 14000;
    assert.ok((await watch.check())?.gemini);
    assert.equal(events.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("D5 stall watch: a throwing onStallEvent sink must not break the watch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-stall-event-throw-"));
  try {
    let now = 1000;
    const watch = createStallWatch(
      [{ id: "wfa-gemini-1", provider: "gemini" }],
      dir, 5, () => now,
      { onStallEvent: () => { throw new Error("sink boom"); } },
    );
    const jobDir = path.join(dir, "wfa-gemini-1");
    await mkdir(jobDir);
    watch.progress("job wfa-gemini-1 running");
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "in_progress" }));
    await watch.check();
    now = 7000;
    assert.ok((await watch.check())?.gemini);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("D5 refreshTask records a bounded stall_declared history on the child", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-stall-events-ledger-"));
  const oldBrowserLog = process.env.ASK_BRIDGE_BROWSER_LOG;
  const fakePid = 88776654;
  const realKill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === fakePid) return true;
    return realKill(pid, signal);
  });
  process.env.ASK_BRIDGE_BROWSER_LOG = path.join(home, "nonexistent-browser.log");
  try {
    const store = new Store(home);
    const runDir = path.join(home, "runs", "d5-stall-events-test");
    const outputDir = path.join(runDir, "ask-bridge-output");
    const jobId = "wfa-gemini-d5-test";
    const metadataPath = path.join(outputDir, jobId, "metadata.json");
    const oldTime = new Date(Date.now() - 120000);
    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify({ id: jobId, provider: "gemini", state: "in_progress" }), "utf8");
    await utimes(metadataPath, oldTime, oldTime);
    await store.transaction(({ tasks }) => {
      tasks.tasks["d5-stall-events-test"] = {
        taskId: "d5-stall-events-test",
        workspace: "stall-demo",
        kind: "ask",
        state: "running",
        createdAt: oldTime.toISOString(),
        runDir,
        outputDir,
        detached: true,
        serialWorker: false,
        executionPending: true,
        childPid: fakePid,
        stallTimeoutSeconds: 1,
        children: {
          gemini: { provider: "gemini", jobId, state: "running", watchLastLifeAt: oldTime.toISOString() },
        },
      };
    });

    const refreshed = await refreshTask("d5-stall-events-test", { home, store });
    assert.equal(refreshed.children.gemini.state, "stalled");
    assert.equal(refreshed.children.gemini.stallEvents.length, 1);
    assert.equal(refreshed.children.gemini.stallEvents[0].type, "stall_declared");
    assert.ok(refreshed.children.gemini.stallEvents[0].silentSeconds >= 1);

    // A second refresh must not append a duplicate for the same stall.
    const again = await refreshTask("d5-stall-events-test", { home, store });
    assert.equal(again.children.gemini.stallEvents.length, 1);

    const ledger = JSON.parse(await readFile(path.join(home, "tasks.json"), "utf8"));
    assert.equal(ledger.tasks["d5-stall-events-test"].children.gemini.stallEvents.length, 1);
  } finally {
    if (oldBrowserLog === undefined) delete process.env.ASK_BRIDGE_BROWSER_LOG;
    else process.env.ASK_BRIDGE_BROWSER_LOG = oldBrowserLog;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// --- D6: composer capture ----------------------------------------------------

const geminiAdapterLike = {
  editorSelector: 'rich-textarea div[contenteditable="true"]',
  stopSelector: 'button[aria-label="Stop response"], button[aria-label="Stop"]',
};

test("D6 capture: expression carries the adapter selectors and no answer text", () => {
  const js = buildComposerCaptureJs(geminiAdapterLike);
  assert.match(js, /Stop response/);
  assert.match(js, /contenteditable/);
  assert.match(js, /editorChars/);
  assert.match(js, /stopControls/);
  assert.doesNotMatch(js, /answerText/);
});

test("D6 capture: normalises a page value, truncates outerHTML, keeps no text", async () => {
  const longHtml = "<button>Stop</button>".repeat(500);
  const pageValue = {
    capturedAtPageMs: 123,
    pageUrl: "https://gemini.google.com/app/abc",
    pageTitle: "Gemini",
    editorFound: true,
    editorEditable: true,
    editorVisible: true,
    editorChars: 5,
    stopActive: true,
    stopMatched: 1,
    stopControls: [{
      index: 0, tagName: "button", ariaLabel: "Stop response", title: null,
      disabled: false, ariaDisabled: "false", className: "stop-button", id: "s1",
      visible: true, rect: { x: 1, y: 2, width: 10, height: 10 }, outerHtml: longHtml,
    }],
    editorText: "SECRET-PROMPT-TEXT",
    answerText: "SECRET-ANSWER-TEXT",
  };
  // CDP-shaped evaluate result…
  const viaCdp = await captureComposerState(
    async () => ({ result: { value: pageValue } }),
    geminiAdapterLike,
    { now: () => 1000, provider: "gemini", taskId: "t1", reason: "composer_stop_state" },
  );
  assert.equal(viaCdp.schema, 1);
  assert.equal(viaCdp.kind, "composer_capture");
  assert.equal(viaCdp.gate.stopActive, true);
  assert.equal(viaCdp.gate.editorChars, 5);
  assert.equal(viaCdp.stopControls[0].ariaLabel, "Stop response");
  assert.ok(viaCdp.stopControls[0].outerHtml.length <= 2000);
  assert.doesNotMatch(JSON.stringify(viaCdp), /SECRET-PROMPT-TEXT/);
  assert.doesNotMatch(JSON.stringify(viaCdp), /SECRET-ANSWER-TEXT/);
  assert.match(formatComposerCapture(viaCdp), /stopActive=true/);

  // …and a pre-unwrapped evaluate result give the same record.
  const viaPlain = await captureComposerState(
    async () => pageValue,
    geminiAdapterLike,
    { now: () => 1000, provider: "gemini", taskId: "t1", reason: "composer_stop_state" },
  );
  assert.deepEqual(viaPlain, viaCdp);
});

test("D6 capture: missing evaluate function fails closed", async () => {
  await assert.rejects(
    captureComposerState(null, geminiAdapterLike),
    /COMPOSER_CAPTURE_EVALUATE_REQUIRED/,
  );
});

test("D6 capture: normalise caps the control list and drops non-objects", () => {
  const raw = {
    stopActive: true,
    stopControls: Array.from({ length: 15 }, (_, i) => ({ index: i, tagName: "button", visible: true })),
  };
  const capture = normalizeComposerCapture(raw, { now: () => 0, provider: "gemini" });
  assert.equal(capture.stopControls.length, 10);
  assert.equal(capture.gate.stopMatched, 15);
});

test("D6 stop sampler: transitions and persistence durations", () => {
  let now = 0;
  const sampler = createStopStateSampler({ now: () => now });
  assert.equal(sampler.sample({ stopActive: false }), null);
  now = 1000;
  const started = sampler.sample({ stopActive: true });
  assert.equal(started?.type, "stop_state_started");
  now = 46000;
  assert.equal(sampler.sample({ stopActive: true }), null);
  const ended = sampler.sample({ stopActive: false });
  assert.equal(ended?.type, "stop_state_ended");
  assert.equal(ended.durationMs, 45000);
  const summary = sampler.summary();
  assert.equal(summary.samples, 4);
  assert.equal(summary.transitions, 2);
  assert.equal(summary.stopActiveMs, 45000);
  assert.equal(summary.longestStopMs, 45000);
  assert.equal(summary.currentlyStopped, false);

  now = 50000;
  sampler.sample({ stopActive: true });
  now = 55000;
  assert.equal(sampler.summary().currentStopMs, 5000);
});

test("D6 summarizeStopPersistence: totals over sampled intervals, open tail flagged", () => {
  const summary = summarizeStopPersistence([
    { at: 0, stopActive: false },
    { at: 1000, stopActive: true },
    { at: 46000, stopActive: false },
    { at: 50000, stopActive: true },
  ]);
  assert.equal(summary.samples, 4);
  assert.equal(summary.stopIntervals, 1);
  assert.equal(summary.totalStopMs, 45000);
  assert.equal(summary.longestStopMs, 45000);
  assert.equal(summary.openTail, true);
  assert.equal(summary.firstAt, new Date(0).toISOString());
});

test("D6 capture appends as one JSONL line per capture", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-composer-capture-"));
  try {
    const file = path.join(dir, "captures.jsonl");
    const capture = normalizeComposerCapture(
      { stopActive: true, stopControls: [] },
      { now: () => 1000, provider: "gemini", taskId: "t1", reason: "composer_stop_state" },
    );
    await appendComposerCapture(file, capture);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).kind, "composer_capture");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// --- D9: reuse comparison ----------------------------------------------------

const firstRun = {
  taskId: "id-1", status: "completed",
  conversationUrl: "https://gemini.google.com/app/abc123",
  userTurns: 1, title: "Test chat",
};
const secondRun = {
  taskId: "id-2", status: "completed",
  conversationUrl: "https://gemini.google.com/app/abc123",
  userTurns: 2, title: "Test chat",
};

test("D9 compare: same URL, userTurns 1 -> 2, both completed is a PASS", () => {
  const result = compareReuseRuns(firstRun, secondRun);
  assert.equal(result.pass, true);
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.checks, {
    sameUrl: true, userTurnsGrew: true, secondCompleted: true, titleSame: true,
  });
  const report = buildReuseReport({
    key: "d9-test-1", first: firstRun, second: secondRun,
    comparison: result, storeEntry: { conversationUrl: firstRun.conversationUrl, turnCount: 2 },
    storePath: "C:\\Users\\x\\AppData\\Local\\web-first-ask\\conversations\\gemini\\<sha>.json",
  });
  assert.match(report, /verdict: PASS/);
  assert.match(report, /userTurns=2/);
});

test("D9 compare: a different URL on ask #2 is a FAIL", () => {
  const result = compareReuseRuns(firstRun, { ...secondRun, conversationUrl: "https://gemini.google.com/app/other" });
  assert.equal(result.pass, false);
  assert.equal(result.checks.sameUrl, false);
});

test("D9 compare: userTurns stuck at 1 on ask #2 is a FAIL", () => {
  const result = compareReuseRuns(firstRun, { ...secondRun, userTurns: 1 });
  assert.equal(result.pass, false);
  assert.equal(result.checks.userTurnsGrew, false);
});

test("D9 compare: empty titles are unknown, not a failure", () => {
  const result = compareReuseRuns(
    { ...firstRun, title: "" },
    { ...secondRun, title: "" },
  );
  assert.equal(result.pass, true);
  assert.equal(result.checks.titleSame, null);
});

test("D9 compare: a non-completed second ask is a FAIL", () => {
  const result = compareReuseRuns(firstRun, { ...secondRun, status: "stalled" });
  assert.equal(result.pass, false);
  assert.equal(result.checks.secondCompleted, false);
});
