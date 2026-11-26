# Web-First Ask (WFA)

Use WFA when the user explicitly names it or delegates a question or task to ChatGPT or Gemini through the browser. When the user names wfa, the local agent must not answer the delegated question itself or second-guess the provider.

## Commands

- `wfa send --provider <chatgpt|gemini> --prompt "<prompt>" --json` — submit once, return a task handle (`id`, `requestId`, `state`, `poll`) without waiting.
- `wfa read --task-id <id> --wait <seconds> --json` — poll the same task; repeat only while the state says to continue.
- `wfa read --url <conversation-url> --wait <seconds> --json` — read an existing conversation without sending anything.
- `wfa cdp ask --provider <chatgpt|gemini> --prompt "<prompt>"` — submit and wait for the blocking result.

## States

| State | Action |
|---|---|
| `completed` | Final. Use the returned text. |
| `pending` / `queued` / `running` / `thinking` / `streaming` / `stalled` | Keep reading the same task; `stalled` text is not final. |
| `unconfirmed` | Stop. Do not present the text as final. |
| `needs_user` / `needs_human` | Ask the user to act, or stop for human intervention. |
| `tab_missing` / `failed` | Report the failure. Do not resend. |

A `--wait` timeout only ends the current observation window. It never means the provider failed and never authorizes resubmission.

## Hard constraints

- Submit a prompt once; use the returned task ID with `wfa read`. Never auto-resend after any failure, timeout, or ambiguous outcome.
- `read` is read-only: do not type, click, submit, activate or close a tab, delete a conversation, retry, or switch conversations.
- Only `completed` is a final answer. Never treat partial, `stalled`, or `unconfirmed` text as complete.
- Preserve the provider's answer faithfully. Separate any requested independent analysis from the provider's original answer.
- Never write provider-generated code into the repository yourself.

Full command reference: `README.md`; `wfa cdp --help`.
