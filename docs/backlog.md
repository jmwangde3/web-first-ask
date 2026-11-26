# Backlog — open defects and planned work

This is the **wfa-side** list: defects in the native CDP engine (`wfa cdp`), the broker (`wfa broker`) and the
provider adapters. Upstream ask-bridge defects (U1–U19) live in [`known-issues.md`](known-issues.md).

State of `main` when this list was written: `f3d104e`, `npm test` = **503 tests, 503 pass**, Node.js >= 22.15,
zero runtime dependencies.

Implementation status (2026-11-26, branch `backlog/d1-f9`, HEAD `4001f14`, package 1.2.0):
`npm test` = **657 tests, 655 pass, 1 fail (pre-existing Linux-only `cdp-stage.test.js:107`), 1 skipped**;
`npm run check` green. No live-browser validation was run on this VM (no logged-in
Chrome here) — every item that needs a real browser is marked **awaiting live verification**
below, with the manual command to run on Windows. Per-item status lines were added under
each heading; nothing else in this file was rewritten.

Everything below was reproduced on a real Chrome with logged-in ChatGPT and Gemini accounts unless marked
otherwise. Items marked *(unverified)* were reported but not re-confirmed with a controlled experiment.

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

**Status (2026-11-26): done in code, awaiting live verification.** After `openTab` the
read polls until message nodes appear (bounded 10 s, injectable clock, no fixed sleep);
a genuinely empty conversation still returns `unconfirmed` (`src/engines/cdp-read.js`).

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
(`src/broker/turns.js` accepts `geminiMode`, runner forwards it). Selectors are
UNVERIFIED against the current Gemini DOM.

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
the live Claude DOM. Fan-out stays `chatgpt,gemini` for now.

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
the attached archive actually reaches the runner — `geminiMode`/`downloadDir`
are still dropped (F1/F4, unchanged). The ask-bridge path still only records
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
