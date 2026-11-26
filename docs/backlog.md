# Backlog — open defects and planned work

This is the **wfa-side** list: defects in the native CDP engine (`wfa cdp`), the broker (`wfa broker`) and the
provider adapters. Upstream ask-bridge defects (U1–U19) live in [`known-issues.md`](known-issues.md).

State of `main` when this list was written: `f3d104e`, `npm test` = **503 tests, 503 pass**, Node.js >= 22.15,
zero runtime dependencies.

Everything below was reproduced on a real Chrome with logged-in ChatGPT and Gemini accounts unless marked
otherwise. Items marked *(unverified)* were reported but not re-confirmed with a controlled experiment.

## Branch verification — `neon` (Batch 1 + Batch 2 patch bundle)

This file is the `neon` branch's copy: only results produced on this branch are recorded here.
The shared defect catalogue lives on `main`; the `muse` fix round records its own results in its own copy.

### Live verification of the Batch 1 + Batch 2 patch bundle (branch `neon`)

The patch bundle (`01-batch1-d4-d3-d1-d2.patch` + `02-batch2-d8-d7-f1.patch`, baseline `4001f14`) was applied
on a fresh local branch `neon` as two commits — `6457aa3` (D4/D3/D1/D2) and `8fdb215` (D8/D7/F1).
`npm run check` green, `npm test` = **514/514** (11 new tests included).

| Item | Live result | Notes |
|---|---|---|
| D1 | **pass** | after `--no-wait`, the broker pid was unchanged at t+35 s and `read --task-id` returned `completed` ("M" / "K") in two independent runs. The baseline returned `BROKER_UNREACHABLE(committed, safeToResend=false)`. |
| D3 | **fail (new root cause)** | `--file` is dropped at the broker boundary — see "Broker drops `files`" below. The chip verification added by this patch is fine; it is simply never reached. |
| D4 | **pass** | 49.8 s, 17,688 chars, complete head-to-tail; DOM `innerText` 17,676 chars (0.07% delta); no 420 s `stalled`. Baseline returned a 25-char title line and stalled. |
| F1 | **fail (arg parsing)** | `--gemini-mode task` becomes boolean `true` because `gemini-mode` is missing from `VALUE_FLAGS`; the CLI throws `INVALID_ARGUMENT` before any broker call. |
| D2 / D7 / D8 | not run on `neon` | unit-tested only in this round. |

### Broker drops `files` on `POST /turns` (P1, D3's real root cause)

`wfa cdp ask --file <path>` never attaches anything when the turn goes through the broker:

| Location | Behaviour |
|---|---|
| `src/engines/cdp-cli.js:543-545` | expands attachments correctly (`expandAttachmentInputs` returns the 421,605 B zip) |
| `src/engines/cdp-cli.js:628` | puts them in the HTTP body: `{ files: attachedFiles }` |
| `src/broker/server.js:303-315` | `createTurn({...})` copies an allowlist of fields — **no `files`** |
| `src/broker/turns.js:24-61` | `createTurn` neither accepts nor returns `files` |
| `src/broker/runner.js:209` | reads `turn?.files` — always `undefined` |

Consequence: `cdp-engine.js:551` (`files.length > 0`) is always false, `attachFiles` is never called, and the
prompt is submitted bare. Three live runs (background, background+`--no-wait`, visible) all ended with Gemini
answering "there is no attached zip" and **no** `ATTACH_UPLOAD_FAILED`.

This also corrects the earlier G4/D3 attribution: an isolated probe that calls the same adapter code
(`buildUploadJs` + `DOM.setFileInputFiles` + `buildAttachmentVerifyJs`) on the same page shows the real chip at
4.9 s (`uploader-file-preview.file-preview-chip`, 112x112, text `d3-probe.zip`) and `present=true`. The adapter is
healthy; the transport is not.

Fix: move `files` through `server.js` → `turns.js` (with absolute-path and size/count validation) and add a broker
test asserting `runCdpTurn` receives the array.

### `--gemini-mode` missing from `VALUE_FLAGS` (P1, F1's root cause)

`src/engines/cdp-cli.js` defines its own `VALUE_FLAGS` set (line 24) and `gemini-mode` is absent from it, so
`--gemini-mode task` is parsed as a boolean flag and `task` becomes a positional argument. The validation added in
this patch then rejects `true`:

```text
wfa: INVALID_ARGUMENT: Invalid --gemini-mode: true. Must be chat or task.
```

The page itself is ready — the probe read `[{"txt":"Chat","pressed":"true"},{"txt":"Task","pressed":"false"}]` and
placeholder `Ask Gemini`, so once the flag is parsed the mode switch can be verified.

Fix: add `"gemini-mode"` to `VALUE_FLAGS`; add a parser-level test (current tests cover `createTurn`/engine but not
argument parsing); audit other documented flags (`--download-dir`, `--providers`) for the same omission.

### Google bot-check interstitial during this round (03:39–12:5x, resolved)

From 2026-11-26 03:39 (UTC+8) every Gemini tab in the wfa Chrome profile was redirected to
`https://www.google.com/sorry/index?continue=https://gemini.google.com/app&q=…` — 9 of 9 existing tabs and a
freshly opened tab alike. The `/sorry` page has no editor, so `waitForEditor` (bounded by `hardTimeoutMs`) waits
until the CLI timeout; this explains the two 240 s / 122 s timeouts with `sendCommittedAt: null` recorded earlier
in the day. The interstitial cleared by 12:49 and all four items above were then re-run successfully.

Timeline: on 11-25 18:00–22:00 Gemini produced text normally but stalled mid-answer; after 22:00 the CLI began
timing out; on 11-26 03:39 the hard interstitial appeared. **The D5 result above (5/5 background runs stalled
after 38–52 s) sits inside that same window and may be compounded by provider throttling. Re-measure at least one
visible + two background runs before changing `stallTimeoutMs`.**


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

**Symptom.** After an answer finishes, the composer can stay in a stop-state for up to ~45 s; a continuation
sent in that window is rejected with `PROMPT_NOT_TYPED` / `composer_stop_state`.

**Current state.** The composer gate only requires *editable + visible + no active stop button*. A continuation
sent on 2026-11-26 succeeded, and the long stop-state did not reproduce. The underlying cause is still unknown.

**Where.** `src/browser/driver.js` composer gate (`ready = editorEditable && editorVisible && !stopActive`).

**What is needed.** A capture from a real occurrence: DOM dump of the stop control, its attributes and how long
it stays. Without that, any change is guesswork.

---

### D7 — Cloudflare interstitial is not parked immediately (P2)

**Symptom.** When a Chrome profile is challenged, `chatgpt.com` serves a `请稍候…` page with an empty body. The
engine reports `human_verification_required`, but the challenged tab is left in place.

**Expected.** Detect the interstitial, switch the tab to `about:blank`, and report the state so a retry does not
inherit the challenged page.

**Where.** `src/browser/driver.js` page-state detection; `src/browser/launch.js`.

*(Good first issue — detection is already implemented elsewhere, this is about parking the tab.)*

---

### D8 — reading a background tab can hang until the tab is activated (P2)

**Symptom.** A background tab can be throttled or frozen by Chrome, so a read hangs or returns stale state
until the tab is activated.

**Expected.** Activate the tab before reading (or use a CDP call that does not require foreground), and keep the
window from stealing focus — the window layer is what is currently unverified.

**Where.** `src/browser/driver.js` read path; `src/browser/launch.js` window placement.

---

### D9 — Gemini may ignore a reused conversation key (P2, unverified)

**Symptom reported earlier:** passing the same conversation identifier on consecutive turns produced a new
conversation each turn instead of continuing the stored one.

**Important context.** `--conversation-id` is a **local key**, not a cloud conversation id. The first use opens
a new conversation and stores its URL; later uses with the *same key* reuse that URL. On ChatGPT this works:
two consecutive `ask` calls with the same key returned `userTurns: 2` and kept the conversation title. The
Gemini case has not been re-tested with this same-key method.

**Next step.** Run the two-ask test against Gemini before treating this as a defect.

---

### D10 — Chrome launch restores every historical tab and can trigger Google `/sorry` (P1, resolved 2026-11-26)

**Symptom.** Every Chrome launch passes `--restore-last-session` (`src/browser/launch.js:66`). On this machine
one launch restored **19 tabs, 9 of them Gemini**, all loading concurrently. Immediately afterwards every new
Gemini navigation — the landing page and a concrete `/app/<id>` conversation — was redirected to
`https://www.google.com/sorry/…`, blocking live testing until Google's risk control cleared.

**Observed on this branch.** 2026-11-26 15:24 the `neon` verification launch restored 19 tabs (9 Gemini);
15:25–15:31 every new Gemini navigation (landing and `/app/ceeb4b6cc5ca503d`) hit `/sorry`. The D7 fast-fail
added by `5676132` fired at 3.6 s and parked the tab.

**Why it matters.** There is no supported opt-out: the switch is hardcoded, `config.json` has no browser-args
key, and `tests/cdp-cli.test.js:1081` asserts the flag in every mode. Clearing `Default/Sessions/*` before a
launch did **not** prevent the restore in practice (cleared at 15:22, the next launch at 15:24 still restored
19 tabs), so the documented workaround is unreliable. `README.md:378-388` explains why the switch exists
(ChatGPT cookie), but not this cost.

**Impact.** Any Chrome restart can burn tens of minutes of Gemini quota and invalidate live runs; repeated
broker restarts amplify it.

**Evidence (2026-11-26).** The 15:24 verification launch restored 19 tabs (9 Gemini); `ask` runs at 15:25:5x and
15:30:5x plus probes at 15:31 were redirected to `/sorry` (landing page and `/app/ceeb4b6cc5ca503d` alike).
`Default/Sessions/*` cleared at 15:22 was followed by that same 19-tab restore. The D7 fast-fail added by
`5676132` fired at 3.6 s and parked the tab. Run record:
`reverdict/live-tests/20261126-1520-neon-hotfix/REPORT.md`.

**Resolution (2026-11-26).** Controlled restarts without `--restore-last-session` across both clean
`Browser.close` (`exit_type=Normal`) and `taskkill /F /T` confirmed that both ChatGPT
(`__Secure-next-auth.session-token.0/.1`, `oai-asli = 0`) and Google
(`SID`/`HSID`/`SSID`/`APISID`/`SAPISID`/`__Secure-1PSID`/`__Secure-3PSID`) persist login via persistent cookies
while restoring zero historical tabs. Removed `--restore-last-session` from `src/browser/launch.js` and updated
`src/engines/cdp-cli.js`, `tests/cdp-cli.test.js`, and `README.md`.

---

## Planned work

### F1 — Gemini "Task" mode over CDP (P1)

The Gemini web UI has a Task mode that runs code in a sandbox with Node.js and `git apply --check`. The CDP path
only ever reaches Chat mode, so the CLI cannot use that capability. The old `gemini-mode` command has been
removed; the CDP path needs the mode toggle in the page plus adapter state for it.

### F2 — concurrent multi-provider runs with per-provider artifacts (P2)

Send the same brief to several providers in parallel, write each answer to its own file, and allow retrying a
single failed provider without touching the others. Must compose with the existing per-provider and global
scheduling limits.

### F3 — extract `FILE:` blocks from answers to disk (P2)

Answers frequently contain complete file contents in fenced blocks. Turn that into files on disk, with an
integrity self-check (block counts, fence pairing, hunk line counts) so a truncated answer cannot be written as
a valid file.

### F4 — download attachments produced by providers (P2)

Currently there is no download capability at all: no `Page.setDownloadBehavior`, and the `downloads` field in
turn records is always `null`. Collecting an attachment a provider produced requires clicking the download and
capturing it, with size/hash verification.

*Upload (D3, D4) and download are separate paths; do not merge them.*

### F5 — Claude web adapter (P3)

Login flow plus a DOM adapter, following the existing provider adapter interface.

### F6 — human-like pacing (P3)

Configurable delays between actions (1–2 s per action, 4–6 s per batch, randomised) to reduce the chance of
rate limiting.

### F7 — clean up conversations created by a run (P3)

Delete only the conversations this tool created, never pre-existing ones. Requires the adapter to track the
conversation it opened.

### F8 — GitHub read failure fallback (P3)

When a provider cannot read the referenced repository, fall back to an inline source bundle or an attached
archive automatically instead of returning `REPO_UNREADABLE` and stopping.

### F9 — Skill slimming (P3)

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
