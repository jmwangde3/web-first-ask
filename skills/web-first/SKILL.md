# Web-First Ask (WFA)

When the user names `wfa` (or delegates to ChatGPT / Gemini / Claude via browser), invoke `wfa` directly without over-thinking: the local agent must not answer the delegated question itself or replace the provider's conclusion.

## Commands

- `wfa send --provider <chatgpt|gemini|claude> --prompt "<prompt>" --json` — submit once, return task handle.
- `wfa read --task-id <id> --wait <seconds> --json` — read-only poll until `completed`.
- `wfa read --url <conversation-url> --wait <seconds> --json` — read an existing conversation without sending.
- `wfa cdp ask --provider <chatgpt|gemini|claude> [--gemini-mode chat|task] [--providers chatgpt,gemini] [--file <path>] [--download-dir <dir>] [--cleanup] --prompt "<prompt>"` — blocking ask.

## States

- `completed`: final answer; return faithfully.
- `pending` / `queued` / `running` / `thinking` / `streaming` / `stalled`: continue calling `wfa read --task-id <id>`; never treat partial text or `--wait` timeout as failure or resend authorization.
- `unconfirmed` / `tab_missing` / `failed` / `needs_user` / `needs_human`: stop and report; never auto-resend.

## Hard Rules

- Submit once; poll by returned `taskId`.
- `read` is strictly read-only (no typing, clicking, submitting, closing tabs, deleting conversations, or retrying).
- Clearly separate any requested local analysis from the provider's original answer.
