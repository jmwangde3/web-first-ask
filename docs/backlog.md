# Backlog — open defects and planned work

This is the **wfa-side** list: defects in the native CDP engine (`wfa cdp`), the broker (`wfa broker`) and the
provider adapters. Upstream ask-bridge defects (U1–U19) live in [`known-issues.md`](known-issues.md).

State of `main` when this list was written: `f3d104e`, `npm test` = **503 tests, 503 pass**, Node.js >= 22.15,
zero runtime dependencies.

Implementation status (2026-11-26, branch `backlog/d1-f9-live-verify`, package 1.2.0):
first round commit `5146c1b` — `npm test` = **657 tests, 655 pass, 1 fail (pre-existing Linux-only
`cdp-stage.test.js:107`), 1 skipped**; fix round merged on top of it (D2, D3, D5, F1, F4, F7, F8
+ 3 side findings, see status lines) — `npm test` = **709 tests, 707 pass, 1 fail (same pre-existing
Linux-only `cdp-stage.test.js:107`), 1 skipped**; `npm run check` green. No live-browser validation
was run on this VM (no logged-in Chrome here) — every item that needs a real browser is marked
**awaiting live verification** below, with the manual command to run on Windows. Per-item status
lines were added under each heading; nothing else in this file was rewritten.

Side findings fixed in the fix round (from branch acceptance REPORT-7b9e1ceb.md): (a) EPIPE crash on
`broker status --json | head` — `process.stdout.on('error', …)` guard in `src/broker/cli.js`;
(b) 409 idempotency ignored `conversationId` — `src/broker/journal.js` now scopes the match per
conversation (unknown/legacy records stay conservative and still block); (c) stale `browser.lock` /
broker record printed as live by `cdp status` — status now verifies pid/port liveness with
`isInstanceAlive` and reports dead records as `alive: false` instead of printing them as live.
F5 was code-reviewed only (no conformance bugs found; all Claude selectors still UNVERIFIED).

Everything below was reproduced on a real Chrome with logged-in ChatGPT and Gemini accounts unless marked
otherwise. Items marked *(unverified)* were reported but not re-confirmed with a controlled experiment.

## Live verification — muse @ `3f59c5f` (2026-11-26 13:30, Windows 11 / Node 26.13.1 / Chrome 158)

Recorded on this branch only (the shared catalogue is on `main`; `neon` keeps its own copy).

`npm test` = **709/709** with `node --test --test-concurrency=1 --test-timeout=20000` (142 s).
The default `node --test` (parallel) **hangs** on this machine (>22 min, no output) — a test-infrastructure
problem, not a product failure; file-by-file runs all exit 0.

| Item | Live result | Detail |
|---|---|---|
| D1 | **pass** | `--no-wait`; broker pid 29816 unchanged at t+35 s; `read --task-id` returned `completed` ("R"). |
| D2 | **pass** | target tab absent → first `read --url` returned `completed` in 7.5 s, 976 chars, `userTurns=2`. |
| D3 | **pass (fail-closed)** | `--file d3-probe.zip` → `ATTACH_UPLOAD_FAILED` in 8.2 s, `chipCount=1`, no submission (`sendCommittedAt` absent). Meets the second acceptable outcome. |
| D4 | not run this round | last run on 2026-11-26 11:2x passed (11,909 chars from Gemini). |
| D5 | **fail — reproduced** | run1: page finished at **29,970 chars** (title "分布式链路追踪解析与实战"), `stopVisible=false`, but the CLI waited to the **900 s** hard timeout and printed `TIMEOUT`. run2 hit Google `/sorry` and was stopped. `WFA_PAUSE_EVENTS_DIR` produced **no files**. |
| F1 | **fail** | `geminiMode: "task"` now reaches the turn record, but twice failed at ~0.7–3 s with `gemini_mode_failed: task_mode_control_not_found`. DOM probe on the same browser shows the selector is correct (`gem-segmented-button-row[role=group]` exists, Chat/Task buttons present) — the control renders **after** `waitForEditor`, and `ensureProviderMode` checks only once. **Fix (2026-11-26, branch `fix/f1-task-mode-poll`, unpushed):** bounded 5 s / 100 ms in-page poll for the Task control (`button.gem-segmented-button-action` with Task text added as a second lookup; proven segment selector unchanged), click, then verify `aria-pressed="true"` and placeholder `Describe a task` before proceeding; still fail-closed (`task_mode_control_not_found` / new `task_mode_placeholder_not_confirmed`) with `GEMINI_MODE_FAILED` before typing. Awaiting live re-verification on Windows. |
| F4 | **pass** | `--download-dir` captured `sample.csv` (6 B); turn record carries `downloads[]` with path, size, sha256, provider, downloadedAt. CLI stdout does not print the field. |
| F7 | **pass** | `wfa cdp cleanup --dry-run --json` listed 35 sessions / 2 candidates; filtered dry-run (`--provider gemini --conversation-id d9-muse-20261126`) listed exactly 1; real run deleted it in 2.7 s. |
| F5 / F8 / F9 | not re-run this round | unchanged from the previous round. |

**Gemini bot-check recurrence**: run2 was redirected to `https://www.google.com/sorry/...` after run1's
900 s session. See `reverdict/GEMINI-BOT-CHECK-ANALYSIS.md` — long-task runs must be spaced (≥30 min), and
the restored-tab pile-up must be cleared before each run.

## How to validate a fix

```bash
npm test          # 503 tests, must stay green
npm run check     # syntax check
wfa doctor        # Node / Chrome availability
wfa cdp login --provider chatgpt   # or gemini, visible window for manual login
```

House rules (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)):

- never auto-resend an uncertain prompt;
- keep runtime dependencies at zero;
- add a focused regression test for every behaviour change;
- do not claim live-browser validation unless you actually ran it.

---

## Defects

### D1 — a `--no-wait` turn loses its broker and can never finish (P1)

**Status (2026-11-26): done in code, awaiting live verification.** Idle timer now consults
the turn store (`src/broker/server.js` `hasNonTerminalTurn` + 5 s idle grace); a
`needs_human`/restored non-terminal turn pins the broker until terminal or explicit
`wfa broker stop`. Caveat: `wfa broker start` hardcodes `mode: "tray"`, which never idles —
the idle timer only fires in `off` mode, so the 10-minute live run must confirm the
production path.

**Symptom.** `wfa cdp ask --no-wait` returns `state: "running"` and a broker is started, but the broker exits
after its idle timeout while the turn is still running. Nothing advances the turn afterwards.

**Repro.**

```bash
wfa broker stop
wfa cdp ask --provider chatgpt --prompt "reply with one letter: E" --mode background --no-wait --json
# -> { "state": "running", "poll": "wfa read --task-id <id>" }
wfa broker status --json          # after ~30 s: { "running": false }
wfa cdp read --task-id <id> --provider chatgpt --mode background
# -> BROKER_UNREACHABLE: Persisted turn <id> exists, but its broker is not running
#    (submissionState=committed, safeToResend=false)
```

The prompt *was* submitted and the provider is still generating; only the local process that would poll the
page is gone. The turn can still be read with `--url` if you know the conversation URL.

**Where.** `src/broker/server.js` idle timer; broker lifecycle in `src/broker/client.js`.

**Expected.** A broker must not idle out while it owns a non-terminal turn. It may exit after the last turn
reaches a terminal state, or on an explicit `wfa broker stop`.

**Acceptance.** Regression test: submit `--no-wait`, wait past the idle threshold, and the turn must still be
readable and reach `completed`. Real-browser run survives a 10-minute generation.

---

### D2 — first read after reopening a tab returns `unconfirmed` (P1)

**Status (2026-11-26): fix round done in code, awaiting live verification.** Branch
acceptance FAILED on both paths, so the settle was fixed twice: (a) the `attachTab` branch
now also enters settle (a restored-session shell tab is sampled only after message nodes
render, bounded 10 s); (b) settle completion now requires `answerText.trim().length > 0`,
not just any message node — ChatGPT renders user turns → answer shell/action bar → body
text, and the old `userTurns > 0` condition ended settle while the text was still empty.
A genuinely empty conversation still returns `unconfirmed` after the 10 s bound; no fixed
sleep. Regression tests in `tests/cdp-read-d2-fix.test.js` cover both paths
(`src/engines/cdp-read.js`).

**Symptom.** Reading a conversation that has no open tab reopens it and samples the page before the message
list has rendered, so the read reports an empty conversation.

**Repro.**

```bash
wfa cdp read --url https://chatgpt.com/c/<conversation-with-no-open-tab> --provider chatgpt --json
# -> userTurns: 0, text: "", status: "unconfirmed", reason: "no_positive_completion_signal"   (3.1 s)
# same URL again, 5 s later
# -> userTurns: 1, text: "<full answer>", status: "completed"
```

**Where.** `src/engines/cdp-read.js` — the reopen branch (`openTab` → immediate sample). Same class of problem
as reading a freshly loaded page after a cold start.

**Expected.** After opening a tab, poll until message nodes appear (or a bounded timeout, ~10 s) before deciding.
A genuinely empty conversation must still return `unconfirmed`.

**Acceptance.** First read of a real conversation returns `completed` with full text; an empty conversation
still returns `unconfirmed`; no fixed `sleep` left in the path.

*(Good first issue — the change is local and the failure is deterministic.)*

---

### D3 — attachment upload is reported as success while nothing was attached (P1)

**Status (2026-11-26): done in code, awaiting live verification.** Root cause was worse
than stated: Gemini `buildAttachmentVerifyJs` referenced free variables (`sendReady`,
`bases`) so it always threw `ReferenceError` in-page. Fixed (`src/browser/adapters/gemini.js`):
filename-verified chips, selector no longer matches the attach button, fail-closed with
`ATTACH_UPLOAD_FAILED` and no submission. ChatGPT already verified by name (locked by test).

**Follow-up (2026-11-26, branch acceptance FAILED):** the chip is transient — with
`d3b-probe.zip` (421,605 B) the verify passed at the submit moment (`present: true`),
Gemini dropped the zip afterwards, the prompt was submitted anyway (`sendCommittedAt`
written, Gemini answered "No attachment or zip file was provided") and the CLI timed
out after 150 s instead of returning an error. Fix (merged into `backlog/d1-f9-live-verify`):
(1) re-verify at submit time inside the send slot, before any send intent is journaled —
`src/browser/driver.js` `verifyAttachments`, `src/engines/cdp-engine.js` pre-submit
re-check; failure returns `ATTACH_UPLOAD_FAILED` with no submission and no
`sendCommittedAt`. (2) confirm post-submit that every filename is in the newest user
turn (`buildAttachmentPostSubmitVerifyJs` in `gemini.js` / `chatgpt.js` / `claude.js`,
`driver.confirmAttachmentsPostSubmit` with a baseline-user-turns guard, bounded 10 s);
a failed confirmation returns `SUBMITTED_WITH_UNVERIFIED_ATTACHMENT` with the turn
record (`sendCommittedAt` set) instead of waiting out the completion timeout — and
never auto-resends. Filename verification is unchanged and still enforced at all
three checkpoints. Still awaiting live verification on Windows (no logged-in Chrome
on the Linux VM); the post-submit `user-query` filename rendering is the step most
in need of a real-DOM check.

**Neon alignment (2026-11-26, branch `fix/neon-hotfix-align`, from neon `5676132`):**
muse already forwarded `files` through `POST /turns` (`src/broker/server.js:353`,
`src/broker/turns.js`); ported only the missing parts — `createTurn` now validates
`files` as absolute paths, max 20 (`MAX_TURN_FILES`), and the request hash includes
`files` (conditionally, so no-files hashes stay byte-identical and stored orphans
still replay). `wfa broker ask` still has no `--file` support (follow-up, not
covered by neon either).

**Symptom.** `wfa cdp ask --file <archive>` passes the attachment check, the prompt is submitted, but the
provider receives no file. Gemini answers `REPO_UNREADABLE`; ChatGPT has historically answered
"No file is attached".

**Repro.** On Gemini with a ~400 KB zip:

```bash
wfa cdp ask --provider gemini --file ./bundle.zip --prompt "The repository is in the attachment. Read it." --json
```

Then inspect the conversation: the file chip list is empty and the answer is `REPO_UNREADABLE`.

**Where.** `src/browser/adapters/gemini.js` — `attachmentChipSelector` and the `present` check
(around lines 88–104). The check is `chips.length > 0 && sendReady`; it does not verify the file name, and the
selector `[data-testid*="attachment"]` can match the attach button itself.

**Expected.** Verify the uploaded file by name in the conversation's attachment list. If it is missing, fail
closed with an explicit error and do not submit the prompt.

**Acceptance.** Upload assertion checks the filename; a failed upload produces a distinct error code and no
provider submission; a real upload round-trip is covered by a manual check.

---

### D4 — `wfa cdp read` returns only the first line of long answers (P1)

**Status (2026-11-26): done at the read layer, awaiting live verification.** `pending > 0`
now blocks `completed` (returns `streaming` + `partial: true`); a `completed` candidate
must be confirmed by a second identical sample (bounded 2 s); every result carries
`partial: true/false` (`src/engines/cdp-read.js`). Caveat: adapter node-selection itself
was not touched — if live testing shows the DOM text handed to this layer is already
truncated, the remaining fix is in the adapter.

**Symptom.** For long provider answers the CLI returns a fragment — typically the first line — while the page
contains the full text.

**Measured.**

| Case | CLI returned | Page contained |
|---|---|---|
| Gemini answer during a long turn | 30–35 chars | 600+ chars in `model-response` |
| ChatGPT 39 KB patch answer | 13 diff sections | 14 diff sections |

**Where.** The read extraction path in `src/engines/cdp-read.js` / the provider adapters, when the answer is
still streaming (`pending > 0`) or when the body is long.

**Expected.** Return the full answer text; if a partial read is unavoidable, mark it explicitly instead of
returning a short string that looks complete.

**Acceptance.** For a 5 000+ character answer, the CLI output matches the DOM text; existing short-answer
behaviour is unchanged.

---

### D5 — Gemini long answers pause for five minutes or more in background mode (P1, needs measurement)

**Status (2026-11-26): measurement harness built, decision recorded as PROVISIONAL, awaiting
live measurement runs.** `src/stall-measurement.js` + `scripts/summarize-pauses.mjs` record
pause distribution; the tracker is wired into the completion poll loop
(`src/browser/driver.js` `pauseTracker`, `src/engines/cdp-engine.js`) and is opt-in via
`WFA_PAUSE_EVENTS_DIR` (or `deps.pauseEventsDir`), writing `<dir>/<requestId>.jsonl` and a
`pauseSummary` in turn evidence. 420 s is kept **provisionally** — one sample cannot
establish a distribution; revisit if p90 or any completed pause exceeds 420 s.

**Status (2026-11-26, fix merged, awaiting live verification): alive/dead stall
strategy implemented, 420 s is now a classification boundary, not a stall declaration.**
`src/stall-alive.js` (`createAliveStallPolicy`, `continuedWaitBudgetMs` default 600 s,
capped by `hardTimeoutMs`) is wired into `waitForCompletion` (`src/browser/driver.js`):
at the 420 s boundary a turn is declared `stalled` only if dead (page not answering reads
— `readTurnState` now reports `readOk` — or `pendingCount` 0 with no completion signal);
a paused-but-alive turn (page responsive, `pendingCount > 0`, no text growth) keeps
waiting and is re-classified every poll until progress resumes, the page goes dead,
the budget runs out, or the hard timeout hits. Decisions are recorded as `stall_*`
events in the same pause log (`recordDecision` in `src/stall-measurement.js`, printed by
`scripts/summarize-pauses.mjs`) and in turn evidence (`evidence.stallDecision` /
`evidence.stallDecisions`). ChatGPT keeps its existing `no_completion_signal` branch
unchanged. Still awaiting live runs to tell throttling from freeze — and the classifier
cannot tell server-side throttling from client-side background throttling; only the
recorded decisions plus later completion can separate them (see the procedure in
`src/stall-alive.js`). Branch acceptance that motivated this (Windows 2026-11-26):
5/5 background runs paused 38–52 s in, openPause 249–269 s at the 300 s cutoff, and the
visible control also timed out at 422.9 s — with a same-day throttling confound, so no
single cause is attributed.

**Status (2026-11-26, fix on `fix/d5-completion-detection`, awaiting live verification):
completion detection fixed for the stale-pending shape.** Live run1 (REPORT-02360b8c)
reproduced the failure the alive/dead strategy could not save: the page held 29,970
chars with no stop button, but the engine saw `answerChars` 43 and `pendingCount` 666
until the 900 s hard timeout, and the last `pause_start` sat unpaired for 828,596 ms.
Root causes, both fixed: (1) a merely present `pendingCount` refreshed `lastActivityAt`
on every poll, so `settled` could never become true while pending was stuck — activity
now means a change (answer text, pending count, or page-level full text); a missing
actions field now counts as "done" only when nothing is pending (`isActionsDone` in
`src/browser/driver.js`), matching the real Gemini adapter contract (null exactly when
pending is 0). (2) The adapter's `innerText` extraction lags in a background tab, so
`buildReadStateJs` (`src/browser/adapters/gemini.js`) now also reports `modelTextChars`
and `answerTextFull` (textContent-based); when the pending count and the full text are
both frozen for `stalePendingMs` (default: the 420 s stall boundary, NOT raised), the
stop button is gone, and no positive completion signal has appeared, the turn completes
as `completed_stale_pending` with the full text — confirmed by one fresh read (which
also re-activates the tab) before completing. A frozen full text below
`stalePendingMinChars` (default 1000) never completes through this path: observed
genuine thinking pauses all stuck at 18–25 chars. Residual risk is recorded in the
code: a genuine pause past 420 s with a long partial answer and no stop button cannot
be told apart from a completed-but-unfinalised one. (3) `createPauseTracker`
(`src/stall-measurement.js`) force-closes a pause open for `maxOpenPauseMs` (default
600 s) with a paired `pause_end` (`reason: "pause_timeout"`, `timedOut: true`);
timed-out pauses are counted separately and excluded from the duration percentiles
(`summarizePauses`, `scripts/summarize-pauses.mjs`). `stallTimeoutMs` default (420 s)
unchanged. D4 read-layer behaviour (`src/engines/cdp-read.js`: partial marking,
two-sample confirmation) untouched; regression tests in
`tests/stall-d5-completion.test.js` (15 tests, incl. both run1 halves and the
small-text / stop-visible negatives). Live re-verification: single run after ≥30 min
cooldown with restored tabs cleared, D4 re-verified in the same round, serial.

**Measured 2026-11-25.** With the window hidden (`visibility=hidden`):

- `.pending` stayed at 378 for more than five minutes with no text change;
- the answer then completed with 7 803 characters;
- the same kind of task in `visible` mode finished in 41 s.

**Why it matters.** `stallTimeoutMs` now defaults to 420 s. If the pause exceeds that, a healthy turn is
declared `stalled`. The default was raised from 180 s because of this behaviour, but the distribution is still
unknown.

**Task.** Measure pause length across several long background runs; decide whether background mode needs a
longer stall window, or whether a "paused but not dead" signal can be read from the page.

**Acceptance.** A documented measurement, plus either a code change or a recorded decision that 420 s is
sufficient.

---

### D6 — continuation blocked by a composer stop-state (P2, intermittent)

**Status (2026-11-26): capture wired, gate unchanged, awaiting a real capture.** The
composer gate was NOT changed (no guessed fix). `src/browser/composer-capture.js` dumps
the stop control DOM + attributes + stop-state duration; the engine calls it when the
composer gate rejects with a stop-state reason or `typePrompt` throws `PROMPT_NOT_TYPED`
(`src/engines/cdp-engine.js`), writing `<home>/composer-captures/<requestId>.jsonl`
best-effort. No live occurrence was captured here.

**Symptom.** After an answer finishes, the composer can stay in a stop-state for up to ~45 s; a continuation
sent in that window is rejected with `PROMPT_NOT_TYPED` / `composer_stop_state`.

**Current state.** The composer gate only requires *editable + visible + no active stop button*. A continuation
sent on 2026-11-26 succeeded, and the long stop-state did not reproduce. The underlying cause is still unknown.

**Where.** `src/browser/driver.js` composer gate (`ready = editorEditable && editorVisible && !stopActive`).

**What is needed.** A capture from a real occurrence: DOM dump of the stop control, its attributes and how long
it stays. Without that, any change is guesswork.

---

### D7 — Cloudflare interstitial is not parked immediately (P2)

**Status (2026-11-26): done in code, awaiting live verification.** Detection reused
(`isChallengedState`, same condition as `waitForCompletion`); `parkChallengedTab`
navigates the tab to `about:blank` and reports `parked` in all three driver decision
points (`src/browser/driver.js`). A failed park never masks the
`human_verification_required` report.

**Neon alignment (2026-11-26, branch `fix/neon-hotfix-align`, from neon `5676132`):**
`waitForEditor` now also fast-fails on Google `/sorry` URLs
(`sorryUrlPattern = /\/sorry(?:\/|$|\?)/i` on the probe's `location.href`,
same 2-consecutive-polls threshold, same `parkChallengedTab` to `about:blank`
with `HUMAN_VERIFICATION_REQUIRED`) instead of waiting out `hardTimeoutMs`.
Cloudflare/title/password handling unchanged. Awaiting live verification: do
not loop-retry Gemini while the interstitial persists.

**Symptom.** When a Chrome profile is challenged, `chatgpt.com` serves a `请稍候…` page with an empty body. The
engine reports `human_verification_required`, but the challenged tab is left in place.

**Expected.** Detect the interstitial, switch the tab to `about:blank`, and report the state so a retry does not
inherit the challenged page.

**Where.** `src/browser/driver.js` page-state detection; `src/browser/launch.js`.

*(Good first issue — detection is already implemented elsewhere, this is about parking the tab.)*

---

### D8 — reading a background tab can hang until the tab is activated (P2)

**Status (2026-11-26): done in code (tab activation), awaiting live verification; window
focus explicitly UNVERIFIED.** `Target.activateTarget` (not `Page.bringToFront`) runs once
before the first read/wait poll and in the broker live-page probe
(`src/browser/driver.js`, `src/broker/client.js`). Background windows already start
off-screen (`--window-position=-2000,-2000`), but whether Chrome raises/focuses the
window on tab activation was not verified on Windows — if the live run shows focus
theft, that needs a window-layer follow-up.

**Symptom.** A background tab can be throttled or frozen by Chrome, so a read hangs or returns stale state
until the tab is activated.

**Expected.** Activate the tab before reading (or use a CDP call that does not require foreground), and keep the
window from stealing focus — the window layer is what is currently unverified.

**Where.** `src/browser/driver.js` read path; `src/browser/launch.js` window placement.

---

### D9 — Gemini may ignore a reused conversation key (P2, unverified)

**Status (2026-11-26): no code changed (unverified report), test procedure + harness
written, awaiting the live run.** `docs/gemini-conversation-reuse-test.md` (two-ask
procedure, pass/fail criteria, what to capture on failure) and
`scripts/gemini-conversation-reuse.mjs` (manual-run-only harness, requires explicit
`--key --prompt1 --prompt2`). Run it before treating this as a defect.

**Symptom reported earlier:** passing the same conversation identifier on consecutive turns produced a new
conversation each turn instead of continuing the stored one.

**Important context.** `--conversation-id` is a **local key**, not a cloud conversation id. The first use opens
a new conversation and stores its URL; later uses with the *same key* reuse that URL. On ChatGPT this works:
two consecutive `ask` calls with the same key returned `userTurns: 2` and kept the conversation title. The
Gemini case has not been re-tested with this same-key method.

**Next step.** Run the two-ask test against Gemini before treating this as a defect.

---

## Planned work

### F1 — Gemini "Task" mode over CDP (P1)

**Status (2026-11-26): done in code, awaiting live DOM verification.** `--gemini-mode
chat|task` (separate flag; `--mode` stays the window mode), toggle in the Gemini adapter
(selectors carried over from the removed `gemini-mode.js`, `aria-pressed` as state signal),
mode recorded on the turn (`geminiMode`, `evidence.geminiMode`), fail-closed with
`GEMINI_MODE_FAILED` before typing. Broker passthrough wired by the coordinator
(`src/broker/turns.js` accepts `geminiMode`, runner forwards it). **Fix round:** the
`POST /turns` allowlist in `src/broker/server.js` was dropping `geminiMode` (branch
acceptance: `--gemini-mode task` silently ran as Chat), so it is now passed through,
persisted/restored, included in the request hash, and accepted by `wfa broker ask`
(`src/broker/cli.js`); broker-layer regression tests in
`tests/broker-turn-fields-f1-f4.test.js`. **Fix round 2 (2026-11-26, branch
`fix/f1-task-mode-poll`):** live verification found the toggle failing in 0.7–3 s
with `task_mode_control_not_found` — the Task control renders after
`waitForEditor` and the toggle checked only once. `buildTaskModeJs`
(`src/browser/adapters/gemini.js`) now polls for the control, bounded to 5 s
at a 100 ms interval (segment selector first, then
`button.gem-segmented-button-action` with Task text, then the label
fallback), and for task mode verifies `aria-pressed="true"` plus the
composer placeholder becoming `Describe a task` (new distinct reason
`task_mode_placeholder_not_confirmed` if it never does); still fail-closed
with `GEMINI_MODE_FAILED` before typing when the control never appears.
Regression tests in `tests/adapters-f1-f5.test.js` (late control, action
selector, never-appears, placeholder-unconfirmed, already-pressed).
Selectors are UNVERIFIED against the current Gemini DOM.

The Gemini web UI has a Task mode that runs code in a sandbox with Node.js and `git apply --check`. The CDP path
only ever reaches Chat mode, so the CLI cannot use that capability. The old `gemini-mode` command has been
removed; the CDP path needs the mode toggle in the page plus adapter state for it.

### F2 — concurrent multi-provider runs with per-provider artifacts (P2)

**Status (2026-11-26): done in code, awaiting live verification.** `wfa cdp ask
--providers chatgpt,gemini` (no new verb — `wfa compare` does not exist on this branch),
per-provider `<runDir>/<provider>/response.md` + `fanout.json`, `--serial` forces global
serial, retry via `--retry-provider` only for definite pre-submit failures with
`sendCommittedAt == null` (never an uncertain auto-resend). Engine cap: 1 in-flight per
provider, at most 2 across providers. Note: broker queue defaults in code are 4/8 vs
README's stated 1/2 — pre-existing inconsistency, not changed here.

Send the same brief to several providers in parallel, write each answer to its own file, and allow retrying a
single failed provider without touching the others. Must compose with the existing per-provider and global
scheduling limits.

### F3 — extract `FILE:` blocks from answers to disk (P2)

**Status (2026-11-26): done in code, including the CLI consumer.** Integrity self-check
(block counts, fence pairing, hunk line counts) in `src/stage.js`
(`verifyFileBlockIntegrity` / `extractFileBlocksToDisk`); truncated input is refused
before anything is written, output inside a repo is refused, writes are hash-verified
with a `manifest.json`. CLI wired by the coordinator: `wfa cdp extract --input
<answer.md> --out-dir <dir> [--json]`.

Answers frequently contain complete file contents in fenced blocks. Turn that into files on disk, with an
integrity self-check (block counts, fence pairing, hunk line counts) so a truncated answer cannot be written as
a valid file.

### F4 — download attachments produced by providers (P2)

**Status (2026-11-26): done in code, awaiting live verification.** `src/browser/downloads.js`
(`Page.setDownloadBehavior` with `Browser.setDownloadBehavior` fallback, size-stable
wait, SHA-256 verification, distinct fail-closed codes) + download-click hooks in both
adapters + engine wiring by the coordinator: `wfa cdp ask --download-dir <dir>` captures
after a completed turn and records `downloads[]` on the turn (broker copies it through).
**Fix round:** the `POST /turns` allowlist in `src/broker/server.js` was dropping
`downloadDir` (branch acceptance: `--download-dir` never reached the capture), so it is
now passed through, persisted/restored, and accepted by `wfa broker ask`; broker-layer
regression tests in `tests/broker-turn-fields-f1-f4.test.js`.
Download-control selectors are best-effort and UNVERIFIED against the live DOM.

Currently there is no download capability at all: no `Page.setDownloadBehavior`, and the `downloads` field in
turn records is always `null`. Collecting an attachment a provider produced requires clicking the download and
capturing it, with size/hash verification.

*Upload (D3, D4) and download are separate paths; do not merge them.*

### F5 — Claude web adapter (P3)

**Status (2026-11-26): partially done — adapter + full gating wired, awaiting live DOM
verification.** `src/browser/adapters/claude.js` implements the provider interface
(login probe, answer/read state, filename-verified attach, download hook, delete hook)
and is registered in engine, CLI, broker turn validation, turn store, conversation
store and read path (coordinator wiring). All Claude selectors are UNVERIFIED against
the live Claude DOM. Fan-out stays `chatgpt,gemini` for now. **Fix round:** code-level
review only — all 14 shared adapter exports present with correct shapes, no D3-style
free-variable bug, registration complete in all 14 places; no conformance fix was
needed. One flag for the live run: `editorSelector = 'div[contenteditable="true"]'` is
extremely broad and may match a non-composer node — only a live DOM inspection can pick
the right hook.

Login flow plus a DOM adapter, following the existing provider adapter interface.

### F6 — human-like pacing (P3)

**Status (2026-11-26): done in code, awaiting a live timing check.** Pacer/stagger/
cooldown are configurable (`resolvePaceConfig`, `resolveStaggerConfig`,
`resolveMinIntervalMs`; defaults unchanged 1–2 s per action, 4–6 s per batch) and the
config is threaded: `pace` in `DEFAULT_CONFIG`, validated in `loadConfig`, loaded by
the broker starter and passed to `runCdpTurn` via `deps.config`
(`src/engines/cdp-engine.js`). `WFA_NO_PACE=1` still disables pacing.

Configurable delays between actions (1–2 s per action, 4–6 s per batch, randomised) to reduce the chance of
rate limiting.

### F7 — clean up conversations created by a run (P3)

**Status (2026-11-26): done — explicit trigger implemented.** The store records
`createdByRun`/`createdRunId` and `cleanupCreatedConversations` deletes exactly
that set (never pre-existing; idempotent; dry-run/missing-hook report
`wouldDelete`); the engine flags a newly opened conversation at save time
(`src/engines/cdp-engine.js`). The trigger is now the explicit user-invoked
`wfa cdp cleanup` command (`src/engines/cdp-cli.js` → `src/engines/cdp-cleanup.js`,
`--provider`/`--conversation-id`/`--run-id`/`--dry-run`/`--json`); a dry run
lists `wouldDelete` without opening a browser, a real run opens Chrome once
only when there is something to delete. No automatic post-run deletion is
wired anywhere. Live-browser verification still outstanding. A run that opens
a conversation but does not complete records no flag; its URL stays on the
turn record.

Delete only the conversations this tool created, never pre-existing ones. Requires the adapter to track the
conversation it opened.

### F8 — GitHub read failure fallback (P3)

**Status (2026-11-26): done — CDP path wired; ask-bridge unchanged.**
`classifyProviderError` detects `REPO_UNREADABLE` (sentinel before
the completed-response guard), `selectRepoFallbackTransport` prefers attached archive
over inline bundle, `decideRepoFallback`/`recordRepoFallback` (`src/repo-fallback.js`)
produce a deterministic follow-up turn (new request id, bundled input, never the
original prompt). The CDP path now calls them: `wfa cdp ask` (`src/engines/cdp-cli.js`
→ `src/engines/cdp-repo-fallback.js`) detects the sentinel on the completed turn
and submits exactly one follow-up turn through the broker (same conversation,
new request id, attached archive or inline bundle). The broker POST /turns
allowlist now forwards `files` (`src/broker/server.js`, `src/broker/turns.js`) so
the attached archive actually reaches the runner. The ask-bridge path still only records
the manual command. Live-run validation still outstanding.

When a provider cannot read the referenced repository, fall back to an inline source bundle or an attached
archive automatically instead of returning `REPO_UNREADABLE` and stopping.

### F9 — Skill slimming (P3)

**Status (2026-11-26): done.** `skills/web-first/SKILL.md` 41 → 32 lines: state table
10 rows → 5 grouped rows, `wfa send` paragraph folded into the command line, added the
missing never-write-generated-code-into-repo rule, pointer to `README.md` /
`wfa cdp --help` instead of inlined reference. Every command/state was verified
against the real CLI. Note (pre-existing, outside this change): `README.md:27` still
says code is written via `wfa apply --confirm`, but `wfa apply` is in the
`LEGACY_REMOVED` set in `src/cli.js`.

The packaged Skill carries a large instruction document. Reduce it to what changes behaviour, and stop the agent
from over-thinking when the user explicitly names `wfa`.

---

## Out of scope

- Adding an MCP server or a Codex compatibility layer.
- Copying or vendoring ask-bridge browser-control code.
- Adding a second browser automation engine.
- Auto-resending an uncertain prompt.
- Writing provider-generated code directly into a user's repository without an explicit apply step.

## Related documents

- [`known-issues.md`](known-issues.md) — upstream ask-bridge defects (U1–U19) with wfa-side workarounds.
- [`UPSTREAM.md`](UPSTREAM.md) — reviewed ask-bridge commit and interface contract.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — scope, test expectations, upstream change procedure.
