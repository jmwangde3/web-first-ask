// D5 — alive/dead stall classification for the CDP completion wait.
//
// Problem (branch acceptance, Windows 2026-11-26): 5/5 Gemini background
// runs paused 38-52 s in with pendingCount 482-658 and answerChars stuck at
// 18-25, openPause 249-269 s at the 300 s cutoff; the visible control ALSO
// timed out at 422.9 s. 420 s is therefore proven insufficient as a timeout
// — but there is a confound: that day Gemini may have been throttling (the
// same prompt took 27-55 s the day before), so the data cannot attribute the
// pause to a single code defect. Background-tab freeze and service
// throttling are indistinguishable from that data.
//
// Strategy (this module): stop treating the 420 s boundary as a stall
// declaration and treat it as a *classification* boundary instead. At the
// boundary, and on every re-check afterwards, classify the turn:
//
//   alive — the page still answers CDP reads AND the provider still reports
//           work in flight (pendingCount > 0). A paused-but-alive turn keeps
//           waiting past 420 s under a bounded continued-wait budget, with
//           periodic re-classification. This is the D5 shape: pending stuck
//           at 482-658, chars stuck at 18-25, page responsive.
//   dead  — the page does not answer reads (page_unresponsive), or nothing
//           is in flight and nothing completed (nothing_pending), or the
//           page shows a completion signal yet no progress for the whole
//           window (completion_signal_without_progress). A dead turn keeps
//           the existing behaviour: declared `stalled` at the boundary.
//
// Deliberate limits of the distinction:
// - It cannot tell server-side throttling from client-side background
//   throttling: both look like "alive, no text growth". Only the pause
//   record can separate them afterwards (a pause that ends with text growth
//   was a slow service; a pause that ends dead was a freeze). Do not claim
//   the classifier diagnoses the cause.
// - `stopVisible` is NOT an alive signal: Gemini's stop button disappears
//   during a long-thinking pause, and ChatGPT's is 0x0 / unreliable
//   (see driver.js). Pending count is the only in-flight signal used.
// - A CDP transport failure (evaluate throws / hangs) is not classified
//   here: a throw still propagates out of waitForCompletion as before, and
//   there is no per-read timeout in this change.
// - The continued wait is bounded by `continuedWaitBudgetMs` (default
//   600 s) AND by the caller's `hardTimeoutMs` (default 900 s), whichever
//   hits first. Nothing here auto-resends: a stalled turn is reported, and
//   recovery stays manual (collect / resolve after checking the browser).
// - This policy only runs on the non-`requiresCompletionActions` path
//   (Gemini). ChatGPT keeps its existing `no_completion_signal` branch
//   untouched, because its pending count is forced to 0 in the wait loop.
//
// Wiring: `waitForCompletion` (src/browser/driver.js) calls `evaluate` at
// the stall boundary and `noteProgress` whenever text/pending progress is
// seen. Decisions are emitted through `onDecision`; the driver forwards
// them to the pause tracker (`recordDecision`, src/stall-measurement.js)
// so they land in the same `<requestId>.jsonl` pause log, and records the
// terminal decision in the wait result's `evidence.stallDecision`
// (completed runs carry `evidence.stallDecisions` when a continued wait
// happened). No prompt or response text is ever recorded — counts and
// character lengths only.
//
// Verification procedure (Windows, live logged-in Chrome required):
//   1. $env:WFA_PAUSE_EVENTS_DIR = "d5c-pauses"
//      wfa cdp ask --provider gemini --mode background --prompt "<long task>" --timeout 900 --json
//      (note --timeout 900: the continued wait is capped by the hard
//      timeout, so a 300 s timeout would cut the run before the strategy
//      can show anything; stallTimeoutMs stays min(hardTimeout, 420 s)).
//   2. Repeat the same prompt at least 5 times, background mode.
//   3. node scripts/summarize-pauses.mjs d5c-pauses\*.jsonl
//      Read the stall-decision lines, not just the pause percentiles:
//      - stall_alive_continued + later completion  => pause was throttling,
//        not a freeze; the old 420 s verdict would have killed a healthy turn.
//      - stall_dead page_unresponsive               => the page stopped
//        answering reads: a freeze, not throttling.
//      - stall_dead nothing_pending                => generation ended
//        server-side with no completion signal.
//      - stall_continued_wait_exhausted            => alive for the whole
//        budget and still not done: raise the budget only with data, or
//        accept the stall.

export const DEFAULT_CONTINUED_WAIT_BUDGET_MS = 600000;

// The positive liveness test. `readOk` must be an explicit true: a read
// that returned no value (or unparsable JSON) reports `readOk: false` from
// readTurnState, and must never count as alive. `completionSignal` is the
// strict `answerActionsVisible === true`; a missing field is not a signal.
export function classifyStallLiveness({ pendingCount = 0, readOk = true, completionSignal = false } = {}) {
  if (readOk !== true) {
    return { alive: false, deadReason: "page_unresponsive", pendingCount, readOk };
  }
  if (Number.isInteger(pendingCount) && pendingCount > 0) {
    return { alive: true, deadReason: null, pendingCount, readOk };
  }
  if (completionSignal === true) {
    return { alive: false, deadReason: "completion_signal_without_progress", pendingCount, readOk };
  }
  return { alive: false, deadReason: "nothing_pending", pendingCount, readOk };
}

// Stateful policy for one wait: tracks the continued-wait episode across
// polls. Pure except for the injected clock and the `onDecision` sink;
// a throwing sink must never break the wait.
export function createAliveStallPolicy({
  stallTimeoutMs = 420000,
  continuedWaitBudgetMs = DEFAULT_CONTINUED_WAIT_BUDGET_MS,
  now = () => Date.now(),
  onDecision = null,
} = {}) {
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) {
    throw new Error("INVALID_STALL_TIMEOUT");
  }
  if (!Number.isFinite(continuedWaitBudgetMs) || continuedWaitBudgetMs < 0) {
    throw new Error("INVALID_CONTINUED_WAIT_BUDGET");
  }
  let continuedSince = null;
  let terminal = null;
  const decisions = [];

  const emit = (decision) => {
    decisions.push(decision);
    if (typeof onDecision === "function") {
      try {
        onDecision(decision);
      } catch {}
    }
  };

  // Called at the stall boundary (and on every poll past it). Returns
  // `{ action: "wait", phase }` to keep waiting or
  // `{ action: "stalled", reason: "no_progress", decision }` to declare
  // the stall. `silentMs` is now() - lastProgressAt from the caller.
  // Before the boundary it is a no-op wait; progress resets the episode
  // via noteProgress(), so a new silence episode gets a fresh budget.
  function evaluate({
    silentMs,
    pendingCount = 0,
    readOk = true,
    completionSignal = false,
    answerChars = null,
    answerTurns = null,
  } = {}) {
    if (terminal) {
      return { action: "stalled", reason: "no_progress", decision: terminal };
    }
    if (!Number.isFinite(silentMs) || silentMs < stallTimeoutMs) {
      return { action: "wait", phase: "within_stall_window" };
    }
    const at = now();
    const liveness = classifyStallLiveness({ pendingCount, readOk, completionSignal });
    if (!liveness.alive) {
      const decision = {
        type: "stall_dead",
        at: new Date(at).toISOString(),
        atMs: at,
        silentMs,
        stallTimeoutMs,
        deadReason: liveness.deadReason,
        pendingCount: liveness.pendingCount,
        readOk: liveness.readOk,
        answerChars,
        answerTurns,
      };
      terminal = decision;
      emit(decision);
      return { action: "stalled", reason: "no_progress", decision };
    }
    if (continuedSince === null) {
      continuedSince = at;
      const decision = {
        type: "stall_alive_continued",
        at: new Date(at).toISOString(),
        atMs: at,
        silentMs,
        stallTimeoutMs,
        continuedWaitBudgetMs,
        continuedWaitRemainingMs: continuedWaitBudgetMs,
        pendingCount: liveness.pendingCount,
        readOk: liveness.readOk,
        answerChars,
        answerTurns,
      };
      emit(decision);
      return { action: "wait", phase: "continued_wait", decision, continuedWaitRemainingMs: continuedWaitBudgetMs };
    }
    const continuedMs = at - continuedSince;
    if (continuedMs >= continuedWaitBudgetMs) {
      const decision = {
        type: "stall_continued_wait_exhausted",
        at: new Date(at).toISOString(),
        atMs: at,
        silentMs,
        stallTimeoutMs,
        continuedWaitBudgetMs,
        continuedWaitMs: continuedMs,
        pendingCount: liveness.pendingCount,
        readOk: liveness.readOk,
        answerChars,
        answerTurns,
      };
      terminal = decision;
      emit(decision);
      return { action: "stalled", reason: "no_progress", decision };
    }
    return {
      action: "wait",
      phase: "continued_wait",
      continuedWaitRemainingMs: continuedWaitBudgetMs - continuedMs,
    };
  }

  // Text or pending-count progress was seen: the silence episode is over.
  // Clears the continued-wait clock and any terminal decision so the next
  // silence episode is judged from scratch with a fresh budget.
  function noteProgress() {
    continuedSince = null;
    terminal = null;
  }

  return {
    evaluate,
    noteProgress,
    decisions: () => [...decisions],
    phase: () => (terminal ? "stalled" : continuedSince !== null ? "continued_wait" : "within_stall_window"),
  };
}
