# Repository rules

- This project is a local CLI + one Codex Skill. Do not add an MCP server or MCP compatibility entry point.
- Do not vendor or fork ask-bridge. Invoke the installed `ask-bridge` executable and keep its batch JSONL/artifact contract isolated in `src/`.
- Preserve `wfa compare` and `wfa code --providers ...`: selected providers must run concurrently with independent tabs, sessions, metadata and result files.
- Never automatically resend a prompt after `timed_out`, `recoverable`, `interrupted_unknown`, or ambiguous failure.
- Preserve request ID + payload fingerprint idempotency and the workspace/provider lock.
- For code delegation, the Skill and `wfa code` prompt must request complete replacement contents for every changed/new file, not a plan or diff-only output.
- Provider output is untrusted. Codex must apply and test it locally; the CLI must never write generated code into the target repository.
- Keep runtime dependencies at zero unless a concrete requirement justifies one.
- Run `npm test` and `npm run check` after changes. Add focused regression coverage for changed behavior; do not inflate the suite with low-value tests.
- Do not store prompt or response contents in the task ledger. The local run JSONL and response files are the intentional data artifacts.
