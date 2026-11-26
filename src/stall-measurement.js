// D5 — Gemini long-answer pause measurement (backlog item D5).
//
// Background: on 2026-11-25 a Gemini answer in background mode showed
// `.pending` stuck at 378 for 5+ minutes with no text change, then completed
// at 7,803 chars; the same kind of task finished in 41 s in visible mode.
// `stallTimeoutMs` defaults to 420 s. One sample cannot establish a pause
// distribution, so this module records pause events and summarises them
// offline instead of guessing a new timeout. See STALL_TIMEOUT_DECISION.
//
// Wiring (no live browser on this machine, so nothing below has run live):
// - Call `createPauseTracker().sample()` once per poll with the values
//   `waitForCompletion` already reads (`pendingCount`, `answerText.length`,
//   `answerTurns`). The call site is `src/browser/driver.js`
//   `waitForCompletion`'s poll loop; that file is owned by another workstream,
//   so the call is NOT made here — this module only provides the tracker and
//   the log format. `createStallWatch` (src/stall-watch.js) already forwards
//   `stall_declared` events through its `onStallEvent` option, and
//   `refreshTask` (src/runner-stall.js) records them on the child as
//   `stallEvents` (bounded, last 20; counts and lengths only).
// - Pause events are JSONL: one object per line, written with
//   `appendPauseEvents` to a dedicated measurement file (default name
//   suggested by the procedure below: `<run-dir>/pause-events.jsonl`).
//   They contain NO prompt or response text — only pending counts and
//   character lengths, per the AGENTS.md rule for the task ledger.
// - Summarise offline with `node scripts/summarize-pauses.mjs <file.jsonl>`.
//
// Measurement procedure (Windows, live logged-in Chrome required):
//   1. Pick a long Gemini task (e.g. a multi-file code answer) and run it
//      at least 5 times in background mode, e.g.:
//        wfa cdp ask --provider gemini --mode background --prompt "<task>" --json
//      with the pause tracker wired into the poll loop, writing
//      `<run-dir>/pause-events.jsonl` per run.
//   2. Run `node scripts/summarize-pauses.mjs <run-dir>/pause-events.jsonl`
//      per run and across runs (concatenate the files).
//   3. Decide: if p90 pause < 420 s and no pause ever exceeded 420 s, the
//      420 s default stands; if any completed pause exceeded 420 s, raise the
//      background default or add a "paused but not dead" page signal.
//   Until those runs exist, STALL_TIMEOUT_DECISION below is PROVISIONAL.
//   Update (2026-11-26, D5 fix): the "paused but not dead" signal now
//   exists — src/stall-alive.js classifies the 420 s boundary as alive
//   (page responsive, pendingCount > 0) vs dead, keeps an alive turn waiting
//   under a bounded continued-wait budget, and records the decision as a
//   stall_* event in this same log (see recordDecision). The live runs must
//   therefore be read for stall decisions as well as pause durations:
//   `node scripts/summarize-pauses.mjs` prints both. 420 s is now a
//   classification boundary, not a stall declaration; the decision below
//   stays PROVISIONAL until those runs separate throttling from freeze.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// D5 decision, recorded 2026-11-26, updated the same day. PROVISIONAL:
// no live pause-distribution data exists yet (a live logged-in Chrome is
// required and was not available), so the 420 s boundary is kept, not
// endorsed as sufficient. What changed: 420 s is no longer a stall
// declaration. Branch acceptance (Windows 2026-11-26) reproduced 5/5
// background pauses (pending 482-658, chars 18-25, openPause 249-269 s at
// the 300 s cutoff) and the visible control also timed out at 422.9 s, so
// 420 s as a declaration is proven insufficient — with the confound that
// Gemini may have been throttling that day (same prompt: 27-55 s the day
// before). src/stall-alive.js now classifies the boundary instead: a
// paused-but-alive turn (page responsive, pendingCount > 0) keeps waiting
// up to a further 600 s continued-wait budget (capped by hardTimeoutMs);
// a dead turn is still declared stalled at 420 s. The decision becomes
// final only after live runs separate throttling from freeze via the
// recorded stall decisions (see the procedure in this file's header).
export const PROVISIONAL_STALL_TIMEOUT_MS = 420000;

export const STALL_TIMEOUT_DECISION = Object.freeze({
  item: "D5",
  decision: "keep",
  stallTimeoutMs: PROVISIONAL_STALL_TIMEOUT_MS,
  status: "PROVISIONAL",
  decidedAt: "2026-11-26",
  basis: "Single measured background pause (2026-11-25): .pending stayed 378 "
    + "for 5+ min with no text change, answer then completed at 7803 chars; "
    + "same kind of task finished in 41 s in visible mode. One sample cannot "
    + "establish a distribution. Branch acceptance (2026-11-26) added 5/5 "
    + "background pauses plus a visible-control timeout at 422.9 s, proving "
    + "420 s insufficient as a stall declaration — with a throttling "
    + "confound that day, so no single cause is attributed. The 420 s value "
    + "is therefore kept as the alive/dead classification boundary "
    + "(src/stall-alive.js), not as a declaration.",
  requires: "Pause-distribution measurement across several long background "
    + "runs (see the procedure in this file's header). Read the stall "
    + "decisions, not just the pause percentiles: a stall_alive_continued "
    + "followed by completion means throttling, a stall_dead means freeze. "
    + "If any alive turn exhausts the continued-wait budget, revisit the "
    + "budget with that data; do not raise a bare number without it.",
});

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

// Tracks pauses in a single generation from poll samples. A pause starts
// when no progress (text growth, pending-count change, or turn-count change)
// is seen for `pauseThresholdMs`, and ends when progress resumes. Progress
// is judged on counts/lengths only; no text is stored.
export function createPauseTracker({
  now = () => Date.now(),
  pauseThresholdMs = 5000,
  provider = null,
  mode = null,
  taskId = null,
} = {}) {
  if (!Number.isFinite(pauseThresholdMs) || pauseThresholdMs < 0) {
    throw new Error("INVALID_PAUSE_THRESHOLD");
  }
  const startAt = now();
  const events = [];
  let lastProgressAt = startAt;
  let lastChars = null;
  let lastPending = null;
  let lastTurns = null;
  let inPause = false;
  let pauseStartedAt = null;
  let pauseSnapshot = null;

  const base = () => ({ provider, mode, taskId });

  // Returns the event emitted by this sample, or null. At most one event
  // per sample: progress ends an open pause; silence starts one.
  function sample({ pendingCount = null, answerChars = null, answerTurns = null } = {}) {
    const at = now();
    const first = lastChars === null && lastPending === null && lastTurns === null;
    const progressed =
      (lastChars !== null && answerChars !== null && answerChars > lastChars) ||
      (lastPending !== null && pendingCount !== null && pendingCount !== lastPending) ||
      (lastTurns !== null && answerTurns !== null && answerTurns !== lastTurns);

    let emitted = null;
    if (progressed || first) {
      if (inPause) {
        emitted = {
          ...base(),
          type: "pause_end",
          at: new Date(at).toISOString(),
          atMs: at,
          durationMs: at - pauseStartedAt,
          pendingCount: pauseSnapshot.pendingCount,
          answerChars: pauseSnapshot.answerChars,
        };
        events.push(emitted);
        inPause = false;
        pauseStartedAt = null;
        pauseSnapshot = null;
      }
      lastProgressAt = at;
    }
    if (answerChars !== null) lastChars = answerChars;
    if (pendingCount !== null) lastPending = pendingCount;
    if (answerTurns !== null) lastTurns = answerTurns;

    if (!inPause && at - lastProgressAt >= pauseThresholdMs) {
      inPause = true;
      pauseStartedAt = lastProgressAt;
      pauseSnapshot = { pendingCount: lastPending, answerChars: lastChars };
      emitted = {
        ...base(),
        type: "pause_start",
        at: new Date(lastProgressAt).toISOString(),
        atMs: lastProgressAt,
        elapsedMs: lastProgressAt - startAt,
        pendingCount: lastPending,
        answerChars: lastChars,
      };
      events.push(emitted);
    }
    return emitted;
  }

  // Closes the run. A pause still open at the end is NOT closed with a
  // fabricated duration: a `run_end` event records it as open, and
  // `summarizePauses` counts it as censored (duration unknown).
  function finish({ status = "unknown" } = {}) {
    const at = now();
    const event = {
      ...base(),
      type: "run_end",
      at: new Date(at).toISOString(),
      atMs: at,
      status,
      openPauseStartedAtMs: inPause ? pauseStartedAt : null,
      openPauseMs: inPause ? at - pauseStartedAt : null,
    };
    events.push(event);
    inPause = false;
    pauseStartedAt = null;
    pauseSnapshot = null;
    return event;
  }

  return {
    sample,
    finish,
    // D5 fix: records an alive/dead stall decision (src/stall-alive.js) in
    // the same event log, stamped with provider/mode/taskId like the pause
    // events. The decision carries counts and character lengths only — no
    // prompt or response text. Unknown decision shapes are stored as-is;
    // summarizePauses ignores non-pause event types.
    recordDecision(event) {
      if (!event || typeof event !== "object") return null;
      const stamped = { ...base(), ...event };
      events.push(stamped);
      return stamped;
    },
    events: () => [...events],
    inPause: () => inPause,
  };
}

// Pairs pause_start/pause_end events (FIFO) and summarises the completed
// pauses. A start with no matching end is an open (censored) pause: counted,
// but its duration is unknown and excluded from the percentiles.
export function summarizePauses(events) {
  const list = Array.isArray(events) ? events : [];
  const open = [];
  const durations = [];
  let openPauses = 0;
  for (const event of list) {
    if (event?.type === "pause_start") {
      open.push(event);
    } else if (event?.type === "pause_end" && open.length) {
      const start = open.shift();
      const duration = Number(event.durationMs);
      if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
    }
  }
  openPauses = open.length;
  durations.sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    pauseCount: durations.length + openPauses,
    completedPauses: durations.length,
    openPauses,
    durationsMs: durations,
    totalPauseMs: total,
    minMs: durations.length ? durations[0] : null,
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    maxMs: durations.length ? durations[durations.length - 1] : null,
    meanMs: durations.length ? Math.round(total / durations.length) : null,
  };
}

export function formatPauseSummary(summary) {
  const ms = (value) => (value === null ? "n/a" : `${value} ms`);
  return [
    `pauses: ${summary.pauseCount} (${summary.completedPauses} completed, ${summary.openPauses} open/censored)`,
    `total paused: ${ms(summary.totalPauseMs)}`,
    `min: ${ms(summary.minMs)}  p50: ${ms(summary.p50Ms)}  p90: ${ms(summary.p90Ms)}  max: ${ms(summary.maxMs)}  mean: ${ms(summary.meanMs)}`,
    summary.openPauses > 0
      ? "note: open pauses have unknown duration and are excluded from the percentiles"
      : "note: no open pauses",
  ].join("\n");
}

// Counts alive/dead stall decisions (src/stall-alive.js) in an event log.
// Pause events and run_end events are ignored, so this composes with
// summarizePauses over the same file.
export function summarizeStallDecisions(events) {
  const list = Array.isArray(events) ? events : [];
  const counts = { stallAliveContinued: 0, stallDead: 0, stallContinuedWaitExhausted: 0 };
  const deadReasons = {};
  for (const event of list) {
    if (event?.type === "stall_alive_continued") {
      counts.stallAliveContinued += 1;
    } else if (event?.type === "stall_dead") {
      counts.stallDead += 1;
      if (typeof event.deadReason === "string" && event.deadReason) {
        deadReasons[event.deadReason] = (deadReasons[event.deadReason] ?? 0) + 1;
      }
    } else if (event?.type === "stall_continued_wait_exhausted") {
      counts.stallContinuedWaitExhausted += 1;
    }
  }
  return {
    ...counts,
    deadReasons,
    total: counts.stallAliveContinued + counts.stallDead + counts.stallContinuedWaitExhausted,
  };
}

export function formatStallDecisions(summary) {
  if (!summary.total) return "stall decisions: none recorded";
  const parts = [
    `alive-continued: ${summary.stallAliveContinued}`,
    `dead: ${summary.stallDead}`,
    `continued-wait exhausted: ${summary.stallContinuedWaitExhausted}`,
  ];
  const reasonEntries = Object.entries(summary.deadReasons ?? {});
  const reasons = reasonEntries.length
    ? ` (dead reasons: ${reasonEntries.map(([reason, count]) => `${reason} x${count}`).join(", ")})`
    : "";
  return `stall decisions: ${summary.total} (${parts.join(", ")})${reasons}`;
}

export async function appendPauseEvents(filePath, events) {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("INVALID_PAUSE_LOG_PATH");
  }
  const list = Array.isArray(events) ? events : [events];
  if (!list.length) return;
  const lines = list.map((event) => `${JSON.stringify(event)}\n`).join("");
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await appendFile(filePath, lines, "utf8");
}

export async function readPauseEvents(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export async function summarizePauseLogFile(filePath) {
  const events = await readPauseEvents(filePath);
  return { events, summary: summarizePauses(events) };
}
