# ask-bridge integration contract

## Reviewed upstream snapshot

- Repository: https://github.com/doggy8088/ask-bridge
- Branch: `main`
- Reviewed commit: `7d4731f60f300f7cf3b98a5a92137144a17f98e9`
- Reviewed Cargo package version: `0.4.0`
- Integration points: `src/main.rs` (`Commands::Batch`) and `src/batch.rs` (`RawJob`, `JobSpec`, `run_batch_command`, per-job artifacts).

This is a source-review baseline, not a promise that future upstream versions keep the same interface. `wfa doctor` checks that the installed executable exposes `batch --help`. Runtime metadata validation is fail-closed.

## Batch input

One JSON object per line. Fields used by web-first-ask:

```json
{
  "id": "wfa-chatgpt-12345678",
  "provider": "chatgpt",
  "prompt": "Complete request text",
  "timeout": 1200,
  "session": "https://chatgpt.com/c/...",
  "files": ["C:/repo/src/file.js"],
  "images": [],
  "downloadImages": false,
  "model": "optional provider model",
  "reasoning": "high"
}
```

Optional properties are omitted when not configured. `session` is omitted for a new conversation. `temporary` is intentionally not used with `session`.

The upstream currently accepts `chatgpt`, `gemini` and `claude`. Gemini image attachments are not supported by batch; document `files` are used instead.

## Invocation

```text
ask-bridge --backend browser batch --input <JSONL> --concurrency <N> --output-dir <DIR>
```

`wfa` forces `--backend browser` even if the user's ask-bridge global config selects SIWC. The current upstream explicitly does not support `batch` with `--backend siwc`; this project requires browser sessions and provider web UI behavior.

The upstream validates the entire JSONL batch before Chrome startup. Each job uses its own tab and output directory. Concurrent jobs targeting the same existing conversation are rejected.

## Artifacts

For job ID `<id>` under output directory `<out>`:

- `<out>/<id>/metadata.json`
- `<out>/<id>/response.md`
- optionally `<out>/<id>/images/`

Metadata state values observed in the source:

- `completed`
- `failed`
- `timed_out`
- `recoverable`
- `cancelled`
- provisional `in_progress`

Metadata fields include `id`, `provider`, `pageId`, `threadUrl`, `state`, `elapsedSeconds`, `error` and `note`.

`wfa` trusts `completed` only when a non-empty `response.md` exists. Provisional `in_progress`, missing metadata and unknown states become `interrupted_unknown`. No ambiguous state is automatically resent.

## Known limits

1. Batch has no documented resume-by-job-ID command. `wfa` does not pretend it can resume a timed-out job automatically.
2. The upstream `get <url>` command retrieves the latest response but does not prove generation has completed. `wfa collect` therefore requires explicit `--confirm-complete`.
3. The batch worker closes tabs for terminal states other than `recoverable`; a timed-out job may need the saved conversation URL reopened by `get`.
4. Browser automation inside ask-bridge currently uses `chrome-devtools-mcp`. Codex does not connect to MCP, but the upstream implementation internally does.
5. Upstream may change JSONL fields, artifact names or exit behavior. After `wfa upstream update`, run `wfa doctor` and the smoke tests before using it for production tasks.

## Update policy

- No automatic background update.
- Update only when no task is active:
  `wfa upstream update`
- Then:
  `wfa doctor`
- For a release candidate, run one short request and one two-provider compare before relying on the new upstream version.
