# Changelog

## 0.2.2 - Unreleased

### Added
- `--concurrency <N>` is documented and validated as 1..3 independently of the provider count. `--concurrency 1` now runs several providers serially in one batch, which is the only safe mode on machines where concurrent browser tabs interfere with each other.
- `--dry-run` reports prompt bytes per provider plus a `promptSizeRisk` block. A prompt above 40 KiB for any provider marks the preview `sizeBlocked` and exits 2, because ask-bridge truncates silently around 44 KiB.
- `--allow-oversize` keeps `--dry-run` at exit 0 when the prompt exceeds the threshold, for cases where the size is known and accepted.
- ask-bridge stdout/stderr lines are streamed to the caller while the batch runs, so progress is visible before the process exits instead of arriving as one buffered block.
- `ATTACHMENT_UPLOAD_TIMEOUT` classifies the observed Gemini upload failure and explains that the prompt was never submitted.
- `docs/known-issues.md` documents reproductions, evidence and workarounds for the upstream limitations measured against ask-bridge 0.2.1.

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
