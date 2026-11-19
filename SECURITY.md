# Security and local data

`web-first-ask` is a local orchestration wrapper. It does not upload prompts or task metadata to a web-first-ask service.

The local state directory contains:
- batch JSONL input (full prompts and local attachment paths);
- provider result Markdown;
- task metadata and conversation URLs;
- short ask-bridge stdout/stderr diagnostics.

Protect the directory as user data. web-first-ask-created task/session JSON and batch-input JSONL files are created with mode `0600` on POSIX systems where supported. On Windows, normal inherited user ACLs apply. Response and metadata artifacts written by ask-bridge follow the upstream program's file-creation permissions.

Do not attach:
- passwords, API keys, session cookies, OAuth tokens, private keys or recovery codes;
- personal data not required for the task;
- confidential legal/arbitration material or other sensitive local-only material;
- unrelated private source files.

The task ledger stores a SHA-256 payload fingerprint rather than duplicating the prompt. The JSONL run input still contains the prompt because ask-bridge reads that file.

`collect` and `resolve` are explicit human-confirmation operations. A timeout or lost process never triggers a new submission automatically.
