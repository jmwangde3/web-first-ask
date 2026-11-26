// D5 completion fix (2026-11-26, REPORT-02360b8c run1): regression coverage
// for the two halves of the fix.
//
// (a) A completed Gemini reply must not be treated as pending when the
//     engine's view goes stale: run1 showed innerText stuck at 43 chars,
//     pendingCount stuck at 666 and no stop button while the page already
//     held 29,970 chars, and the CLI waited the full 900 s to TIMEOUT.
//     The adapter now reports the page-level full text (textContent) and
//     the wait loop completes on a frozen page that proves completion
//     instead of treating a merely present pendingCount as activity.
// (b) pause_start/pause_end must always pair: an open pause is
//     force-closed by a timeout fallback (pause_end, reason
//     "pause_timeout") so a turn can never sit in "paused" for 13.8 min.
//
// Pure functions + fake timers only — no live browser, no real sleeps.
// The D4 read layer (src/engines/cdp-read.js) is untouched by the fix;
// its behaviour (partial marking, two-sample confirmation) is covered by
// tests/cdp-read*.test.js and tests/d4-completion-signal.test.js, which
// must stay green alongside this file.
import test from "node:test";
import assert from "node:assert/strict";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { readTurnState, waitForCompletion } from "../src/browser/driver.js";
import {
  createPauseTracker,
  summarizePauses,
} from "../src/stall-measurement.js";

// --- adapter: page-level full-text signals ---------------------------------

function makeGeminiDom({ text = "Hello world", fullText = null, pendingNodes = 0, hasActions = false, actionsVisible = true } = {}) {
  const bodyText = fullText === null ? text : fullText;
  const body = {
    innerText: text,
    textContent: bodyText,
    querySelectorAll: () => [],
  };
  const actionsEl = hasActions
    ? { getBoundingClientRect: () => ({ width: actionsVisible ? 80 : 0, height: actionsVisible ? 24 : 0 }) }
    : null;
  const lastModelEl = {
    textContent: bodyText,
    querySelector(selector) {
      if (selector === "message-actions") return actionsEl;
      if (selector.includes("message-content")) return body;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "span.pending, p.pending") {
        return Array.from({ length: pendingNodes }, () => ({}));
      }
      return [];
    },
  };
  return {
    title: "Google Gemini",
    querySelectorAll(selector) {
      if (selector === "user-query") return [{}];
      if (selector === "model-response") return [lastModelEl];
      return [];
    },
    querySelector(selector) {
      if (selector.includes("rich-textarea") || selector.includes("ql-editor")) {
        return { innerText: "" };
      }
      if (selector.includes("Google 账号") || selector.includes("SignOutOptions")) {
        return { nodeName: "BUTTON" };
      }
      return null;
    },
  };
}

function evalReadState(doc) {
  const fn = new Function("document", "window", "return " + geminiAdapter.buildReadStateJs());
  return JSON.parse(fn(doc, {}));
}

test("D5 adapter: run1 shape reports the page-level full text beside the frozen extractor text", () => {
  const state = evalReadState(makeGeminiDom({
    text: "x".repeat(43),
    fullText: "y".repeat(29970),
    pendingNodes: 666,
    hasActions: false,
  }));
  assert.equal(state.answerText.length, 43);
  assert.equal(state.pendingCount, 666);
  assert.equal(state.answerActionsVisible, false);
  assert.equal(state.stopVisible, false);
  assert.equal(state.modelTextChars, 29970);
  assert.equal(state.answerTextFull.length, 29970);
});

test("D5 adapter: a genuine thinking pause reports a small full text, not a completed answer", () => {
  const state = evalReadState(makeGeminiDom({
    text: "x".repeat(18),
    fullText: "x".repeat(18),
    pendingNodes: 378,
    hasActions: false,
  }));
  assert.equal(state.answerText.length, 18);
  assert.equal(state.pendingCount, 378);
  assert.equal(state.modelTextChars, 18);
  assert.equal(state.answerTextFull.length, 18);
});

test("D5 adapter: the existing fields keep their meanings (actions visible, no pending)", () => {
  const state = evalReadState(makeGeminiDom({
    text: "Hello world",
    pendingNodes: 0,
    hasActions: true,
    actionsVisible: true,
  }));
  assert.equal(state.answerText, "Hello world");
  assert.equal(state.answerActionsVisible, true);
  assert.equal(state.pendingCount, 0);
  assert.equal(state.modelTextChars, 11);
  assert.equal(state.answerTextFull, "Hello world");
});

test("D5 readTurnState: passes modelTextChars/answerTextFull through, defaults to 0/'' when absent", async () => {
  const withFields = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1, answerTurns: 1, answerText: "x".repeat(43),
              answerTextFull: "y".repeat(29970), modelTextChars: 29970,
              answerActionsVisible: false, pendingCount: 666, stopVisible: false,
              editorEmpty: true, title: "Google Gemini",
            }),
          },
        };
      }
      return {};
    },
  };
  const state = await readTurnState(withFields, "s1", geminiAdapter);
  assert.equal(state.modelTextChars, 29970);
  assert.equal(state.answerTextFull.length, 29970);
  assert.equal(state.pendingCount, 666);

  const withoutFields = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1, answerTurns: 1, answerText: "hi",
              answerActionsVisible: false, pendingCount: 7,
            }),
          },
        };
      }
      return {};
    },
  };
  const fallback = await readTurnState(withoutFields, "s1", geminiAdapter);
  assert.equal(fallback.modelTextChars, 0);
  assert.equal(fallback.answerTextFull, "");
});

// --- driver: completion -----------------------------------------------------

function stateCdp(getState) {
  return {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: JSON.stringify(getState()) } };
      }
      return {};
    },
  };
}

function run1State(overrides = {}) {
  return {
    userTurns: 1,
    answerTurns: 1,
    answerText: "x".repeat(43),
    answerTextFull: "y".repeat(29970),
    modelTextChars: 29970,
    answerActionsVisible: false,
    pendingCount: 666,
    stopVisible: false,
    editorEmpty: true,
    title: "Google Gemini",
    ...overrides,
  };
}

function virtualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
  };
}

test("D5 driver: an actions-visible turn with stuck pending completes after settle, not at the hard timeout", async () => {
  const clock = virtualClock();
  const result = await waitForCompletion(stateCdp(() => run1State({ answerActionsVisible: true })), "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 4000,
    stallTimeoutMs: 10000,
    hardTimeoutMs: 20000,
    pollIntervalMs: 500,
    now: clock.now,
    sleep: clock.sleep,
  });
  // Before the fix the merely present pendingCount (666) refreshed
  // lastActivityAt on every poll, so `settled` never became true and this
  // shape ran to the hard timeout instead of completing.
  assert.equal(result.status, "completed");
  assert.equal(result.reason, "completed");
  assert.equal(result.text.length, 43);
  assert.ok(result.elapsedMs >= 4000 && result.elapsedMs < 10000);
});

test("D5 driver: a completed page with stale pendingCount is recognised as complete (run1 shape)", async () => {
  const clock = virtualClock();
  const result = await waitForCompletion(stateCdp(() => run1State()), "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 4000,
    stallTimeoutMs: 10000,
    hardTimeoutMs: 60000,
    pollIntervalMs: 500,
    targetId: "t1",
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reason, "completed_stale_pending");
  assert.equal(result.text.length, 29970);
  assert.equal(result.evidence.stalePending, true);
  assert.equal(result.evidence.answerTextFullUsed, true);
  assert.equal(result.evidence.modelTextChars, 29970);
  assert.equal(result.evidence.pendingCount, 666);
  assert.ok(result.elapsedMs >= 10000 && result.elapsedMs < 60000);
});

test("D5 driver: a genuine thinking pause with a small frozen text does NOT complete as stale-pending", async () => {
  const clock = virtualClock();
  const result = await waitForCompletion(
    stateCdp(() => run1State({
      answerText: "x".repeat(18),
      answerTextFull: "x".repeat(18),
      modelTextChars: 18,
      pendingCount: 378,
    })),
    "session-1",
    geminiAdapter,
    {
      baselineUserTurns: 0,
      baselineAnswerTurns: 0,
      settleMs: 4000,
      stallTimeoutMs: 10000,
      continuedWaitBudgetMs: 5000,
      hardTimeoutMs: 60000,
      pollIntervalMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    },
  );
  assert.equal(result.status, "stalled");
  assert.equal(result.reason, "no_progress");
  assert.equal(result.evidence.stallDecision?.type, "stall_continued_wait_exhausted");
});

test("D5 driver: a stale-pending page with the stop button still visible does NOT complete", async () => {
  const clock = virtualClock();
  const result = await waitForCompletion(
    stateCdp(() => run1State({ stopVisible: true })),
    "session-1",
    geminiAdapter,
    {
      baselineUserTurns: 0,
      baselineAnswerTurns: 0,
      settleMs: 4000,
      stallTimeoutMs: 10000,
      continuedWaitBudgetMs: 5000,
      hardTimeoutMs: 60000,
      pollIntervalMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    },
  );
  assert.equal(result.status, "stalled");
  assert.equal(result.reason, "no_progress");
});

test("D5 driver: progress resets the stale clocks; completion follows the new freeze", async () => {
  const clock = virtualClock();
  let polls = 0;
  const cdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        polls += 1;
        // Polls 1-10 (t=0..4500): run1 shape. From poll 11 (t=5000) the
        // page grows once (pending 700, full text 31,000) and then freezes.
        return {
          result: {
            value: JSON.stringify(polls <= 10
              ? run1State()
              : run1State({
                  answerText: "x".repeat(50),
                  answerTextFull: "y".repeat(31000),
                  modelTextChars: 31000,
                  pendingCount: 700,
                })),
          },
        };
      }
      return {};
    },
  };
  const result = await waitForCompletion(cdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 4000,
    stallTimeoutMs: 10000,
    hardTimeoutMs: 60000,
    pollIntervalMs: 500,
    targetId: "t1",
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.reason, "completed_stale_pending");
  assert.equal(result.text.length, 31000);
  // The freeze restarts at the growth (t=5000), so completion cannot come
  // before 5000 + 10000 ms of renewed silence.
  assert.ok(result.elapsedMs >= 15000);
});

// --- pause tracker: pairing fallback ----------------------------------------

test("D5 pause tracker: an open pause is force-closed by the timeout fallback and paired", () => {
  let now = 0;
  const tracker = createPauseTracker({
    now: () => now,
    pauseThresholdMs: 5000,
    maxOpenPauseMs: 60000,
    provider: "gemini",
    mode: "background",
    taskId: "t1",
  });

  assert.equal(tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 }), null);
  now = 5000;
  const started = tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 });
  assert.equal(started?.type, "pause_start");
  assert.equal(tracker.inPause(), true);

  // Silence continues; the pause must not sit open past maxOpenPauseMs.
  now = 64000;
  const closed = tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 });
  assert.equal(closed?.type, "pause_end");
  assert.equal(closed?.reason, "pause_timeout");
  assert.equal(closed?.timedOut, true);
  assert.equal(closed?.durationMs, 64000);
  assert.equal(closed?.pendingCount, 666);
  assert.equal(closed?.answerChars, 43);
  assert.equal(tracker.inPause(), false);

  // The silence clock was re-baselined at the close: the next silent
  // sample does NOT immediately reopen a pause for the same episode.
  now = 64500;
  assert.equal(tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 }), null);
  assert.equal(tracker.inPause(), false);

  // Another threshold of silence opens a fresh pause.
  now = 69000;
  const restarted = tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 });
  assert.equal(restarted?.type, "pause_start");
  assert.equal(restarted?.atMs, 64000);

  const summary = summarizePauses(tracker.events());
  assert.equal(summary.pauseCount, 2);
  assert.equal(summary.completedPauses, 0);
  assert.equal(summary.openPauses, 1);
  assert.equal(summary.timedOutPauses, 1);
  assert.deepEqual(summary.durationsMs, []);
  assert.equal(summary.maxMs, null);
});

test("D5 pause tracker: the default open-pause bound is 600 s", () => {
  let now = 0;
  const tracker = createPauseTracker({ now: () => now, pauseThresholdMs: 5000 });
  tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 });
  now = 5000;
  tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 });
  assert.equal(tracker.inPause(), true);
  now = 599999;
  assert.equal(tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 }), null);
  assert.equal(tracker.inPause(), true);
  now = 600000;
  const closed = tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 });
  assert.equal(closed?.type, "pause_end");
  assert.equal(closed?.timedOut, true);
  assert.equal(tracker.inPause(), false);
});

test("D5 pause tracker: progress still ends a pause normally before the fallback", () => {
  let now = 0;
  const tracker = createPauseTracker({ now: () => now, pauseThresholdMs: 5000, maxOpenPauseMs: 60000 });
  tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 });
  now = 5000;
  tracker.sample({ pendingCount: 666, answerChars: 43, answerTurns: 1 });
  now = 30000;
  const ended = tracker.sample({ pendingCount: 0, answerChars: 500, answerTurns: 1 });
  assert.equal(ended?.type, "pause_end");
  assert.equal(ended?.timedOut, undefined);
  assert.equal(ended?.durationMs, 30000);
  const summary = summarizePauses(tracker.events());
  assert.equal(summary.completedPauses, 1);
  assert.equal(summary.timedOutPauses, 0);
});

test("D5 summarizePauses: a timed-out pause is censored, not a completed pause", () => {
  const summary = summarizePauses([
    { type: "pause_start", atMs: 0 },
    { type: "pause_end", atMs: 600000, durationMs: 600000, timedOut: true },
    { type: "pause_start", atMs: 700000 },
    { type: "pause_end", atMs: 760000, durationMs: 60000 },
  ]);
  assert.equal(summary.pauseCount, 2);
  assert.equal(summary.completedPauses, 1);
  assert.equal(summary.timedOutPauses, 1);
  assert.equal(summary.openPauses, 0);
  assert.deepEqual(summary.durationsMs, [60000]);
  assert.equal(summary.maxMs, 60000);
});

test("D5 pause tracker: an invalid open-pause bound is rejected", () => {
  assert.throws(() => createPauseTracker({ maxOpenPauseMs: 0 }), /INVALID_MAX_OPEN_PAUSE_MS/);
  assert.throws(() => createPauseTracker({ maxOpenPauseMs: -1 }), /INVALID_MAX_OPEN_PAUSE_MS/);
  assert.throws(() => createPauseTracker({ maxOpenPauseMs: Number.NaN }), /INVALID_MAX_OPEN_PAUSE_MS/);
});

test("D5 driver: invalid stale-pending options are rejected", async () => {
  const clock = virtualClock();
  await assert.rejects(
    waitForCompletion(stateCdp(() => run1State()), "session-1", geminiAdapter, {
      stalePendingMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    }),
    /INVALID_STALE_PENDING_MS/,
  );
  await assert.rejects(
    waitForCompletion(stateCdp(() => run1State()), "session-1", geminiAdapter, {
      stalePendingMinChars: -1,
      now: clock.now,
      sleep: clock.sleep,
    }),
    /INVALID_STALE_PENDING_MIN_CHARS/,
  );
});
