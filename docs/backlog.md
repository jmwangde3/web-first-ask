# Backlog — open defects and planned work

> **Verification results live on their own branches.** `main` stays the shared defect catalogue.
> Live results are recorded on the branch that produced them — `muse` (D1–D9 / F1–F9 fix round)
> and `neon` (Batch 1 + Batch 2 patch bundle) — so the three branches never overwrite each other.

This is the **wfa-side** list: defects in the native CDP engine (`wfa cdp`), the broker (`wfa broker`) and the
provider adapters. Upstream ask-bridge defects (U1–U19) live in [`known-issues.md`](known-issues.md).

State of `main` when this list was updated: `3e12485` (implementation & verification tracked on branch `neon`,
538+ tests on Node.js >= 22.15, zero runtime dependencies).

## Status summary (2026-11-26, branch `neon`)

| ID | Summary | Status on `neon` | Notes |
|---|---|---|---|
| **D1** | `--no-wait` broker idle exit | **Live pass** | Broker stays alive past idle window; `read --task-id` returns `completed` |
| **D2** | First read after reopen returns `unconfirmed` | **Live pass** | Bounded hydration poll; first read returns `completed` in ~3.1 s |
| **D3** | Attachment upload false positive | **Live pass (CDP) / fixed (broker)** | Fixed 0-height wrapper false positive, broker `POST /turns` `files` drop, `broker ask --file`, and full upload diagnostics |
| **D4** | Long answer truncated to first line | **Live pass** | Gemini `div.collapsible-content-wrapper` `textContent` fallback; 15,866 / 15,866 exact readback |
| **D5** | Gemini background multi-minute pause | **Root cause merged into D4; needs >=5 runs** | Previous 420 s stalls were D4 collapsed `innerText` misreads; added stale-pending fallback; single run 35.4 s with 0 pauses |
| **D6** | Continuation `composer_stop_state` | **Not reproduced; diagnostics added** | Preserves G1 R2 gate and captures `stopDiagnostics` if it recurs |
| **D7** | Cloudflare / Google `/sorry` interstitial | **Unit pass + `/sorry` fast-fail live** | Parks tab to `about:blank`; `/sorry` fast-failed at 3.6 s |
| **D8** | Background tab hang / focus steal | **Live pass** | `Emulation.setFocusEmulationEnabled` + activate fallback; 1.9 s read, foreground unchanged |
| **D9** | Gemini ignores reused `--conversation-id` | **Closed (not reproduced)** | Verified twice (`live-d9-test-1`, `d9-neon-2601`): `userTurns` 1→2 on same URL |
| **D10** | `--restore-last-session` triggers `/sorry` | **Live pass (resolved)** | Flag removed; ChatGPT & Google persistent cookies survive normal close and `taskkill /F /T` with 0 restored tabs |
| **F1** | Gemini Task mode over CDP | **Live pass** | Segmented button toggle + Task ACK confirmation; new Gemini sessions default to `task` |
| **F2** | Concurrent multi-provider runs | **Live pass** | `--providers chatgpt,gemini` (and default when `--provider` omitted) writes separate artifacts |
| **F3** | Extract `FILE:` blocks with integrity check | **Live pass** | `wfa cdp extract` writes verified files and rejects unclosed fences / bad diff hunks |
| **F4** | Download provider-produced attachments | **Unit pass; live pending** | `--download-dir` + download link trigger + CDP capture & SHA-256 |
| **F5** | Claude web adapter | **Unit pass; live pending** | `src/browser/adapters/claude.js` wired; profile currently has 0 `claude.ai` cookies |
| **F6** | Configurable human-like pacing | **Unit pass; live pending** | `pacer.js` configurable 1–2 s casual / 4–6 s batch jitter |
| **F7** | Clean up `wfa`-created conversations | **Live pass** | `wfa cdp cleanup` (`--task-id` / `--all` / `--keep-unfinished` / `--keep-named`); one-shot asks auto-clean on `completed` |
| **F8** | `REPO_UNREADABLE` auto-fallback | **Unit pass; live pending** | `--fallback-bundle` wired in `cdp-cli.js` (terminal `completed` only); `--code-task` attaches repo bundle upfront |
| **F9** | Skill slimming | **Static pass** | `skills/web-first/SKILL.md` slimmed; includes #10 Q&A rule and mandatory code-bundle contract |

## Verified provider sandbox capabilities (2026-11-26)

| Provider / mode | GitHub access | Verified sandbox runtime | Code modification & test capability |
|---|---|---|---|
| **ChatGPT Web** | GitHub API reads files/trees at a commit; **cannot `git clone`** (container cannot resolve `github.com`, forced IP also fails) | Git `2.47.3`, Node `22.16.0`, npm `10.9.2` | Given a `git bundle` or `.git` zip, can clone locally, run `git apply --check` / `--stat`, and run full `npm test` |
| **Gemini Chat** | **Cannot read GitHub** | Python `3.10` only (no `node`, `npm`, `git`, or `patch`) | Can unzip source archive, edit code, and emit `diff -u` patches; **cannot run `npm test`** |
| **Gemini Task** | **Pro accounts can `git clone`**; Free accounts cannot | Node `18.20.4`, npm `9.2.0` (no internet for installing deps) | Can run offline checks in sandbox (note Node 18 vs `>=22.15` engine requirement) |

**Default code-task rule:** for any task that modifies code, pass a repository bundle (`git bundle` or `.git` zip,
e.g. `wfa cdp ask --code-task`) and explicitly instruct the provider to run `git apply --check` and full `npm test`.

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

**Status (2026-11-26).** Closed (not reproduced). Controlled two-ask runs with the same local key
(`live-d9-test-1` and `d9-neon-2601`) on Gemini both stayed on the same `conversationUrl`, incremented
`userTurns` 1→2, and recalled the round-1 token accurately (matching ChatGPT).

---

### D10 — Chrome launch restores every historical tab and can trigger Google `/sorry` (P1, 2026-11-26)

**Symptom.** Every Chrome launch passes `--restore-last-session` (`src/browser/launch.js:66`). On this machine
one launch restored **19 tabs, 9 of them Gemini**, all loading concurrently. Immediately afterwards every new
Gemini navigation — the landing page and a concrete `/app/<id>` conversation — was redirected to
`https://www.google.com/sorry/…`, blocking live testing until Google's risk control cleared.

**Status (2026-11-26 17:10).** The premise for the switch — that ChatGPT's non-persistent `oai-asli` cookie
would be dropped without it — was tested and disproven on this profile. After a normal exit and again after
`taskkill /F`, relaunching **without** `--restore-last-session` kept ChatGPT signed in
(`__Secure-next-auth.session-token.0/.1`, persistent, expiry 2027-02-24; `oai-asli` count 0) and Gemini signed
in; no historical tabs were restored. Evidence:
`reverdict/live-tests/20261126-1657-no-restore-session/REPORT.md`.

**Why it matters.** There is no supported opt-out: the switch is hardcoded, `config.json` has no browser-args
key, and `tests/cdp-cli.test.js:1081` asserts the flag in every mode. Clearing `Default/Sessions/*` before a
launch did **not** prevent the restore in practice (cleared at 15:22, the next launch at 15:24 still restored
19 tabs), so the documented workaround is unreliable. `README.md:378-388` explains why the switch exists
(ChatGPT cookie), but not this cost.

**Impact.** Any Chrome restart can burn tens of minutes of Gemini quota and invalidate live runs; repeated
broker restarts amplify it.

**Evidence (2026-11-26).** `Default/Sessions/*` cleared at 15:22; the 15:24 launch still restored 19 tabs (9
Gemini). `ask` runs at 15:25:5x and 15:30:5x and read-only probes at 15:31 were all redirected to `/sorry` —
landing page and `/app/ceeb4b6cc5ca503d` alike. Run record:
`reverdict/live-tests/20261126-1520-neon-hotfix/REPORT.md`.

**Resolution on `neon` (2026-11-26).** Removed `--restore-last-session` from `src/browser/launch.js`. Live checks
after both clean `Browser.close` and `taskkill /F /T` confirmed persistent cookies keep ChatGPT and Gemini signed
in while restoring zero historical tabs.

---

### D11 — `wfa cdp cleanup` opens one new tab per conversation (P1, 2026-11-26)

**Symptom.** Bulk cleanup of wfa-created conversations opens a fresh tab for every URL
(`handleCleanup` → `driver.openTab(cdp, targetUrl)`), evaluates the delete script, then closes it. Deleting N
conversations therefore creates N transient tabs. That is not how a real user deletes chats, and it produces a
large number of useless tabs while the batch runs.

**Expected.** A bulk mode should open one provider tab (conversation list / sidebar) and perform the deletions
sequentially inside that same tab, with randomized 4–6 s spacing between actions and a longer pause between
batches. It must still delete only conversations created by wfa (`createdByWfa === true`) and never touch
pre-existing chats.

**Code fact (2026-11-26).** `src/engines/cdp-cli.js` `handleCleanup` supports only `--task-id` or `--url`; there is
no batch/`--all` mode. The F7 status row above and the Skill line mention `--all` / `--keep-unfinished` /
`--keep-named`, but those flags are not implemented in the current `neon` tree — verify before relying on them.

**Evidence.** Live cleanup test on 2026-11-26: each `wfa cdp cleanup --url ...` opened a new tab, returned
`status=attempted`, and the conversation was gone afterwards (read-back `userTurns=0`). Candidate list for a full
cleanup: 109 Gemini + 113 ChatGPT wfa conversations.
`reverdict/live-tests/20261126-cleanup-batch1/` (candidate list, pacing script, logs).

---

### D12 — `wfa cdp login` off-origin redirect interrupts manual login (P2, 2026-11-26)

**Symptom.** `wfa cdp login` opens the provider URL and polls. If the tab stays off the provider origin (for
example Google's sign-in or 2FA pages) for 45 seconds, the command navigates it back to the provider URL
(`Page.navigate`), up to two times. A human login can easily take longer than 45 seconds (password manager, 2FA,
phone approval), so the redirect destroys an in-progress login.

**Expected.** Manual/interactive login must never be interrupted. The redirect should be opt-in (for example
`--recover-off-origin`), or only fire after a much longer idle window (5–10 minutes) with no page changes, and it
must not fire while a sign-in / 2FA form is present. The default should be to leave the tab alone.

**Code fact (2026-11-26).** `src/engines/cdp-cli.js` `handleLogin`: `offOriginThresholdMs` defaults to 45 s and
calls `Page.navigate` back to the provider URL, max 2 attempts. The behavior is codified in
`tests/cdp-cli.test.js` ("off-origin ticks ..."), so a fix must update that test. There is no CLI flag to disable it.

**Evidence.** Manual login attempt on 2026-11-26: the command was interrupted while the user was signing in; the
45 s redirect path is the designed behavior. A separate issue (the command closing the Chrome it launched on exit)
is not covered by this item.

---

### D13 — Windows concurrent lock publication fails with `fs.rename` `EPERM (-4048)` (P1, 2026-11-27)

**Symptom.** Under 8-way concurrent contention (`tests/instance-lock-stale.test.js` and `tests/broker.test.js`),
`fs.rename('.../*.lock.ready', '.../*.lock')` in `src/broker/turn-lock.js` (and `broker.lock` overwrite-rename in
`src/broker/lifecycle.js`) intermittently fails on Windows with `EPERM (-4048)`. Changing `TEMP`/`TMP` drive
does not eliminate the failure.

**Expected.** Concurrent lock acquisition on Windows must preserve strict single-owner exclusivity and atomic
complete JSON publication without intermittent `EPERM` failures, without ignoring `EPERM`, without unbounded
retries, and without global serialization.

**Code fact (2026-11-27).** `src/broker/turn-lock.js` creates an empty `.lock` placeholder and then overwrites
it via `fs.rename(readyPath, lockPath)` while competing contenders poll `fs.readFile(lockPath)`. On Windows
NTFS, overwriting an existing file that another handle or scanner has open returns `EPERM`. `src/broker/lifecycle.js`
similarly overwrites `broker.lock` via `fs.rename(temp, lockPath)` while unguarded optimistic reads occur.

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

### F10 — Humanized keystroke timing & curved mouse trajectories (P3, deferred)

Add optional human-like per-keystroke timing distributions (hold duration / rollover) for short inputs and curved
mouse trajectories (Fitts' law / Bezier path) before CDP clicks. Deferred as lower priority than randomized
CDP mouse clicks, isolated-world evaluation, and inter-batch pacing.

### F11 — Default-ON debug issue logging & repro-only Skill rule (P2)

Enable a default-ON debug mode (opt-out via CLI flag or env var) that records failed `wfa` commands with bounded
log size/rotation and provides a command for local agents to append reproduction steps. Update the Skill so
local agents only record how to reproduce `wfa` issues and never modify or fix `wfa` itself.

### F12 — Bilingual EN/ZH web UI support for ChatGPT and Gemini (P2)

Ensure all core interactions on ChatGPT and Gemini (send, stop, readback, file upload, Gemini Chat/Task mode
switching, login detection, and conversation deletion) work consistently on both English and Chinese web UIs.

### F13 — Stealth & humanization hardening (P2)

Reduce automation detection surface while keeping `background` mode non-intrusive: auto-detect host timezone
(skip timezone override when host is already `Asia/Tokyo`), subtract unnecessary Chrome launch flags, use
trusted CDP mouse clicks with randomized target points, evaluate DOM probes in isolated worlds where possible,
and add randomized inter-batch long pauses for bulk operations.

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
