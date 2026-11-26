# Web-First Ask (WFA)

When the user names `wfa` (or delegates to ChatGPT / Gemini / Claude via browser), invoke `wfa` directly without over-thinking: the local agent must not answer the delegated question itself or replace the provider's conclusion.

## Commands

- `wfa send --provider <chatgpt|gemini|claude> --prompt "<prompt>" --json` — submit once, return task handle.
- `wfa read --task-id <id> --wait <seconds> --json` — read-only poll until `completed`.
- `wfa read --url <conversation-url> --wait <seconds> --json` — read an existing conversation without sending.
- `wfa cdp ask [--provider <chatgpt|gemini|claude> | --providers chatgpt,gemini] [--gemini-mode task|chat] [--code-task] [--file <path>] [--download-dir <dir>] [--cleanup | --no-cleanup] [--fallback-bundle] [--no-debug] --prompt "<prompt>"` — blocking ask (omitting `--provider` defaults to `chatgpt,gemini`; new Gemini sessions default to `task`).
- `wfa cdp extract (--input <file> | --task-id <id>) --out-dir <dir>` — integrity-checked `FILE:` extraction.
- `wfa cdp cleanup (--task-id <id> | --all | --keep-unfinished [--keep-named])` — delete conversations created by `wfa` (reuses a single tab).
- `wfa cdp log-issue --repro "<steps>" [--command "<cmd>"] [--provider <p>] [--task-id <id>]` — append reproduction steps to `<wfa-home>/debug-issues.md`.

## States

- `completed`: final answer; return faithfully.
- `pending` / `queued` / `running` / `thinking` / `streaming` / `stalled`: continue calling `wfa read --task-id <id>`; never treat partial text or `--wait` timeout as failure or resend authorization.
- `unconfirmed` / `tab_missing` / `failed` / `needs_user` / `needs_human`: stop and report; never auto-resend.

## Hard Rules

- **Debug mode is ON by default**: whenever `wfa` fails or behaves unexpectedly, record **only how to reproduce it** via `wfa cdp log-issue --repro "<steps>"` (saved to `<wfa-home>/debug-issues.md`; failed commands are also auto-logged unless `--no-debug` / `WFA_DEBUG=0`). **Do not attempt to fix or modify `wfa` itself.**
- For any task that modifies code, **always attach a repository bundle** (`--code-task` or `--file <git-bundle|zip>`) and instruct the provider to run `git apply --check` and full `npm test` (see `docs/provider-capabilities.md`).
- Submit once; poll by returned `taskId`.
- `read` is strictly read-only (no typing, clicking, submitting, closing tabs, deleting conversations, or retrying).
- If a provider asks about local context, the local agent answers it first; if a decision is uncertain, ask the user instead of guessing.
- Clearly separate any requested local analysis from the provider's original answer.
