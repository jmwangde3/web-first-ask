# web-first-ask

**Codex-first CLI + Skill for delegating thinking and complete code implementation to ChatGPT and Gemini Web, serially by default.**

`web-first-ask` (`wfa`) is a local Node.js CLI that calls the independently maintained [`ask-bridge`](https://github.com/doggy8088/ask-bridge) executable. It explicitly selects ask-bridge's `browser` backend because its Batch command does not support SIWC. It does not expose an MCP server to Codex and does not reimplement browser automation.

- Codex calls one local command and waits while `ask-bridge batch` performs its own browser-side polling.
- **ChatGPT and Gemini are the default provider pair**: a bare `wfa ask` / `wfa code` / `wfa compare` asks both. Use `--provider` or `--providers` to narrow. WFA does not set or change provider reasoning strength; it uses the current setting in the provider web UI.
- Multi-provider runs are **serial by default** (`--concurrency 1`), because concurrent browser tabs interfere with each other on the same machine. `--concurrency 2..3` is available and validated.
- `wfa compare` sends the same prompt and attachments to every selected provider, then saves each answer separately.
- `wfa code` defaults to a path-and-line-numbered source bundle and asks for **complete replacement contents**; `--mode spec` switches to a compact implementation specification.
- Directory recursion, quoted glob patterns, exclusions, image attachments and native document attachments are built into the CLI.
- `--dry-run` previews per-provider prompt bytes, attachment size, estimated tokens, prompt-size risk, block reasons and likely secret locations without creating a task or launching a provider. A prompt above 40 KiB per provider exits 2; `--allow-oversize` keeps it at 0.
- A local task ledger records request IDs, provider states, conversation URLs, parent-task lineage, revisions and result paths.
- Uncertain sends are never automatically repeated. An unresolved provider/workspace is locked until the user collects or explicitly abandons the old task, except for failures that provably happened before submission (tab load failure, send-button failure, attachment upload timeout), which release the lock automatically. The single exception in the other direction: when ask-bridge closes a serial batch's tab, the stranded provider is retried once in its own batch, because nothing had been submitted.
- ask-bridge progress lines are forwarded to stderr as `[ask-bridge stdout] …` while the batch is still running.
- Every completed answer carries `responseHeuristics` (Canvas stub, LaTeX/escape corruption) and, when relevant, a `sessionIsolationWarning` — signals, never silent rewrites.
- Results can be inspected and staged; writing staged code into the workspace requires an explicit `wfa apply --confirm` and SHA-256 revalidation.
- WFA can continue an existing task conversation with `--followup`.
- ask-bridge remains an external tool; WFA adds no runtime npm dependency.

## Architecture

```text
Codex
  └─ one foreground `wfa` CLI invocation
       └─ web-first-ask task ledger / idempotency / workspace sessions
            └─ `ask-bridge batch` (external executable)
                 └─ Chrome + provider websites
                      ├─ ChatGPT
                      ├─ Gemini
                      └─ Claude
```

Codex does not connect to an MCP server. **ask-bridge internally uses `chrome-devtools-mcp`/MCP to control Chrome**; that is an implementation detail of the upstream dependency, not a Codex-facing MCP integration.

## Requirements

- Node.js version supported by ask-bridge: `^20.19.0`, `^22.12.0`, or `>=23.0.0`.
- `ask-bridge` installed and available on `PATH`, or set `ASK_BRIDGE_BIN` to its executable path.
- Provider accounts logged in through ask-bridge.

Install ask-bridge using its official instructions: <https://github.com/doggy8088/ask-bridge#installation-and-build>.

## Install web-first-ask

From this repository, in PowerShell:

```powershell
npm install -g .
wfa doctor
wfa install-skill
```

`wfa install-skill` copies `skills/web-first/SKILL.md` to `%USERPROFILE%\.codex\skills\web-first\SKILL.md`. Restart or refresh Codex Skill discovery afterward.

For a local development checkout:

```powershell
npm test
node .\bin\wfa.js doctor
```

## First-time provider login

```powershell
wfa login --provider chatgpt
wfa login --provider gemini
wfa login --provider claude
```

Only log in to the providers you intend to use.

## Basic use

Set the default browser mode once. WFA saves the setting in its local `config.json` and uses it for subsequent `ask`, `compare`, and `code` tasks.

```powershell
wfa browser-mode           # Show the saved or default mode
wfa browser-mode headful   # Show the Chrome window
wfa browser-mode headless  # Run Chrome in the background (default)
```

ask-bridge can reuse an open Chrome instance. To switch an already running instance, wait for active tasks to finish and run `ask-bridge close`. The next request opens Chrome in the saved mode. `wfa login` opens a visible window for manual sign-in.

**Windows workaround for ask-bridge 0.4.0:** After switching from `headless` to `headful`, Chrome may reopen at a saved off-screen position. Press **Alt+Tab** to select the ask-bridge Chrome window, then press **Win+Up Arrow** to maximize it and bring it back on screen. [ask-bridge window launch code](https://github.com/doggy8088/ask-bridge/blob/7d4731f60f300f7cf3b98a5a92137144a17f98e9/src/main.rs#L2421-L2440)

Ask ChatGPT and Gemini (the default pair) and continue the stable workspace conversation:

```powershell
wfa ask --workspace my-repository --prompt-file .\question.md
```

Ask a specific provider only:

```powershell
wfa ask --provider gemini --workspace my-repository --prompt "Review this error and identify the likely cause."
```

Ask both providers explicitly (same thing the default does):

```powershell
wfa compare --providers 'chatgpt,gemini' --workspace my-repository --prompt-file .\question.md
```

Include Claude too:

```powershell
wfa compare --providers 'chatgpt,gemini,claude' --workspace my-repository --prompt-file .\question.md
```

Ask both providers for complete modified code, attaching complete relevant source and test files:

```powershell
wfa code `
  --workspace my-repository `
  --requirement "Fix the race in task recovery. Preserve existing idempotency and add focused regression coverage." `
  --file .\src `
  --file .\test `
  --exclude "**/*.snap"
```

Compare complete code implementations from ChatGPT and Gemini:

```powershell
wfa code `
  --providers 'chatgpt,gemini' `
  --workspace my-repository `
  --requirement "Implement the requested behavior. Return complete replacement contents for every changed file, not a plan or diff." `
  --file .\src `
  --file .\test `
  --exclude "**/*.snap"
```

For provider-specific model selection in a multi-provider run, use `--model-map 'chatgpt=<model>,gemini=<model>'`. Reasoning-strength selection is intentionally not managed by WFA. `--download-images` enables downloading generated images; it is off by default.

The answers are saved separately under the local data directory. Codex should read the returned files, review them, apply the chosen implementation, and run tests. `wfa` never writes provider-generated code into the target repository automatically.

## Context packaging and attachments

- `--file <path>` accepts a file, a directory, or a quoted glob. Directories recurse.
- `--dir <path>` is an explicit recursive-directory alias.
- `--exclude <glob>` can be repeated. A leading `!` on an include value also treats it as an exclusion.
- Supported glob operators are `*`, `?`, `**`, and `{a,b}`. A pattern without `/` also matches basenames.
- Directory scans skip `.git`, `node_modules`, `.wfa`, common build/cache folders, and credential-like filenames by default.
- Images (`png`, `jpg/jpeg`, `webp`, `gif`, `bmp`, `tif/tiff`, `avif`) are routed as image attachments. If a directory contains images, they are detected automatically. Gemini image attachments are rejected before launch because the current ask-bridge batch contract does not support them.
- Common source files and native documents (`pdf`, `doc/docx`, `xls/xlsx`, `ppt/pptx`, `odt/ods/odp`, `rtf`, `csv`, Markdown and text) are attached without flattening binary document formats into text.
- **Gemini never receives an upload.** ask-bridge's Gemini upload times out every time, so for Gemini the CLI inlines text attachments into the prompt as `===== FILE: <path> =====` sections and keeps the native attachment for the other providers. `--dry-run` shows `geminiInline: { files, bytes }`. Binary-only attachments cannot be inlined: the run fails fast with `GEMINI_ATTACHMENT_UNSUPPORTED` and the options that work, unless `--allow-gemini-attachments` forces the native upload. Watch the inlined byte count — it counts against the ~44 KiB prompt ceiling.
- `wfa code` bundles text source by default. The bundle uses `relative/path:line | source text`; native documents and images stay as separate files.

Preview before sending:

```powershell
wfa code --requirement "Review this module for race conditions." --file .\src --exclude "**/*.snap" --dry-run
```

The preview's token count is a rough byte/4 heuristic, not the provider's tokenizer. The secret scanner reports file/line/kind but never prints matched values. It cannot inspect binary documents or image contents. A positive finding blocks sending unless you explicitly pass `--allow-sensitive`; WFA does not silently rewrite or redact source files.

## Briefs and follow-up lineage

Create a project brief using handoff-kb and save it as UTF-8 without BOM at `.wfa/active-brief.md`:

```powershell
.\scripts\make-active-brief.ps1 -Target . -Task "Current task summary" -KbRoot "$HOME\.skills-manager\skills\handoff-kb"
```

WFA auto-injects it only when a provider is starting a new workspace conversation or when `--fresh`/`--new-session` is used. Existing conversations do not receive the same brief every turn. Use `--brief-file <path>` for an explicit one-off injection, or `--no-brief` to disable automatic discovery.

Continue a completed WFA task's exact provider conversation:

```powershell
wfa ask --provider chatgpt --workspace my-repository --followup <parent-task-id> --prompt "Continue with the second issue."
```

This sends a new follow-up turn to the saved conversation; it does not re-submit the parent prompt or attach the parent response as a duplicate prompt. The provider may still count the conversation history as input context for the new turn.

## Result review and safe application

```powershell
wfa result <task-id> --provider chatgpt
wfa result <task-id> --provider chatgpt --stdout
wfa stage <task-id> --provider chatgpt
wfa apply <task-id> --provider chatgpt
wfa apply <task-id> --provider chatgpt --confirm
```

`wfa stage` only creates a local staging copy and manifest. `wfa apply` without `--confirm` is preview-only. Confirmation rechecks the provider result SHA-256, staged-file hashes, target-file hashes, workspace containment and symlink boundaries. Spec-mode results cannot be applied as complete files. WFA never runs git add/commit and never applies code automatically on task completion.

## Provider errors and recovery

`RATE_LIMITED`, `LOGIN_REQUIRED`, and `CLOUDFLARE_BLOCKED` are distinct actionable states. WFA shows a cooldown estimate or login/verification hint, but does not automatically retry or unlock an uncertain task. Inspect the task, reattach/collect if a response exists, or use explicit `wfa resolve --confirm` only after verifying the original generation is no longer active.

## Commands

| Command | Purpose |
|---|---|
| `wfa ask` | One or both providers; ChatGPT + Gemini by default, serially |
| `wfa compare` | Same prompt to multiple providers, serially by default |
| `wfa code` | Build a line-numbered full-file or compact spec implementation prompt |
| `wfa wait <task-id>` | Observe task state; adopts only verified ask-bridge terminal artifacts and never resends |
| `wfa attach <task-id>` | Read-only reattachment to a saved task ID |
| `wfa result <task-id>` | Read a saved provider result |
| `wfa stage <task-id>` | Create a non-destructive code staging preview |
| `wfa apply <task-id> --confirm` | Apply a reviewed staging manifest after hash revalidation |
| `wfa status <task-id>` | Inspect task and recoverable provider states |
| `wfa list` | List recent tasks |
| `wfa collect <task-id> --provider chatgpt` | Return an already verified/saved result; no extra confirmation or browser request |
| `wfa collect <task-id> --provider chatgpt --confirm-complete` | Manual recovery via `ask-bridge get` only when no trusted terminal batch artifact exists |
| `wfa resolve <task-id> --provider chatgpt --confirm` | Unlock an unresolved provider only after confirming its old generation is no longer active |
| `wfa login --provider <provider>` | Interactive provider login |
| `wfa doctor` | Check Node.js and ask-bridge batch availability |
| `wfa browser-mode [headless\|headful]` | Show or save the default browser mode for batch tasks |
| `wfa install-skill` | Install the single Codex Skill |
| `wfa upstream update` | Run ask-bridge's official update command |

Use `--json` for machine-readable summaries. Reuse `--request-id` only when recovering the **exact same logical request with identical prompt, providers, attachments and options**. A changed request must use a new request ID.

`ask`, `compare` and `code` exit with 0 when all selected providers complete. An incomplete request exits with 1 and still prints its task summary, including any completed result files. Successful `status` and `list` lookups exit with 0 independently of the state they report.

## Multi-provider behavior

- `wfa ask`, `wfa compare` and `wfa code` default to **ChatGPT + Gemini**. `--provider <name>` narrows to one; `--providers 'a,b,c'` selects explicitly.
- Each provider becomes one ask-bridge batch job in a single batch.
- Jobs run **serially by default** (`--concurrency 1` → `defaultConcurrency` in config). Concurrent tabs interfere with each other on the same machine, and the serial default is what keeps a two-provider run reliable.
- `--concurrency 2` or `3` runs jobs in parallel when you know the machine tolerates it. Validated against `maxConcurrency` (default 3).
- Serial batches on ask-bridge 0.4.0 close the previous job's tab, so the next job fails with `list_pages failed: The selected page has been closed` before submitting. WFA detects that exact pre-submit failure and retries the stranded provider alone in its own batch; the retry is recorded as `retriedAsSingleBatch` plus a task-level `retryWarnings` entry.
- Each provider has a separate saved conversation URL per workspace, and a `sessionIsolationWarning` fires when a non-fresh run lands on the URL of the previous completed task for the same workspace/provider.
- The same prompt and attachments are sent independently to every selected provider; no provider sees another provider's answer.
- Results are stored separately, for example `.../ask-bridge-output/wfa-chatgpt-<id>/response.md` and `.../wfa-chatgpt-<id>/metadata.json`.
- Codex compares the answers and makes the final decision. It must not blindly merge or trust any provider.

## Known issues

`docs/known-issues.md` is the upstream-facing list (U1–U9) of defects measured against ask-bridge 0.4.0, with reproduction, expectation and impact per item: Gemini attachment uploads timing out, prompts above roughly 44 KiB being truncated without a signal, ChatGPT long answers landing in Canvas instead of `response.md`, `--new-session` still reusing an open tab, Gemini escaping Markdown diffs, unstable concurrent tabs, the Chrome `exit_type=Crashed` restore bubble, missing log rotation, and the absence of a `submissionState`. Each item is tagged with what WFA does about it locally — detection or workaround, never a fix. Read it before sending large context or relying on provider-side isolation.

## Local data and privacy

By default, state is stored in:

- Windows: `%LOCALAPPDATA%\web-first-ask`
- macOS/Linux: `$XDG_STATE_HOME/web-first-ask` or `~/.local/state/web-first-ask`

Set `WFA_HOME` to override the directory.

The directory contains prompts, task metadata, provider results, batch input and diagnostic logs. It is local data; do not sync it to a shared location unless you explicitly intend to. Do not attach secrets, credentials, tokens, private keys, personal data, or sensitive legal/arbitration materials to provider requests.

## Safety model

- Task/request identity is persisted before the browser job starts.
- Reusing a request ID with different content is rejected.
- A retry with the same request ID and same payload returns the existing task; it does not submit again.
- `timed_out`, `recoverable`, interrupted and ambiguous states are not resent automatically.
- A local process watchdog allows the ask-bridge per-job timeout plus a 3-minute cleanup margin; if the watchdog fires, the task remains unresolved unless completed artifacts can be verified.
- The same workspace/provider is locked while a previous task is unresolved.
- Ask-bridge batch completion is trusted only when `metadata.json` has the exact expected job ID and provider, `state: completed`, and a stable, non-empty UTF-8 `response.md`. WFA records hashes for both artifacts and verifies them again before reading or staging the result.
- `wfa collect` returns a verified batch result idempotently without `--confirm-complete` and without calling `ask-bridge get`. The flag remains required only for manual recovery when no trusted terminal artifact exists, because `ask-bridge get` alone cannot prove generation has finished.
- A completed per-provider result may be read while ask-bridge finishes batch cleanup, but the workspace/provider lock remains active until the owning process exits.
- `resolve` requires `--confirm`; use it only after confirming the old generation has stopped.
- Provider output is untrusted input. Codex must validate code, run tests and inspect actual diffs before accepting it.

## Upstream dependency

The integration is based on ask-bridge's `batch` JSONL interface and per-job `metadata.json` / `response.md` artifacts. The current reviewed upstream source is recorded in [`docs/UPSTREAM.md`](docs/UPSTREAM.md). This project intentionally does not copy or fork ask-bridge source.

Run `wfa upstream update` to invoke the upstream's official updater. Then run `wfa doctor` and the smoke tests. Do not update ask-bridge in the middle of an active task.

## Development

```powershell
npm test
npm run check
```

No runtime npm dependencies are required. CI runs Node's built-in test runner on Windows and Ubuntu.

## Detached tasks and safe reattachment

Use `wfa ask --detach ...` to start ask-bridge with task-specific stdout/stderr logs and return the task ID after the OS confirms launch. The task ID and original request ID are persisted; detached work is never auto-resubmitted.

```powershell
wfa ask --workspace my-repository --prompt "Review the design" --detach
wfa wait <task-id> --timeout 300
wfa attach <task-id> --timeout 0
# Return the saved result; verified batch terminal metadata needs no extra confirmation:
wfa collect <task-id> --provider chatgpt
# Only for manual recovery when there is no trusted terminal artifact:
wfa collect <task-id> --provider chatgpt --confirm-complete
```

`wait` and `attach` do not call `ask-bridge get`, do not infer completion from repeated text, and never resend a task. They automatically adopt a per-provider result only when ask-bridge has atomically written matching terminal metadata (`id`, `provider`, `state: completed`) after the non-empty `response.md` artifact. WFA records and rechecks both artifact hashes. For completed full-file code results, `wfa wait <task-id> --stage` can create a non-destructive staging copy; only `wfa apply --confirm` writes code to the workspace.

If the detached process exits without trustworthy metadata and response.md, the task remains `interrupted_unknown` and is **not** automatically retried or collected. Use `wfa status` and inspect the saved browser conversation. `--confirm-complete` is available for this explicit manual recovery path. No external session-manager dependency is required.
