# Changelog

## 1.2.0 - Unreleased (backlog/d1-f9-live-verify)

Backlog D1–D9 / F1–F9 (`docs/backlog.md`). No live-browser validation was run
for this branch — every item that needs a real Chrome is marked awaiting live
verification in the backlog, with the manual command to run on Windows.
`npm test`: 709 tests, 707 pass, 1 fail (pre-existing Linux-only
`cdp-stage.test.js:107`), 1 skipped. Zero runtime dependencies, unchanged.

Fix round (branch acceptance REPORT-7b9e1ceb.md, 2026-11-26 — all code-done,
awaiting Windows re-verification):

- D2: the `attachTab` branch now also enters the settle, and settle completion
  requires non-empty `answerText` (not just any message node); empty
  conversations still return `unconfirmed` after the 10 s bound.
- D3: attachment is re-verified at submit time (fail-closed `ATTACH_UPLOAD_FAILED`,
  no submission) and confirmed post-submit by filename in the newest user turn
  (failure after submit is `SUBMITTED_WITH_UNVERIFIED_ATTACHMENT`, never a
  silent timeout); filename verification unchanged.
- D5: 420 s is now a stall-classification boundary, not a stall declaration
  (`src/stall-alive.js`): a paused-but-alive turn (page responsive,
  `pendingCount > 0`) keeps waiting under a 600 s continued-wait budget capped
  by the hard timeout; a dead turn still stalls. Decisions are recorded in the
  pause log and turn evidence. Cannot distinguish server throttling from
  background throttling — only the recorded decisions can.
- F1/F4: `POST /turns` now passes `geminiMode` and `downloadDir` through
  (they were silently dropped, so `--gemini-mode task` ran as Chat and
  `--download-dir` never captured); also accepted by `wfa broker ask`,
  persisted/restored, and included in the request hash.
- F7: explicit `wfa cdp cleanup` command (`--provider`/`--conversation-id`/
  `--run-id`/`--dry-run`/`--json`); deletes only created-by-run conversations,
  idempotent; no automatic post-run deletion wired.
- F8: the CDP path now detects `REPO_UNREADABLE` and submits exactly one
  fallback follow-up turn (new request id, bundled input, never the original
  prompt); broker `POST /turns` now also forwards `files` so the attached
  archive reaches the runner.
- Side findings: EPIPE guard on broker stdout/stderr; 409 idempotency now
  scoped by `conversationId` (unknown/legacy records stay conservative);
  `cdp status` verifies broker-record liveness and reports dead records as
  `alive: false`. F5: code review only — no conformance bugs found; all
  Claude selectors still unverified.

First round:

- D1: broker no longer idles out while it owns a non-terminal turn
  (`hasNonTerminalTurn` + idle grace in `src/broker/server.js`).
- D2: first read after reopening a tab polls until message nodes appear
  (bounded 10 s, no fixed sleep); empty conversations still `unconfirmed`.
- D3: Gemini attachment verification now checks the filename (it previously
  threw `ReferenceError` in-page and could match the attach button);
  fail-closed with `ATTACH_UPLOAD_FAILED`, no submission.
- D4: `pending > 0` blocks `completed`; a `completed` candidate needs a
  second identical sample; every read result carries `partial: true/false`.
- D5: pause-measurement harness (`src/stall-measurement.js`,
  `scripts/summarize-pauses.mjs`), wired into the completion poll loop
  (opt-in via `WFA_PAUSE_EVENTS_DIR`); 420 s stall default kept
  provisionally pending distribution data.
- D6: composer stop-state capture (`src/browser/composer-capture.js`) wired
  at the composer-gate and `PROMPT_NOT_TYPED` call sites; gate unchanged.
- D7: Cloudflare interstitial tabs are parked to `about:blank` and reported
  (`parkChallengedTab`).
- D8: background tabs are activated (`Target.activateTarget`, not
  `Page.bringToFront`) before reading; window focus behaviour unverified.
- D9: two-ask Gemini conversation-reuse test procedure + harness
  (`docs/gemini-conversation-reuse-test.md`,
  `scripts/gemini-conversation-reuse.mjs`); no code changed.
- F1: Gemini Task mode over CDP (`--gemini-mode chat|task`, adapter toggle
  + turn state, fail-closed `GEMINI_MODE_FAILED`); selectors unverified.
- F2: `wfa cdp ask --providers chatgpt,gemini` fan-out with per-provider
  artifacts and single-provider retry (`--retry-provider`); 1 in-flight
  per provider, at most 2 across providers.
- F3: `FILE:` block extraction with integrity self-check
  (`src/stage.js`) + `wfa cdp extract` CLI; truncated answers refused.
- F4: provider-download capture (`src/browser/downloads.js`, size + SHA-256
  verified) via `wfa cdp ask --download-dir <dir>`, recorded as
  `downloads[]` on the turn.
- F5: Claude web adapter (`src/browser/adapters/claude.js`) registered
  end-to-end (engine, CLI, broker, turn store, conversation store, read);
  selectors unverified against the live Claude DOM.
- F6: configurable human-like pacing (`pace` in `DEFAULT_CONFIG` /
  `loadConfig`, broker starter passes `deps.config`).
- F7: created-by-run conversation tracking (`createdByRun`/`createdRunId`)
  + store-level cleanup of exactly that set; trigger decided in the fix
  round — explicit `wfa cdp cleanup` command, no auto-delete.
- F8: `REPO_UNREADABLE` classification + fallback decision/record
  (`src/repo-fallback.js`, archive preferred); automatic submit wired in
  the fix round (CDP path only).
- F9: packaged Skill slimmed 41 → 32 lines.

## 1.0.0 - Unreleased

First stable release. The native CDP engine (`wfa cdp`) and its front-end queue
(`wfa broker`) are now the default browser path, with `ask-bridge` retained only
as a legacy fallback for `wfa ask` / `code` / `compare`. This release hardens the
CDP turn lifecycle end to end:

- Prompt typing selects and replaces existing draft content with read-back
  validation (`PROMPT_NOT_TYPED`); sends go through scoped `sendSelector` clicks
  with single-fire semantics (`SEND_BUTTON_*`, `SEND_UNCONFIRMED`), no Enter
  fallback and no automatic retry.
- Page-level rate limit / provider errors fast-fail with an `answerTurns`-guarded
  check; a per-provider cooldown (`last-turn.json`, cross-process lock) is
  enforced by both `cdp ask` and `broker`, with `--min-interval`.
- `waitForCompletion` adds `unresolvedGraceMs` so fast short answers are not
  falsely failed by an empty first read, with a second confirmation before
  `MESSAGE_SELECTOR_UNRESOLVED`.
- Broker journals committed prompts; a broker that dies after send reports its
  turn as orphaned and refuses a blind resend with 409
  `previously_submitted_uncertain`, surfaced clearly by the CLI in text and JSON.
- Send selectors aligned to current ChatGPT/Gemini DOM. 364 tests pass.

## 0.2.10 - Unreleased

0.2.9 fixed `--detach` locking the workspace by treating two empty batch logs as
"nothing was ever submitted". That judgement was backwards on the default path:
`wfa ask` runs a serial worker, the worker captures ask-bridge with
`inherit: false`, and `batch.stdout.log` stays at zero bytes for the whole run
even after the prompt reached a page. A worker killed after submission was then
declared safe to resend.

### Fixed
- `failed_before_start` now requires the absence of every submission artifact
  (`metadata.json`, `threadUrl`, `resultPath`, `completionProof`), not just
  empty logs. Any artifact leaves the job `interrupted_unknown`, which keeps the
  workspace locked until `wfa resolve`.
- A trusted `completed` result can correct an earlier `failed_before_start`, so
  a response that lands after the worker died is still collected.
- The detached serial worker forwards provider output and the `still waiting`
  heartbeat to its own stdout, so detached batch logs are no longer always
  empty and U17's heartbeat also works under `--detach`.

### Changed
- Gemini Task is pressed even when the composer already holds text. The switch
  is page state and keeps the composer content until something is submitted, so
  the click is safe; the report records `typedBeforeClick` and `wfa status`
  prints the count as a timing observation, not a failure.
- Gemini page matching accepts `/app/`, `/app/<id>`, `/u/<n>/app` and their
  query forms. `handled` is recorded only after the switch reports pressed, a
  failed page is retried up to three times, every CDP command has a 5 s timeout,
  and a closed socket rejects all pending commands instead of hanging.
- `defaultCompareProviders` matches `defaultProviders` (`gemini, chatgpt`).
- Attachment-refusal detection also matches "cannot read/access/open the
  uploaded file". Code results that admit the attachment was unreadable are
  refused at stage/apply when the task had attachments.
- `managed-runner.js`, `policy-store.js` and `stall-watch.js` are gone. Their
  behaviour now lives in `runner-orchestration.js`, `runner-stall.js` and
  `runner-retry.js`: one public `executeTask`, one place that decides what a
  child state means (`state.js`), and the follow-up authorisation passed
  explicitly instead of through a `Store` subclass that rewrote parents inside
  every transaction. Deleting them had removed three post-write checks, which
  are restored: a foreground run now ends with `refreshTask`, so
  `REPO_UNREADABLE`, stall promotion and session rollback apply before the CLI
  returns; a `guardedBatch` stall is saved as `stalled` instead of being
  overwritten by the `in_progress` metadata; and a serial batch that may still be
  alive leaves the untouched provider `interrupted_unknown` rather than
  `failed_before_start`.
- `request_id` identity is the request, not its packaging: the intent hash no
  longer includes the session policy or the scratch path of a temporary archive,
  so a replay with `--continue-session` or a re-packed repository recovers the
  original task instead of returning `IDEMPOTENCY_CONFLICT`.
- Repository archives keep the 20-character stem limit but add a random half, so
  two archives of the same tree no longer overwrite each other; a caller that
  supplies `request_id` still gets a deterministic name and can replay.

### Added
- **The delegation rule is now written into the Skill and README as a hard
  rule.** Every code problem — bug, failing test, refactor, feature, review —
  goes to `wfa` with both providers and comes back as complete files or an exact
  patch. The local agent integrates the patch, runs the tests and reports; it
  does not diagnose first and does not type the fix itself. The only exception
  is an explicit user instruction that the request must not use agents.

### Optimization review of 2026-11-22

Three request batches from the external review were each answered by the
gemini/chatgpt pair and integrated here; the local agent only applied, tested
and committed the returned files.

- Gemini Task failures now name a reason: the click window records its last
  failure, an exhausted page replays it, and `stop()` falls back to the page URL
  it actually visited, so `NOT applied` is no longer bare.
- `--limit` rejects non-integers and non-positive values instead of returning an
  empty list; `status`/`list` print `killedStalledPids` when a read command
  terminated a stalled child.
- `stall-watch` re-parses `metadata.json` only when its mtime changes; job
  metadata is read once per pass; Chrome profile discovery is cached and the
  cache is invalidated on login. The metadata cache keys on mtime, size and inode
  and is dropped when the file disappears, so a terminal rewrite that lands on
  the same mtime (common on Windows) is still seen.
- Attachment hashes are computed once per pass, repository bundling appends
  bytes instead of re-encoding, and archive deflate drops to level 6 while still
  storing incompressible entries.
- Gemini polls `/json/list` every 500 ms and rechecks the model switch every
  150 ms, both bounded by the remaining click window.
- Captured stdout/stderr keep the newest bytes instead of the oldest.
- Attachment globs compile once per request and share one `stat`; the sensitive
  scan walks the shared prompt once and each provider delta separately, keeping
  per-provider sources and line numbers.
- Inline bundles, ZIP archives and attachments take their skip/sensitive/extension
  lists from one module (`repo-select.js`), so the three copies can no longer
  drift. Core entry points come from the repository's own `package.json`
  (`bin`, `main`, `exports`, `scripts`) instead of a hard-coded list of wfa files.
- Git helpers share `GIT_TIMEOUT_MS`/`GIT_MAX_BUFFER`; native `Error`s keep their
  message through the CLI exit path (`errors.js`, `util.js`), and the unused
  `assert`/`getDefaultConfigPath` helpers are gone.
- `README.md` states the real 900 s default and the actual
  `failed_before_start` condition; `skills/web-first/SKILL.md` carries a version
  stamp.

## 0.2.9 - 2026-11-22

Two earlier conclusions in `docs/known-issues.md` were wrong, and one of them was
wrong in a way that stayed invisible: ask-bridge decides whether an attachment
arrived by searching the page text for the **whole filename**, so a name longer
than the provider's label truncation is uploaded, then reported as never
attached about 50 s later. That is not a parser timeout, and it is not specific
to documents: the same archive succeeded as `bundle.zip` and failed as a
50-character timestamped name. Our own archive names were in the failing range,
which meant `--bundle-repo=zip` never worked on Gemini without saying so.

### Added
- `wfa gemini-mode [chat|task]` and `--gemini-mode` reach Gemini's Chat/Task
  switch. It is page state — not in the URL, not in `localStorage`, reset to Chat
  by a reload — and ask-bridge exposes no hook for it, so wfa attached to the CDP
  endpoint Chrome already opens (9223) and presses the control as soon as it
  exists, polling every 80 ms. On this host the switch is clickable ~1.4 s after
  the page appears while ask-bridge types as soon as the editor is ready, so the
  ordering cannot be guaranteed from outside ask-bridge; the task therefore
  records `geminiModeReport` (`applied`, `clicks`, `clickedAt`, `pageUrl`,
  `error`) and `wfa status` prints it. A click that landed after text was already
  typed — which could submit an empty prompt — is reported as an error instead of
  a clean run. A detached plain batch has no coordinator left to hold the
  debugging session and records that it could not press the switch.
- The batch watchdog no longer kills a page that is still being driven. ask-bridge
  emits no progress line and no metadata update while a model generates, so a
  400-line answer was indistinguishable from a hung tab and died at the 300 s
  stall threshold — with `collect` afterwards finding nothing, because the batch
  had been terminated mid-generation. Before declaring a stall, wfa now checks
  the mtime of ask-bridge's `chrome-devtools-mcp.log`, which it writes on every
  tool call (~200 ms while a page generates); if that log moved within the last
  two minutes the run keeps waiting and says so once. The same veto applies to
  the detached-task check in `wfa status`, so a second process cannot kill a
  healthy run either. `--stall-timeout` now defaults to 900 s instead of 300 s.
- A batch that prints nothing for ten minutes can now be told apart from a dead
  one: every 60 s the CLI emits `[wfa] still waiting: gemini quiet 240s (stall
  limit 900s)`. The line is synthetic — it is not written to
  `batch.stdout.log`, carries no job id, and does not reset the silence it
  reports — so if it stops appearing, the process is gone.
- A completed answer that admits it could not open the attachment is flagged.
  A measured `--bundle-repo=zip` run finished `completed` with "当前会话环境中没有可用
  的文件解压或本地文件读取工具" and produced no code; `wfa code` and `wfa status`
  now warn that the attached files were probably unused and say to resend the
  content as text or point the provider at a reachable URL.

### Changed
- The default pair is now Gemini in Task mode plus ChatGPT, in that order
  (`defaultProviders` and `defaultCompareProviders` = `["gemini", "chatgpt"]`,
  `geminiMode` = `"task"`). Previously Gemini landed on Chat unless
  `--gemini-mode task` was passed, so the default run never touched the switch
  and `wfa status` had nothing to report. `--gemini-mode chat` and
  `wfa gemini-mode chat` still select Chat, per request or as the saved default.

### Fixed
- `--detach` no longer turns "the host killed the worker" into a locked task.
  Measured: the spawn flags were already right (`detached`, ignored stdin,
  `unref()`), and an isolated script using wfa's own `spawnDetached` showed the
  same death for both `ask-bridge.exe batch` and a plain node heartbeat — while
  the same run finished normally when the parent was held open for 8 s. The
  killer is the calling host's process-tree cleanup, which `detached` cannot
  escape. ask-bridge writes its startup banner straight into `batch.stdout.log`,
  so a detached task whose two batch logs are both 0 bytes provably never
  reached a provider; `refreshTask` now records `failed_before_start` for that
  case (a plain `failed`, no workspace lock, safe to rerun) and says why. Any
  output at all keeps the conservative `interrupted_unknown` verdict. Foreground
  runs are excluded: their stdout is buffered in the runner, so an empty file
  there means nothing.
- Repository archives are named `<slug8>-<hex8>.zip` (17-character stem) instead
  of `<slug>-<timestamp>-<hex>.zip` (~50). Measured on one machine with the same
  55,699-byte file: stems of 8, 19 and 20 characters complete in 13-17 s, a
  21-character stem fails twice in a row at 49-52 s, and `metadata.json` records
  no thread — the prompt was never submitted. Uniqueness now comes from eight
  random hex characters; `pruneArchives` sorts by mtime, so the timestamp was
  never load-bearing.
- The Gemini attachment refusal message and `docs/known-issues.md` U1 said
  native parsers time out. They do not: the whole-filename check does. The
  refusal now names the real cause and the 20-character stem that
  `--allow-gemini-attachments` needs, so the workaround no longer pushes users
  toward inlining and the ~44 KiB prompt ceiling.
- `docs/known-issues.md` U7 (`exit_type=Crashed`) is recorded as fixed in
  ask-bridge 0.4.0 (`cdp_browser_close` plus `--headless` defaulting to true),
  leaving only the externally-killed case that WFA still repairs at startup, and
  U10 gains its source-level root cause (a finished job closes the MCP-selected
  page, and the next job's `list_pages` reports it as "failed to open tab").


## 0.2.8 - Unreleased

One killed run used to be enough to make a data directory permanently unusable:
the store lock could not be taken over, and every command -- including read-only
ones -- queued behind it. On a Windows host where writes to the data directory
were intermittently blocked for 15-30 s (a filter driver; measured, then
transient), two concurrent sessions deadlocked each other within one request.

### Fixed
- A read no longer takes the exclusive write lock. `wfa list`, `wfa status` and
  every other snapshot keep working while another session holds the lock; each
  file is still replaced atomically, so a reader sees a complete file. A
  snapshot is a preview, never the basis for a commit.
- `--no-refresh` was parsed and then ignored, so `wfa list --no-refresh` still
  ran up to twenty write transactions. It is honoured now, and refreshes run
  sequentially instead of as a burst of lock waiters.
- `wfa unlock` clears a lock whose owner is gone: rename to
  `.store.lock.stale-<token>-<ts>` first (a rename needs no delete, and deleting
  is what a filter driver or antivirus refuses), unlink second. Takeover is
  serialized through a separate claim file and re-verifies the lock generation
  (token, pid, createdAt) before touching it, because two waiters that both saw
  the same dead lock could otherwise rename the lock the other one just created.
  Six processes racing one stale lock are tested on Windows; their critical
  sections never overlap.
- A dead owner whose lock can be neither renamed nor deleted now fails fast with
  `STORE_LOCK_UNRECLAIMABLE`, naming the lock path, the owner and the two ways
  out, instead of burning the full wait budget and then saying "retry".
- Waiting for the lock prints one stderr line after 750 ms with the holder's
  pid, host, age and the lock path. `STORE_LOCK_TIMEOUT` carries the same
  fields. The default wait is 60 s (`WFA_LOCK_TIMEOUT_MS`), which covers one
  holder's writes on a throttled volume; the staleness rule for an unknown owner
  is a separate constant so raising the budget cannot make reclaim more eager.
- A transaction only rewrites the files whose content changed. On a volume where
  each overwrite costs 15-30 s, skipping an untouched `sessions.json` is the
  difference between one wait and two.
- `checkAskBridge` no longer runs inside the task-creation transaction, where it
  held every other session out for the duration of an external process probe.
- `mkdir` for the data directory treats "it exists" as success, including the
  Windows `EPERM` variant; a real permission problem is still reported by the
  following `open`, with the path.
- A batch job whose answer was written but whose `metadata.json` could not be
  finalized (Windows `os error 5`) is recorded as `completed` with
  `degradedReason: METADATA_PERSIST_FAILED` and its `response.md` kept, instead
  of being judged `failed` and losing a finished answer.
- Injecting a repository reference now prints the `url@commit` before sending,
  next to the reminder that `--no-repo` sends the prompt only and
  `--bundle-repo=zip` sends the actual sources. The default is unchanged.
- `wfa --version` answers instead of `Unknown command "--version"`, without
  creating a store or probing a provider.
- `wfa doctor` measures one overwrite and one rename in the data directory and
  flags `SLOW` above two seconds, and prints a progress line before the Chrome
  and ask-bridge checks so an empty terminal no longer reads as a hang.


## 0.2.7 - Unreleased

The zip transport shipped in 0.2.6 was treated as an opaque blob by everything
except the upload itself: the task still claimed a remote reference, the secret
scanner could not see inside it, and two archives of the same repository in the
same second wrote to the same path. This release closes those gaps so the two
transports behave the same way.

### Fixed
- `--bundle-repo` with `--file` selects the named sources again when the working
  tree has more than one absolute spelling. `git rev-parse --show-toplevel`
  resolves junctions, 8.3 short names (`C:\Users\RUNNER~1\…`, the temp path on
  the Windows CI runner) and drive-letter case, but the include comparison used
  raw `path.resolve` strings, so a mismatch selected nothing. The bundle then
  shipped an inventory that claimed "the sources included below are
  authoritative" while holding zero sources. Includes are now reduced to
  repository-relative labels through `realpath` and folded by case on Windows.
  This had been failing every `windows-latest` CI job since 0.2.5.
- `--bundle-repo` now fails with `BUNDLE_REPO_INCLUDE_UNMATCHED` when none of the
  `--file` paths made it into the bundle, naming the paths and the reason. It
  used to send the empty bundle silently; in inline mode those `--file` paths are
  consumed as includes and never attached, so the request arrived with neither
  the sources nor any warning.
- The task-store lock treats `EPERM` with no file on disk the same way it treats
  `EEXIST`: the previous holder is mid-release and the file is in Windows'
  delete-pending state, so retry. Previously that race escaped as a raw `EPERM`
  and failed a concurrent `wfa` invocation outright. A directory that is really
  unwritable still fails, now as `STORE_LOCK_UNWRITABLE` with the path.
- A `--bundle-repo=zip` task no longer records a `repoReference`, and its result
  is no longer run through the `REPO_UNREADABLE` sentinel. `task.bundleRepo`
  means "a repository payload was shipped", not "it was inlined", so it is now
  set for both transports. Previously an archive task could be marked
  `repo_unreadable` and handed a fallback command that recommended the archive
  it had already used.
- Archive text entries are scanned for secrets while the zip is packed, and the
  findings go through the same gate as an inline bundle: a key-shaped line in a
  tracked source blocks the send unless `--allow-sensitive` is passed. Binary
  entries are still reported in `unscannedAttachments`, now with a count.
  Before this, a zip was listed as one unscanned binary attachment, so a
  committed credential reached the provider with only a generic warning. An
  archive ships every tracked file rather than the inline transport's bounded
  selection, so a test fixture that the selection happened to skip now blocks
  the send too; `--exclude` names the file and `--allow-sensitive` accepts it.
- Archive names carry milliseconds and a random suffix. Two archives of the same
  repository in the same second used to resolve to the same path, so the second
  overwrote a file the first task might still be uploading.
- Pruning keeps archives younger than ten minutes even when the count exceeds
  the retention limit, for the same reason: an in-flight upload must not lose
  its attachment.
- The archive cap is 50 MiB, matching the attachment limit, instead of 4 GiB.
  A larger archive now fails before the task is created and names the real
  reason; previously it failed later at upload.
- The `REPOSITORY ARCHIVE` block admits when the working tree was dirty, with
  the number of files involved. It is packed from the working tree, so claiming
  only "at commit X" let the provider treat uncommitted work as the pushed
  state.
- `--dry-run`'s `splitPlan` no longer lists archive attachments. They upload
  natively and are never inlined, so describing a "forced inline fallback" for
  them was noise that made a 1 MiB zip look like an oversized prompt file.

## 0.2.6 - Unreleased

The 40 KiB ceiling was never an ask-bridge limit: it applies to **prompt text**
that the provider truncates, not to attachments, which upload natively. A
132 KB zip reaches Gemini through `ask-bridge batch` in 15 seconds. This release
makes that path first-class and stops paying for a constraint that did not exist.

### Added
- `--bundle-repo=zip` packages the tracked, non-sensitive sources into a zip and
  sends it as a native attachment. The prompt only carries a short
  `REPOSITORY ARCHIVE` block, so a whole repository fits: 64 files / 427 KB
  compress to 146 KB (~34%), which is well under the prompt ceiling and needs no
  `--exclude` tuning. `--bundle-repo` without a value keeps the inline transport.
- `src/repository-archive.js`: dependency-free ZIP writer (deflate with a store
  fallback, UTF-8 names, CRC32 per entry) plus `collectTrackedSources`, which
  shares the inline bundle's skip rules so both transports ship the same files.
  Archives are pruned to the newest five.
- `isArchiveAttachment` — `zip`/`tar`/`gz`/`tgz`/`7z` upload natively on both
  providers.

### Fixed
- Gemini no longer refuses archive attachments. The old
  `GEMINI_ATTACHMENT_UNSUPPORTED` guard assumed every native upload times out;
  measured, archives complete in 15s and the document parser timeout does not
  apply to them. Binary documents are still blocked or inlined.
- The `--bundle-repo` fallback command now recommends `--bundle-repo=zip`
  instead of asking for `--exclude` tuning against a 40 KiB budget.
- Every message that called 40 KiB an attachment limit now says prompt text.
  `--dry-run`'s `splitPlan` note states that attachments are not cut at 40 KiB,
  and the `ATTACHMENT_UPLOAD_TIMEOUT` hint offers the archive transport first
  instead of telling the user to inline the file under 40 KiB.
- `Store.withLock` no longer surfaces a raw `EEXIST` when the holder releases
  the lock between `open()` and `stat()`. That race failed 3 out of 5 suite runs
  before it was fixed. `Store.transaction(callback, timeoutMs)` also accepts an
  explicit lock timeout.
- `wfa ask "text"` uses the positional argument as the prompt. It used to be
  silently ignored, which then fell through to stdin and in a background shell
  hung forever.
- A stdin that never closes (detached worker, CI runner, `/dev/null`) no longer
  hangs the CLI: with no first byte within 400ms the prompt is empty and the
  command fails fast with an actionable message. Pipes and redirected files
  still read normally.
- Test cleanup retries a recursive `rm` on Windows. A file the last writer has
  just unlinked sits in delete-pending state for a few milliseconds, so an
  immediate `rm` could throw `ENOTEMPTY` and fail an otherwise passing suite.
  Five consecutive full runs now pass 114/114.

## 0.2.5 - Unreleased

The four defects that could silently degrade a run are fixed at the source: a
contradictory prompt when a follow-up also bundles the repository, a repository
reference that ignored uncommitted or unpushed work, a stall kill that discarded
the captured logs, and a serial batch that made `--detach` inherit the tab-close
failure. `src/runner.js` is split into orchestration, stall and retry modules.

### Fixed
- `--followup` combined with `--bundle-repo` no longer injects the `REPOSITORY`
  block (which tells the provider not to wait for pasted files) and no longer
  runs the `REPO_UNREADABLE` sentinel check, so the inlined bundle is the only
  instruction the provider sees.
- The repository reference now inspects `git status --porcelain` and the count
  of commits not present on the remote, records `dirty`/`dirtyFiles`/
  `unpushedCommits`/`safeToReference`, and warns in the prompt when the local
  HEAD has not been pushed. A failed Git call degrades to "unknown" instead of
  failing the task.
- A stall kill preserves the stdout/stderr lines already captured instead of
  overwriting them with empty strings, and every watchdog, force-kill and drain
  timer is `unref()`ed so the CLI can exit on its own after `afterKill`.
- Provider retries persist their own `batch.stdout.<provider>.retry.log` and
  `batch.stderr.<provider>.retry.log`, and `refreshTask` reads them.
- The `repositoryFallbackCommand` for `wfa code` keeps the `code` subcommand
  with `--followup` and `--requirement` (the `FILE:` delivery contract), adds
  `--exclude`, and asks for missing files by name instead of degrading to
  `wfa ask`.
- A task now records `heartbeatAt`, refreshed every 45 seconds by the process
  that owns it. `wfa resolve`/`wfa collect` only treat `parentPid` as alive when
  that heartbeat is fresher than 180 seconds, so a recycled pid can no longer
  lock a task forever (measured on this machine: `parentPid 31808` had been
  reassigned to an unrelated MCP server, and `wfa resolve` refused to unlock a
  dead task with `TASK_STILL_RUNNING`). Tasks written by older versions keep the
  previous pid-only behaviour.

### Changed
- Each provider now runs its own single-job batch, so a tab closed by the
  previous job cannot strand the next one. This removes the U10 failure mode for
  `--detach` as well, not just for the synchronous path.
- `src/runner.js` (955 lines) is split into `runner-orchestration.js`,
  `runner-stall.js` and `runner-retry.js`; `runner.js` remains the stable public
  re-export shim.
- `wfa list` refreshes non-terminal tasks before printing, so a detached task no
  longer shows `running` after its worker has exited.
- `wfa install-skill` accepts `--target codex|workbuddy|<skills-dir>` instead of
  hardcoding `~/.codex/skills`.
- Chrome `profile.exit_type: "Crashed"` repair and `chrome-devtools-mcp.log`
  rotation moved into `src/ask-bridge.js`, so the external wrapper script in
  `~/.local/bin` is no longer required.

### Added
- `wfa stage` applies exact `ANCHOR:`/`REPLACE:` blocks in addition to complete
  `FILE:` blocks, accepts a conventional `./relative/path`, and refuses to stage
  a result whose `latexEscaping` heuristic fired.
- `tests/core-bugs.test.js` and extended `tests/repo-reference.test.js` cover the
  dirty/unpushed repository reference, the bundle/follow-up combination, stall
  log retention, anchor staging and the LaTeX guard (104 tests total).

## 0.2.4 - Unreleased

A request to a project that has a Git remote now points the providers at that
repository instead of asking the local agent to bundle source, and the two ways
a run could hang forever are closed.

### Added
- Default `REPOSITORY` prompt context from the detected Git remote (prefer `origin`), branch and HEAD commit; `--repo-url` overrides it and `--no-repo` disables it. `wfa code` no longer requires local files when a repository reference exists.
- A conservative `REPO_UNREADABLE` response classifier and per-provider `repoUnreadable` evidence. Such a response is not a completed answer; `wfa status` prints an explicit inline-source fallback command.
- Explicit `--bundle-repo` fallback: tracked UTF-8 source only, size caps, binary/generated exclusions and dry-run `{files, bytes, skipped}`. The existing 40 KiB prompt guard stays authoritative because ask-bridge truncates above roughly 44 KiB.
- `--continue-session` for explicit workspace conversation reuse; `--followup` continues the named task thread. Every independent task now defaults to a fresh conversation, and a reused conversation no longer silently absorbs a new task.
- Per-task `sessionPolicy` and `threadMismatch` diagnostics; a contaminated conversation URL is excluded from future workspace sessions.
- `--stall-timeout` (default 300 seconds; 0 disables), per-provider progress/metadata liveness checks, a distinct blocking `stalled` state and recovery instructions. A batch that goes silent is killed instead of waiting out the whole timeout.
- Windows `EPERM` collision recovery for the atomic task-store lock, including dead-PID and old-owner reclamation without stealing a live process's lock.

### Changed
- The web-first Skill now asks the providers to inspect the repository directly; local source bundling is no longer the default and follow-ups attach only specifically requested evidence.
- Updated README and CLI help for repository-first code, explicit session continuation, the fallback byte ceiling, stall recovery and the existing two-provider serial default.

## 0.2.3 - Unreleased

A run now asks ChatGPT **and** Gemini by default, and every default path is
hardened against the ask-bridge limitations measured on this machine. See
`docs/known-issues.md` for the defects that remain upstream-owned.

### Added
- `defaultProviders: ["chatgpt", "gemini"]` in config and constants: `wfa ask`, `wfa compare` and `wfa code` fan out to both providers unless `--provider`/`--providers` narrows it. `wfa login` still defaults to a single provider.
- `defaultConcurrency: 1`; the CLI resolves the default from config instead of hardcoding it.
- Gemini text attachments are inlined into the Gemini prompt (`===== FILE: ... =====` sections) instead of being uploaded, because the ask-bridge upload always times out. `--dry-run` reports `geminiInline: { files, bytes }`.
- `--allow-gemini-attachments` forces the native upload for testing or for a fixed ask-bridge build.
- `responseHeuristics` on every completed provider: `canvasStub` flags a short response that only links a downloadable artifact (ChatGPT put the body in Canvas) and `latexEscaping` flags `\vert{}` / `\lbrace{}` corruption (Gemini re-escaped the text). Reported by `wfa result`, `wfa status --json` and `wfa task`; `wfa result --stdout` writes them to stderr so the answer on stdout stays clean.
- `sessionIsolationWarning` when a non-fresh request lands on the same conversation URL as the most recent completed task for that workspace/provider, i.e. when `--new-session` did not actually isolate the run.
- Single-job retry for the serial-batch tab bug: when ask-bridge closes the previous job's tab and the next provider fails with `list_pages failed: The selected page has been closed` before submitting anything, that provider is re-run alone in its own `--concurrency 1` batch. Recorded as `retriedAsSingleBatch` on the provider plus a task-level `retryWarnings` entry, and surfaced by `wfa status` / `wfa task` as a `Retry:` line instead of staying buried in the ledger.
- `docs/known-issues.md` is now an upstream-only list (U1–U10) with reproduction, expectation and impact per item, ready to file against ask-bridge; wfa-side mitigations are listed separately and explicitly labelled as detection/workaround, not fixes.

### Changed
- A prompt above the size threshold is rejected **before** a task is created (`PROMPT_OVERSIZE`) instead of being sent and silently truncated at ~44 KiB. `--allow-oversize` still overrides.
- `--dry-run` reports `promptBytesByProvider`, `transportAttachmentBytes`, `blockReasons`, `geminiInline` and `geminiAttachmentBlocked`; the preview exits 2 when any provider is blocked.
- `wfa ask --help` documents the two-provider serial default, the `--concurrency` default of 1, and the new Gemini attachment behaviour.

### Fixed
- A Gemini binary/native attachment no longer starts a batch that is guaranteed to time out; it fails fast with `GEMINI_ATTACHMENT_UNSUPPORTED` and the exact options that work.
- A serial two-provider run no longer ends half-finished because of the second job's closed tab.
- `docs/known-issues.md` no longer claims ask-bridge 0.2.1; it targets the installed 0.4.0.

## 0.2.2

### Added
- `--concurrency <N>` is documented and validated as 1..3 independently of the provider count. `--concurrency 1` now runs several providers serially in one batch, which is the only safe mode on machines where concurrent browser tabs interfere with each other.
- `--dry-run` reports prompt bytes per provider plus a `promptSizeRisk` block. A prompt above 40 KiB for any provider marks the preview `sizeBlocked` and exits 2, because ask-bridge truncates silently around 44 KiB.
- `--allow-oversize` keeps `--dry-run` at exit 0 when the prompt exceeds the threshold, for cases where the size is known and accepted.
- ask-bridge stdout/stderr lines are streamed to the caller while the batch runs, so progress is visible before the process exits instead of arriving as one buffered block.
- `ATTACHMENT_UPLOAD_TIMEOUT` classifies the observed Gemini upload failure and explains that the prompt was never submitted.
- `docs/known-issues.md` documents reproductions, evidence and workarounds for the upstream limitations measured against ask-bridge 0.4.0.

### Changed
- `wfa compare` help now points at `--concurrency 1` instead of claiming concurrent execution is the only mode.
- `--new-session` prints a warning that the underlying ask-bridge build may still reuse an open tab, so provider-side isolation has to be verified rather than assumed.
- `--dry-run` exit codes are based on a single `blocked` flag covering both secret findings and prompt-size risk.
- `WORKSPACE_PROVIDER_LOCKED` errors now name the exact `wfa status` / `wfa wait` / `wfa resolve --confirm` command to run, and state that `--new-session` does not bypass a request that may already have been submitted.

### Fixed
- A single `failed` job no longer locks the workspace/provider forever. Failures proven to happen before submission — failed tab load, failed prompt submission (send button never enabled), and Gemini attachment upload timeout — no longer block the next request. `timed_out`, `recoverable`, `interrupted_unknown`, generic `failed`, and any failure carrying a thread URL, result path or completion proof still block, because an uncertain resend is worse than an explicit resolve.
- Multi-byte UTF-8 split across chunk boundaries is decoded correctly before line splitting.

## 0.2.1 - Unreleased

### Added
- Automatically adopt ask-bridge per-job results only when terminal metadata has an exact job/provider identity, `state: completed`, and a stable non-empty UTF-8 `response.md` artifact.
- Persist a completion proof containing metadata and response SHA-256 hashes; verify it again before result reads, collection and code staging/application.
- Make `wfa collect` idempotent for verified or already-saved results, without an extra confirmation or a redundant `ask-bridge get` call.
- Report newly auto-collected results from `wfa wait` / `wfa attach` and optionally stage completed code results.
- Keep the workspace/provider lock while the owning WFA/ask-bridge process is still cleaning up, even when a per-provider result is already safe to read.
- Require exact ask-bridge `id` and `provider` metadata fields and reject symlinked, unstable, empty, invalid-UTF-8 or identity-mismatched artifacts.

### Safety
- Completion is based on ask-bridge's terminal batch metadata, never on repeated or unchanged response text.
- `--confirm-complete` remains required only for manual recovery through `ask-bridge get` when no trusted terminal artifact exists.
- A completed per-provider result can be read while batch cleanup is pending, but a new task for the same workspace/provider remains blocked until the owning process exits.
- Manual `get` results are marked separately and do not receive an ask-bridge batch completion proof.

## 0.2.0 - Unreleased

### Added
- Recursive file/directory/glob attachment expansion with exclusions, safe traversal defaults, image classification and native document attachments.
- UTF-8 line-numbered source bundling for `wfa code`, with dry-run preview, estimated context size and secret-location scanning.
- `full-file` and `spec` code modes; spec results are not eligible for automatic file staging/application.
- Per-provider first-session/fresh injection of `.wfa/active-brief.md` and explicit `--brief-file`.
- WFA task follow-up by parent task ID, preserving the exact provider conversation URL and parent lineage.
- Native detached ask-bridge launch with task-scoped output logs and read-only `wait` / `attach`.
- Structured rate-limit, login-required and Cloudflare error classification with recovery guidance.
- Revision-based collect/refresh compare-and-swap checks to prevent stale metadata from resurrecting or overwriting newer task state.
- Result reading, safe staging and explicit hash-verified apply with rollback backups.

### Safety
- Dry-run does not create tasks or invoke a provider.
- Uncertain requests are never automatically resent.
- Read-only reattachment does not send or collect a new prompt.
- Collect requires explicit completion confirmation; two matching partial responses never certify completion.
- Detached launch must confirm a PID; launch failure is recorded as `failed_before_start`.
- Provider-generated code is never applied automatically; `--confirm` is required.


## 0.1.1 — Reliable recovery and exit status

- Preserve the latest successful provider session when inspecting historic tasks or resolving failed follow-ups.
- Return a nonzero exit code for incomplete requests while keeping the task summary and any completed results.
- Keep uncertain submissions recoverable after post-launch process errors.
- Coordinate upstream updates with new task launches.
- Quote provider lists in PowerShell examples so they reach the npm CLI shim as a single argument.

- Disable provider reasoning-strength selection in WFA. Requests use each provider's current web UI setting; model selection, parallel execution and task recovery remain available.
- Bound the local ask-bridge stdio drain after the child process exits, so inherited descendant handles cannot keep `wfa ask` waiting indefinitely. Preserve captured output and record when the drain grace period is used.

## 0.1.0 — Initial project package

- Added local `wfa` CLI backed by the independently installed ask-bridge executable.
- Added single-provider ask, concurrent multi-provider compare and complete-code delegation modes.
- Added workspace/provider session persistence, task ledger, request fingerprinting and duplicate-send protection.
- Added fail-closed handling for timed-out, recoverable and interrupted tasks.
- Added explicit response collection and manual task-abandon controls.
- Added the single Codex `web-first` Skill and Windows/Ubuntu CI.
