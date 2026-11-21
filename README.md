# web-first-ask

**Codex-first CLI + Skill for delegating thinking and complete code implementation to ChatGPT and Gemini Web, serially by default.**

`web-first-ask` (`wfa`) is a local Node.js CLI that calls the independently maintained [`ask-bridge`](https://github.com/doggy8088/ask-bridge) executable. It explicitly selects ask-bridge's `browser` backend because its Batch command does not support SIWC. It does not expose an MCP server to Codex and does not reimplement browser automation.

- Codex calls one local command and waits while `ask-bridge batch` performs its own browser-side polling.
- **ChatGPT and Gemini are the default provider pair**: a bare `wfa ask` / `wfa code` / `wfa compare` asks both. Use `--provider` or `--providers` to narrow. WFA does not set or change provider reasoning strength; it uses the current setting in the provider web UI.
- Multi-provider runs are **serial by default** (`--concurrency 1`), because concurrent browser tabs interfere with each other on the same machine. WFA now launches each provider as its own single-job batch in sequence, including with `--detach`. `--concurrency 2..3` remains available when the machine tolerates it.
- `wfa compare` sends the same prompt and attachments to every selected provider, then saves each answer separately.
- `wfa code` asks for **complete replacement contents**. If the working directory is a Git repository with a remote, WFA sends the repository URL, branch and HEAD commit and the providers read the repository themselves — no local file selection. `--mode spec` switches to a compact implementation specification.
- When the repository cannot be read, a provider replies `REPO_UNREADABLE`; that is recorded as an unresolved result, not an answer, and `wfa status` prints a `--bundle-repo` follow-up command preserving the original `wfa code` delivery contract. The inline source bundle takes precedence over the remote reference in this mode.
- Git state is inspected before sending a reference. Dirty/untracked files and local commits absent from remote-tracking refs are explicitly warned about; `--dry-run` includes `repository.dirtyFiles`, `repository.unpushedCommits`, `pushVerified`, `safeToReference`, and warnings. A remote reference cannot represent uncommitted changes. Run `git status` and push the relevant commits, or attach selected local sources, before treating remote inspection as authoritative.
- The `--bundle-repo` fallback first lists the tracked eligible directory tree and core entry points. It only includes a bounded source selection, prioritizing paths named in the request and entry points. Use repeatable `--file` and `--exclude` to supply a smaller set of relevant files rather than inlining a whole repository. A prompt above the 40 KiB guard is blocked by default.
- Directory recursion, quoted glob patterns, exclusions, image attachments and native document attachments remain available for projects without a repository, for `--no-repo`, and for the bundle fallback.
- `--dry-run` previews per-provider prompt bytes, attachment size, estimated tokens, prompt-size risk, block reasons and likely secret locations without creating a task or launching a provider. A prompt above 40 KiB per provider exits 2; `--allow-oversize` keeps it at 0, but upstream truncation can still corrupt results.
- A local task ledger records request IDs, provider states, conversation URLs, parent-task lineage, revisions and result paths.
- Uncertain sends are never automatically repeated. An unresolved provider/workspace is locked until the user collects or explicitly abandons the old task, except for failures that provably happened before submission (tab load failure, send-button failure, attachment upload timeout), which release the lock automatically. The single exception: a provider failing with the known pre-submit tab-closed error may be retried once as its own batch, with logs preserved as provider-specific retry files.
- ask-bridge progress lines are forwarded to stderr as `[ask-bridge stdout] …` while the batch is still running.
- Every completed answer carries `responseHeuristics` (Canvas stub, LaTeX/escape corruption) and, when relevant, `threadMismatch` — signals, never silent rewrites. Stage/apply now **refuse** corrupted LaTeX-escaped responses.
- Every independent task starts a **fresh conversation**. `--continue-session` opts back into per-workspace conversation reuse; `--followup` continues one verified task thread. A run that lands on the wrong conversation is flagged as `threadMismatch` and its URL is never saved for reuse.
- `--stall-timeout` (default 300 s; `0` disables) kills a batch that stops producing progress lines *and* stops advancing its metadata. The provider becomes `stalled` — blocking like an uncertain send, never auto-retried — instead of hanging until the full timeout. Already captured stdout/stderr and stalled evidence are retained.
- Results can be inspected and staged; writing staged code into the workspace requires an explicit `wfa apply --confirm` and SHA-256 revalidation. Stage supports complete `FILE:` blocks or exact `ANCHOR`/`REPLACE` blocks.
- WFA can continue an existing task conversation with `--followup`.
- ask-bridge remains an external tool; WFA adds no runtime npm dependency.

## Architecture

```text
Codex
  └─ one foreground or detached `wfa` CLI invocation
       └─ web-first-ask task ledger / idempotency / workspace sessions
            ├─ concurrency 1: WFA single-job batch worker (one after another)
            └─ concurrency 2..3: ask-bridge batch (multiple jobs)
                 └─ ask-bridge external executable
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

`wfa install-skill` copies `skills/web-first/SKILL.md` to `%USERPROFILE%\.codex\skills\web-first\SKILL.md`. Restart or refresh Codex Skill discovery afterward. The optional `--target` also installs to WorkBuddy or an explicit skills directory:

```powershell
wfa install-skill --target workbuddy
wfa install-skill --target 'H:\AI工作区\my-skills'
```

`codex` (default) means `~/.codex/skills`; `workbuddy` means `~/.workbuddy/skills`. The target directory always receives `web-first/SKILL.md` beneath it. Existing copies of that one Skill are replaced.

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

**Chrome crash-restore repair, built into WFA:** Before each ask-bridge batch or login launch, WFA scans ask-bridge's configuration directory for Chrome `Preferences` files. If `profile.exit_type` is exactly `Crashed`, WFA resets it to `Normal` and marks `exited_cleanly`, using an atomic file replacement. It leaves healthy and malformed profiles unchanged. `wfa doctor` reports the profile inspection and any repairs, and `wfa browser-mode` displays the repair status. WFA also trims `chrome-devtools-mcp.log` above 64 MiB down to its last 4 MiB. The old `wfa-chrome-restore-fix.mjs` external wrapper is no longer required. Never run profile repair concurrently with a Chrome instance that is writing its Preferences; finish/close that instance first.

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

Ask both providers for complete modified code. Inside a Git repository with a remote this is the whole request — no file arguments:

```powershell
wfa code `
  --workspace my-repository `
  --requirement "Fix the race in task recovery. Preserve existing idempotency and add focused regression coverage."
```

The providers receive a `REPOSITORY` block (https URL, branch, HEAD commit) and read the repository themselves. If one of them answers `REPO_UNREADABLE`, `wfa status` prints a fallback command that keeps **`wfa code` for code tasks**:

```powershell
wfa code --provider chatgpt --workspace my-repository --followup <task-id> `
  --bundle-repo --exclude 'docs/**' `
  --requirement "Use the inline source and complete the original implementation. Return full FILE: blocks."
```

This is a selective inline fallback, not an unlimited whole-repo copy: directory tree and entry points are supplied first; file contents are bounded by the prompt budget. Limit it further with `--file src/relevant.js` or `--exclude`, then check `--dry-run`. A bundled follow-up does **not** inject remote-reading instructions or reinterpret `REPO_UNREADABLE` as an answer classification.

Attach files explicitly only when there is no remote, when a provider asks for a specific file, or through the bundle fallback above:

```powershell
wfa code `
  --workspace my-repository `
  --no-repo `
  --requirement "Fix the race in task recovery." `
  --file .\src `
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

For large files a provider may give a narrowly scoped exact replacement instead of a complete file. The accepted format is:

````text
FILE: src/example.js
ANCHOR:
```js
const oldValue = 1;
```
REPLACE:
```js
const newValue = 2;
```
````

The `ANCHOR` must match exactly once, including surrounding lines. Missing and ambiguous anchors cause staging to fail. Paths such as `./src/example.js` are normalized safely; traversal, symlinks and protected repository metadata remain blocked. Stage/apply refuse responses with Gemini's `\vert{}`, `\lbrace`, `\rbrace` or `\textbackslash` pollution instead of applying corrupted code.

## Provider errors and recovery

`RATE_LIMITED`, `LOGIN_REQUIRED`, and `CLOUDFLARE_BLOCKED` are distinct actionable states. WFA shows a cooldown estimate or login/verification hint, but does not automatically retry or unlock an uncertain task. Inspect the task, reattach/collect if a response exists, or use explicit `wfa resolve --confirm` only after verifying the original generation is no longer active.

## Commands

| Command | Purpose |
|---|---|
| `wfa ask` | One or both providers; ChatGPT + Gemini by default, serially |
| `wfa compare` | Same prompt to multiple providers, serially by default |
| `wfa code` | Ask for complete implementation code; a Git remote replaces local file selection |
| `wfa wait <task-id>` | Observe task state; adopts only verified results and never resends |
| `wfa attach <task-id>` | Read-only reattachment to a saved task ID |
| `wfa result <task-id>` | Read a saved provider result |
| `wfa stage <task-id>` | Create a non-destructive code staging preview |
| `wfa apply <task-id> --confirm` | Apply a reviewed staging manifest after hash revalidation |
| `wfa status <task-id>` | Inspect task and recoverable provider states |
| `wfa list` | List recent tasks, refreshing pending work |
| `wfa collect <task-id> --provider chatgpt` | Return an already verified/saved result; no extra browser request |
| `wfa collect <task-id> --provider chatgpt --confirm-complete` | Manual recovery via `ask-bridge get` only without trusted terminal batch artifacts |
| `wfa resolve <task-id> --provider chatgpt --confirm` | Unlock an unresolved provider after confirming its generation stopped |
| `wfa login --provider <provider>` | Interactive provider login |
| `wfa doctor` | Check Node.js, ask-bridge and Chrome profile recovery |
| `wfa browser-mode [headless\|headful]` | Show or save default browser mode and repair status |
| `wfa install-skill [--target …]` | Install the Skill to Codex, WorkBuddy or a chosen directory |
| `wfa upstream update` | Run ask-bridge's official update command |

Use `--json` for machine-readable summaries. Reuse `--request-id` only when recovering the **exact same logical request with identical prompt, providers, attachments and options**. A changed request must use a new request ID.

`ask`, `compare` and `code` exit with 0 when all selected providers complete. An incomplete request exits with 1 and still prints its task summary, including any completed result files. Successful `status` and `list` lookups exit with 0 independently of the state they report.

## Multi-provider behavior

- `wfa ask`, `wfa compare` and `wfa code` default to **ChatGPT + Gemini**. `--provider <name>` narrows to one; `--providers 'a,b,c'` selects explicitly.
- Each provider gets an independent ask-bridge batch job. With `--concurrency 1` WFA calls separate single-job processes sequentially, avoiding U10. For `--detach` a detached WFA worker performs the sequence; it writes per-provider stdout/stderr logs and a persistent task state.
- Jobs run **serially by default** (`--concurrency 1` → `defaultConcurrency` in config). Concurrent tabs interfere with each other on the same machine, and the serial default keeps a two-provider run reliable.
- `--concurrency 2` or `3` runs jobs in parallel when the machine tolerates it, validated against `maxConcurrency` (default 3).
- When a job returns the *provably pre-submit* `list_pages failed: The selected page has been closed` error, WFA retries **that job alone once**. Its stdout/stderr are written to `batch.stdout.<provider>.retry.log` and `batch.stderr.<provider>.retry.log` and consulted by subsequent status refreshes. Submitted/uncertain sends are never retried.
- **Repository first.** When the working tree is a Git repository with a remote, every prompt carries a `REPOSITORY` block (https URL, branch, HEAD commit) and the providers read it themselves. `--repo-url` overrides detection, `--no-repo` disables it and `--bundle-repo` uses authoritative inline material instead.
- **One task, one conversation.** Each independent task starts a fresh provider conversation. `--continue-session` opts into the per-workspace saved URL; `--followup` continues one verified task thread. `sessionPolicy` and `threadMismatch` are recorded, and a mismatched URL is never saved for reuse.
- A provider that stops producing progress and stops advancing metadata for `--stall-timeout` seconds (default 300) is killed and recorded as `stalled`, which blocks the workspace like an uncertain send until `wfa collect` or `wfa resolve`.
- The same prompt and attachments are sent independently to every selected provider; no provider sees another provider's answer.
- Results are stored separately, for example `.../ask-bridge-output/wfa-chatgpt-<id>/response.md` and `.../wfa-chatgpt-<id>/metadata.json`.
- Codex compares the answers and makes the final decision. It must not blindly merge or trust any provider.

## Known issues

`docs/known-issues.md` is the upstream-facing list (U1–U10) of defects measured against ask-bridge 0.4.0, with reproduction, expectation and impact per item: Gemini attachment uploads timing out, prompts above roughly 44 KiB being truncated without a signal, ChatGPT long answers landing in Canvas instead of `response.md`, `--new-session` still reusing an open tab, Gemini escaping Markdown diffs, unstable concurrent tabs, Chrome `exit_type=Crashed` restore bubble, missing log rotation, the absence of a `submissionState`, and a serial batch closing the previous job's tab. Each item is tagged with WFA's current workaround, never an upstream fix. Read it before sending large context or relying on provider-side isolation.

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
- A local process watchdog allows the ask-bridge per-job timeout plus a 3-minute cleanup margin; if it fires, the task remains unresolved unless completed artifacts can be verified.
- The same workspace/provider is locked while a previous task is unresolved.
- Ask-bridge batch completion is trusted only when `metadata.json` has the expected job ID and provider, `state: completed`, and a stable, non-empty UTF-8 `response.md`. WFA records hashes for both artifacts and verifies them again before reading or staging the result.
- `wfa collect` returns a verified batch result idempotently without `--confirm-complete` and without calling `ask-bridge get`. The flag remains required only for manual recovery when no trusted terminal artifact exists.
- A completed per-provider result may be read while ask-bridge finishes batch cleanup, but the workspace/provider lock remains active until the owning process exits.
- `resolve` requires `--confirm`; use it only after confirming the old generation has stopped.
- Provider output is untrusted input. Codex must validate code, run tests and inspect actual diffs before accepting it.

## Upstream dependency

The integration is based on ask-bridge's `batch` JSONL interface and per-job `metadata.json` / `response.md` artifacts. The current reviewed upstream source is recorded in [`docs/UPSTREAM.md`](docs/UPSTREAM.md). This project intentionally does not copy or fork ask-bridge source.

Run `wfa upstream update` to invoke the upstream's official updater. Then run `wfa doctor` and smoke tests. Do not update ask-bridge during an active task.

## Development

```powershell
npm test
npm run check
```

No runtime npm dependencies are required. CI runs Node's built-in test runner on Windows and Ubuntu.

## Detached tasks and safe reattachment

Use `wfa ask --detach ...` to start ask-bridge with task-specific stdout/stderr logs and return the task ID after the OS confirms launch. For a serial multi-provider run the detached process is WFA's own coordinating worker; it starts one upstream process per provider. The task ID and original request ID are persisted; detached work is never auto-resubmitted.

```powershell
wfa ask --workspace my-repository --prompt "Review the design" --detach
wfa wait <task-id> --timeout 300
wfa attach <task-id> --timeout 0
# Return a saved result; verified batch terminal metadata needs no extra confirmation:
wfa collect <task-id> --provider chatgpt
# Only for manual recovery when there is no trusted terminal artifact:
wfa collect <task-id> --provider chatgpt --confirm-complete
```

`wait` and `attach` do not call `ask-bridge get`, do not infer completion from repeated text, and never resend a task. They automatically adopt a per-provider result only when ask-bridge has atomically written matching terminal metadata (`id`, `provider`, `state: completed`) after the non-empty `response.md` artifact. WFA records and rechecks both artifact hashes. For completed full-file code results, `wfa wait <task-id> --stage` can create a non-destructive staging copy; only `wfa apply --confirm` writes code to the workspace.

If the detached process exits without trustworthy metadata and response.md, the task remains `interrupted_unknown` and is **not** automatically retried or collected. Use `wfa status` and inspect the saved browser conversation. `--confirm-complete` is available for this explicit manual recovery path. No external session-manager dependency is required.
