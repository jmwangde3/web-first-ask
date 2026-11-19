# web-first-ask

**Codex-first CLI + Skill for delegating thinking and complete code implementation to ChatGPT Web, with optional parallel Gemini/Claude comparison.**

`web-first-ask` (`wfa`) is a local Node.js CLI that calls the independently maintained [`ask-bridge`](https://github.com/doggy8088/ask-bridge) executable. It explicitly selects ask-bridge's `browser` backend because its Batch command does not support SIWC. It does not expose an MCP server to Codex and does not reimplement browser automation.

- Codex calls one local command and waits while `ask-bridge batch` performs its own browser-side polling.
- ChatGPT is the default provider. WFA does not set or change provider reasoning strength; it uses the current setting in the provider web UI.
- `wfa compare` sends the same prompt and attachments to multiple providers concurrently, then saves each answer separately.
- `wfa code` asks for **complete replacement contents of changed files**, not an implementation plan or diff-only response.
- A local task ledger records request IDs, provider states, conversation URLs and result paths.
- Uncertain sends are never automatically repeated. An unresolved provider/workspace is locked until the user collects or explicitly abandons the old task.
- ask-bridge is not vendored. Update it independently with its official updater.

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

Ask ChatGPT (default) and continue the stable workspace conversation:

```powershell
wfa ask --workspace my-repository --prompt-file .\question.md
```

Ask a specific provider:

```powershell
wfa ask --provider gemini --workspace my-repository --prompt "Review this error and identify the likely cause."
```

Ask ChatGPT and Gemini **at the same time**:

```powershell
wfa compare --providers chatgpt,gemini --workspace my-repository --prompt-file .\question.md
```

Include Claude too:

```powershell
wfa compare --providers chatgpt,gemini,claude --workspace my-repository --prompt-file .\question.md
```

Ask ChatGPT for complete modified code, attaching complete relevant source and test files:

```powershell
wfa code `
  --workspace my-repository `
  --requirement "Fix the race in task recovery. Preserve existing idempotency and add focused regression coverage." `
  --file .\src\core\tasks.js `
  --file .\src\core\locks.js `
  --file .\test\tasks.test.js
```

Compare complete code implementations from ChatGPT and Gemini in parallel:

```powershell
wfa code `
  --providers chatgpt,gemini `
  --workspace my-repository `
  --requirement "Implement the requested behavior. Return complete replacement contents for every changed file, not a plan or diff." `
  --file .\src\feature.js `
  --file .\test\feature.test.js
```

For provider-specific model selection in a parallel run, use `--model-map chatgpt=<model>,gemini=<model>`. Reasoning-strength selection is intentionally not managed by WFA. `--download-images` enables downloading generated images; it is off by default.

The answers are saved separately under the local data directory. Codex should read the returned files, review them, apply the chosen implementation, and run tests. `wfa` never writes provider-generated code into the target repository automatically.

## Commands

| Command | Purpose |
|---|---|
| `wfa ask` | One provider; ChatGPT by default |
| `wfa compare` | Same prompt to multiple providers concurrently |
| `wfa code` | Build a strict full-file implementation prompt |
| `wfa status <task-id>` | Inspect task and recoverable provider states |
| `wfa list` | List recent tasks |
| `wfa collect <task-id> --provider chatgpt --confirm-complete` | Read the latest response from a conversation after you independently confirmed generation is complete |
| `wfa resolve <task-id> --provider chatgpt --confirm` | Unlock an unresolved provider only after confirming its old generation is no longer active |
| `wfa login --provider <provider>` | Interactive provider login |
| `wfa doctor` | Check Node.js and ask-bridge batch availability |
| `wfa install-skill` | Install the single Codex Skill |
| `wfa upstream update` | Run ask-bridge's official update command |

Use `--json` for machine-readable summaries. Reuse `--request-id` only when recovering the **exact same logical request with identical prompt, providers, attachments and options**. A changed request must use a new request ID.

## Multi-provider behavior

- `wfa compare` and `wfa code --providers ...` create one ask-bridge batch job per provider.
- Jobs run concurrently by default (`concurrency = provider count`) and each gets its own tab and output directory.
- Each provider has a separate saved conversation URL per workspace.
- The same prompt and attachments are sent independently to every selected provider; no provider sees another provider's answer.
- Results are stored separately, for example `.../ask-bridge-output/wfa-chatgpt-<id>/response.md` and `.../wfa-chatgpt-<id>/metadata.json`.
- Codex compares the answers and makes the final decision. It must not blindly merge or trust any provider.

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
- `collect` requires `--confirm-complete`; ask-bridge `get` reads the latest message but does not itself prove generation has finished.
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
