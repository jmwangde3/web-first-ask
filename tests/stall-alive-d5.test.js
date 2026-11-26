// D5 fix — alive/dead stall strategy (src/stall-alive.js, wired in
// src/browser/driver.js waitForCompletion).
//
// Pure functions + fake timers only: no live browser, no real sleeps. The
// live runs these changes exist for are documented in src/stall-alive.js
// (Windows, logged-in Chrome required).
//
// Covers:
//   (a) paused-but-alive (pending > 0, page responsive, no text growth) is
//       NOT declared stalled at 420 s and keeps waiting;
//   (b) dead (no response / nothing pending) IS declared stalled;
//   (c) the decision is recorded in the pause events.
// ChatGPT's requiresCompletionActions path is asserted unchanged: the
// policy never runs there and no stall decision is recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONTINUED_WAIT_BUDGET_MS,
  classifyStallLiveness,
  createAliveStallPolicy,
} from "../src/stall-alive.js";
import {
  appendPauseEvents,
  createPauseTracker,
  formatStallDecisions,
  readPauseEvents,
  summarizePauses,
  summarizeStallDecisions,
} from "../src/stall-measurement.js";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { waitForCompletion } from "../src/browser/driver.js";

// --- classifier ------------------------------------------------------------

test("D5 alive/dead: pending > 0 with a responsive page is alive", () => {
  const result = classifyStallLiveness({ pendingCount: 482, readOk: true });
  assert.equal(result.alive, true);
  assert.equal(result.deadReason, null);
});

test("D5 alive/dead: a page that does not answer reads is dead (page_unresponsive)", () => {
  const result = classifyStallLiveness({ pendingCount: 0, readOk: false });
  assert.equal(result.alive, false);
  assert.equal(result.deadReason, "page_unresponsive");
});

test("D5 alive/dead: nothing pending and no completion signal is dead (nothing_pending)", () => {
  const result = classifyStallLiveness({ pendingCount: 0, readOk: true });
  assert.equal(result.alive, false);
  assert.equal(result.deadReason, "nothing_pending");
});

test("D5 alive/dead: a completion signal with no progress is dead, not alive", () => {
  const result = classifyStallLiveness({ pendingCount: 0, readOk: true, completionSignal: true });
  assert.equal(result.alive, false);
  assert.equal(result.deadReason, "completion_signal_without_progress");
});

test("D5 alive/dead: stopVisible alone is not an alive signal", () => {
  // Gemini's stop button disappears during a long-thinking pause, so the
  // classifier deliberately takes no stopVisible input at all: pending 0
  // stays dead even if a stop button were visible.
  const result = classifyStallLiveness({ pendingCount: 0, readOk: true });
  assert.equal(result.alive, false);
});

// --- policy ----------------------------------------------------------------

test("D5 policy (a): paused-but-alive is NOT stalled at 420 s and keeps waiting", () => {
  let now = 0;
  const seen = [];
  const policy = createAliveStallPolicy({
    stallTimeoutMs: 420000,
    continuedWaitBudgetMs: 600000,
    now: () => now,
    onDecision: (decision) => seen.push(decision),
  });

  assert.deepEqual(policy.evaluate({ silentMs: 1000, pendingCount: 500, readOk: true }), {
    action: "wait",
    phase: "within_stall_window",
  });
  assert.equal(seen.length, 0);

  now = 420000;
  const atBoundary = policy.evaluate({ silentMs: 420000, pendingCount: 500, readOk: true, answerChars: 25, answerTurns: 1 });
  assert.equal(atBoundary.action, "wait");
  assert.equal(atBoundary.phase, "continued_wait");
  assert.equal(atBoundary.continuedWaitRemainingMs, 600000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "stall_alive_continued");
  assert.equal(seen[0].pendingCount, 500);
  assert.equal(seen[0].answerChars, 25);

  // Still waiting 100 s into the continued wait: one decision event only,
  // no duplicate emission per poll.
  now = 520000;
  const later = policy.evaluate({ silentMs: 520000, pendingCount: 500, readOk: true, answerChars: 25, answerTurns: 1 });
  assert.equal(later.action, "wait");
  assert.equal(later.phase, "continued_wait");
  assert.equal(later.continuedWaitRemainingMs, 500000);
  assert.equal(seen.length, 1);
  assert.equal(policy.phase(), "continued_wait");
});

test("D5 policy (b): dead at the boundary IS stalled — nothing pending", () => {
  let now = 0;
  const seen = [];
  const policy = createAliveStallPolicy({
    stallTimeoutMs: 420000,
    now: () => now,
    onDecision: (decision) => seen.push(decision),
  });
  now = 420000;
  const outcome = policy.evaluate({ silentMs: 420000, pendingCount: 0, readOk: true, answerChars: 25, answerTurns: 1 });
  assert.equal(outcome.action, "stalled");
  assert.equal(outcome.reason, "no_progress");
  assert.equal(outcome.decision.type, "stall_dead");
  assert.equal(outcome.decision.deadReason, "nothing_pending");
  assert.equal(seen.length, 1);
  assert.equal(policy.phase(), "stalled");
  // A repeated evaluation returns the same terminal decision, no re-emit.
  const again = policy.evaluate({ silentMs: 421000, pendingCount: 0, readOk: true });
  assert.equal(again.action, "stalled");
  assert.equal(again.decision, outcome.decision);
  assert.equal(seen.length, 1);
});

test("D5 policy (b): dead at the boundary IS stalled — page unresponsive", () => {
  let now = 420000;
  const policy = createAliveStallPolicy({ stallTimeoutMs: 420000, now: () => now });
  const outcome = policy.evaluate({ silentMs: 420000, pendingCount: 0, readOk: false, answerChars: 10, answerTurns: 1 });
  assert.equal(outcome.action, "stalled");
  assert.equal(outcome.decision.type, "stall_dead");
  assert.equal(outcome.decision.deadReason, "page_unresponsive");
});

test("D5 policy: an alive turn that never resumes IS stalled when the continued budget runs out", () => {
  let now = 0;
  const seen = [];
  const policy = createAliveStallPolicy({
    stallTimeoutMs: 420000,
    continuedWaitBudgetMs: 600000,
    now: () => now,
    onDecision: (decision) => seen.push(decision),
  });
  now = 420000;
  assert.equal(policy.evaluate({ silentMs: 420000, pendingCount: 500, readOk: true }).action, "wait");
  now = 420000 + 600000;
  const outcome = policy.evaluate({ silentMs: 1020000, pendingCount: 500, readOk: true, answerChars: 25, answerTurns: 1 });
  assert.equal(outcome.action, "stalled");
  assert.equal(outcome.reason, "no_progress");
  assert.equal(outcome.decision.type, "stall_continued_wait_exhausted");
  assert.equal(outcome.decision.continuedWaitMs, 600000);
  assert.deepEqual(seen.map((d) => d.type), ["stall_alive_continued", "stall_continued_wait_exhausted"]);
});

test("D5 policy: alive that turns dead mid-continued-wait is stalled immediately", () => {
  let now = 0;
  const seen = [];
  const policy = createAliveStallPolicy({
    stallTimeoutMs: 420000,
    continuedWaitBudgetMs: 600000,
    now: () => now,
    onDecision: (decision) => seen.push(decision),
  });
  now = 420000;
  assert.equal(policy.evaluate({ silentMs: 420000, pendingCount: 500, readOk: true }).action, "wait");
  // 60 s later the page stops answering reads: no waiting out the budget.
  now = 480000;
  const outcome = policy.evaluate({ silentMs: 480000, pendingCount: 0, readOk: false, answerChars: 25, answerTurns: 1 });
  assert.equal(outcome.action, "stalled");
  assert.equal(outcome.decision.type, "stall_dead");
  assert.equal(outcome.decision.deadReason, "page_unresponsive");
  assert.deepEqual(seen.map((d) => d.type), ["stall_alive_continued", "stall_dead"]);
});

test("D5 policy: progress resets the episode, so a new silence gets a fresh budget", () => {
  let now = 0;
  const seen = [];
  const policy = createAliveStallPolicy({
    stallTimeoutMs: 420000,
    continuedWaitBudgetMs: 600000,
    now: () => now,
    onDecision: (decision) => seen.push(decision),
  });
  now = 420000;
  assert.equal(policy.evaluate({ silentMs: 420000, pendingCount: 500, readOk: true }).action, "wait");
  now = 500000;
  assert.equal(policy.evaluate({ silentMs: 500000, pendingCount: 500, readOk: true }).action, "wait");
  // Text grows: the silence episode is over.
  policy.noteProgress();
  assert.equal(policy.phase(), "within_stall_window");
  // A second silence episode starts its own continued wait from scratch.
  now = 920000;
  const second = policy.evaluate({ silentMs: 420000, pendingCount: 500, readOk: true });
  assert.equal(second.action, "wait");
  assert.equal(second.phase, "continued_wait");
  assert.equal(second.continuedWaitRemainingMs, 600000);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].type, "stall_alive_continued");
});

test("D5 policy: invalid budgets are rejected, not silently clamped", () => {
  assert.throws(() => createAliveStallPolicy({ stallTimeoutMs: 0 }), /INVALID_STALL_TIMEOUT/);
  assert.throws(() => createAliveStallPolicy({ continuedWaitBudgetMs: -1 }), /INVALID_CONTINUED_WAIT_BUDGET/);
  assert.equal(DEFAULT_CONTINUED_WAIT_BUDGET_MS, 600000);
});

// --- decision recording ------------------------------------------------------

test("D5 recording (c): stall decisions land in the pause events and survive a JSONL round-trip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-d5-"));
  try {
    let now = 0;
    const tracker = createPauseTracker({ now: () => now, provider: "gemini", mode: "background", taskId: "t1" });
    const policy = createAliveStallPolicy({
      stallTimeoutMs: 420000,
      now: () => now,
      onDecision: (decision) => tracker.recordDecision(decision),
    });
    tracker.sample({ pendingCount: 500, answerChars: 25, answerTurns: 1 });
    now = 5000;
    tracker.sample({ pendingCount: 500, answerChars: 25, answerTurns: 1 });
    now = 420000;
    policy.evaluate({ silentMs: 420000, pendingCount: 500, readOk: true, answerChars: 25, answerTurns: 1 });
    tracker.finish({ status: "stalled" });

    const events = tracker.events();
    const decision = events.find((event) => event.type === "stall_alive_continued");
    assert.ok(decision, "decision recorded in tracker events");
    assert.equal(decision.provider, "gemini");
    assert.equal(decision.mode, "background");
    assert.equal(decision.taskId, "t1");
    assert.equal(decision.pendingCount, 500);
    // No prompt/response text ever lands in the log.
    assert.equal("answerText" in decision, false);
    assert.equal("prompt" in decision, false);

    // Pause percentiles are unchanged by decision events.
    const pauseSummary = summarizePauses(events);
    assert.equal(pauseSummary.pauseCount, 1);
    assert.equal(pauseSummary.openPauses, 1);

    const decisions = summarizeStallDecisions(events);
    assert.equal(decisions.total, 1);
    assert.equal(decisions.stallAliveContinued, 1);
    assert.equal(decisions.stallDead, 0);
    assert.match(formatStallDecisions(decisions), /alive-continued: 1/);

    const file = path.join(dir, "run.jsonl");
    await appendPauseEvents(file, events);
    const roundTripped = await readPauseEvents(file);
    assert.equal(roundTripped.length, events.length);
    assert.equal(summarizeStallDecisions(roundTripped).stallAliveContinued, 1);

    assert.equal(formatStallDecisions(summarizeStallDecisions([])), "stall decisions: none recorded");
    assert.match(
      formatStallDecisions({ total: 2, stallAliveContinued: 1, stallDead: 1, stallContinuedWaitExhausted: 0, deadReasons: { page_unresponsive: 1 } }),
      /dead reasons: page_unresponsive x1/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- driver integration ------------------------------------------------------

function geminiState({ answerChars, pendingCount, actionsVisible, stopVisible }) {
  return JSON.stringify({
    userTurns: 1,
    answerTurns: 1,
    answerText: "x".repeat(answerChars),
    answerActionsVisible: actionsVisible,
    pendingCount,
    stopVisible,
    editorEmpty: true,
    title: "Gemini",
  });
}

test("D5 driver (a): Gemini paused-but-alive completes after 420 s instead of stalling", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        // The 2026-11-26 acceptance shape: pending stuck high, chars stuck
        // at 25, page responsive — then growth resumes at 600 s.
        if (virtualTime < 600000) {
          return { result: { value: geminiState({ answerChars: 25, pendingCount: 500, actionsVisible: false, stopVisible: false }) } };
        }
        return { result: { value: geminiState({ answerChars: 8000, pendingCount: 0, actionsVisible: true, stopVisible: false }) } };
      }
      return {};
    },
  };
  const tracker = createPauseTracker({ now: () => virtualTime, provider: "gemini", mode: "background", taskId: "t-alive" });

  const res = await waitForCompletion(mockCdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 1000,
    stallTimeoutMs: 420000,
    continuedWaitBudgetMs: 600000,
    hardTimeoutMs: 900000,
    pollIntervalMs: 500,
    pauseTracker: tracker,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "completed");
  assert.ok(res.elapsedMs > 420000, `elapsed ${res.elapsedMs} ms should exceed the 420 s boundary`);
  assert.equal(res.text.length, 8000);
  // The continued wait is visible in the result evidence…
  assert.equal(res.evidence.stallDecisions?.length, 1);
  assert.equal(res.evidence.stallDecisions[0].type, "stall_alive_continued");
  assert.equal(res.evidence.stallDecisions[0].pendingCount, 500);
  // …and in the pause events (c).
  tracker.finish({ status: res.status });
  const events = tracker.events();
  assert.ok(events.some((event) => event.type === "pause_start"), "pause recorded");
  assert.ok(events.some((event) => event.type === "pause_end"), "pause ended when text resumed");
  const decision = events.find((event) => event.type === "stall_alive_continued");
  assert.ok(decision, "decision recorded in pause events");
  assert.equal(decision.provider, "gemini");
  assert.equal(summarizeStallDecisions(events).stallAliveContinued, 1);
});

test("D5 driver (b): Gemini dead with nothing pending IS stalled at 420 s", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: geminiState({ answerChars: 16, pendingCount: 0, actionsVisible: false, stopVisible: false }) } };
      }
      return {};
    },
  };
  const decisions = [];

  const res = await waitForCompletion(mockCdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 1000,
    stallTimeoutMs: 420000,
    continuedWaitBudgetMs: 600000,
    hardTimeoutMs: 900000,
    pollIntervalMs: 500,
    onStallDecision: (decision) => decisions.push(decision),
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "stalled");
  assert.equal(res.reason, "no_progress");
  assert.ok(res.elapsedMs >= 420000 && res.elapsedMs < 421000, `elapsed ${res.elapsedMs} ms should stall at the boundary`);
  assert.equal(res.evidence.stallDecision?.type, "stall_dead");
  assert.equal(res.evidence.stallDecision?.deadReason, "nothing_pending");
  assert.deepEqual(decisions.map((d) => d.type), ["stall_dead"]);
});

test("D5 driver (b): Gemini page that stops answering reads IS stalled as page_unresponsive", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        if (virtualTime < 5000) {
          return { result: { value: geminiState({ answerChars: 10, pendingCount: 100, actionsVisible: false, stopVisible: true }) } };
        }
        // No value back from the page: readTurnState reports readOk false.
        return { result: { value: null } };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "session-1", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 1000,
    stallTimeoutMs: 420000,
    continuedWaitBudgetMs: 600000,
    hardTimeoutMs: 900000,
    pollIntervalMs: 500,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "stalled");
  assert.equal(res.reason, "no_progress");
  assert.equal(res.evidence.stallDecision?.type, "stall_dead");
  assert.equal(res.evidence.stallDecision?.deadReason, "page_unresponsive");
  assert.ok(res.elapsedMs >= 420000);
});

test("D5 driver: ChatGPT keeps its no_completion_signal branch and records no stall decision", async () => {
  let virtualTime = 0;
  const mockCdp = {
    send: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({
              userTurns: 1,
              answerTurns: 1,
              answerText: "Stuck token...",
              answerActionsVisible: false,
              stopVisible: true,
              editorEmpty: true,
              title: "ChatGPT",
            }),
          },
        };
      }
      return {};
    },
  };
  const tracker = createPauseTracker({ now: () => virtualTime, provider: "chatgpt", mode: "background", taskId: "t-chatgpt" });

  const res = await waitForCompletion(mockCdp, "session-1", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    settleMs: 2000,
    stallTimeoutMs: 6000,
    pollIntervalMs: 500,
    pauseTracker: tracker,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  assert.equal(res.status, "stalled");
  assert.equal(res.reason, "no_completion_signal");
  assert.equal(res.evidence.completionSignalMissing, true);
  assert.ok(res.elapsedMs >= 6000);
  assert.equal(
    tracker.events().filter((event) => String(event.type).startsWith("stall_")).length,
    0,
    "the alive/dead policy must not run on the requiresCompletionActions path",
  );
});
