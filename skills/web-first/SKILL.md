# Web-First Ask (WFA)

Use WFA when the user explicitly delegates a question or task to ChatGPT or Gemini through the browser.

## Commands

- `wfa send --provider <chatgpt|gemini> --prompt "<prompt>" --json`
  - Submit once and return a task handle without waiting.
- `wfa read --task-id <id> --wait <seconds> --json`
  - Read the task's current state and answer. Repeat only while the state says to continue.
- `wfa read --url <conversation-url> --wait <seconds> --json`
  - Read an existing provider conversation without sending anything.
- `wfa cdp ask --provider <chatgpt|gemini> --prompt "<prompt>"`
  - Submit and wait for the normal blocking result.

`wfa send` returns an `id`, `requestId`, `state`, and a fixed `poll` command. Use that ID with `wfa read`; do not submit the prompt again.

## State handling

| State | Required action |
|---|---|
| `completed` | The answer is final. Use the returned text. |
| `pending` | Continue reading the same task. |
| `queued` / `running` | Continue reading the same task. |
| `thinking` / `streaming` | Continue reading the same task. |
| `stalled` | Continue reading the same task; its text is not a final answer. |
| `unconfirmed` | Stop and tell the user completion could not be confirmed. Do not present the text as final. |
| `needs_user` | Ask the user to complete the required login, verification, or provider-side action. |
| `tab_missing` | Report that the provider tab is missing. Do not resend. |
| `failed` | Report the failure. Do not resend automatically. |
| `needs_human` | Stop and request human intervention. |

A `--wait` timeout is only the end of the current observation window. It does not mean the provider failed, and it never authorizes resubmission.

## Hard constraints

- If the user explicitly specifies WFA, the local agent must not answer the delegated question itself or rewrite, reinterpret, or replace the provider's conclusion.
- Submit a prompt once. Use the returned task ID to read the same task.
- `read` is read-only: do not type, click, submit, activate a tab, close a tab, delete a conversation, retry, or switch conversations.
- Only `completed` is a final answer. Never treat partial text, `stalled`, or `unconfirmed` as completion.
- Preserve the provider's answer faithfully. Clearly separate any requested independent analysis from the provider's original answer.
