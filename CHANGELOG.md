# Changelog

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
