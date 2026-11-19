# Contributing

## Scope

Keep this repository a small local CLI + one Codex Skill that orchestrates the independently maintained ask-bridge executable.

Do not:
- add a Codex-facing MCP server or compatibility layer;
- copy or vendor ask-bridge browser-control code;
- add a second browser automation engine;
- automatically resend an uncertain prompt;
- write provider-generated code directly into a user's target repository.

## Development

Requirements: a supported Node.js version from `package.json`.

```powershell
npm test
npm run check
```

Add focused regression tests for changed behavior. Keep runtime dependencies at zero unless there is a concrete, reviewed need.

## Upstream changes

Before changing the integration:
1. Read the current ask-bridge `batch` CLI and `src/batch.rs` contract.
2. Update `docs/UPSTREAM.md` with the reviewed commit and any schema/behavior changes.
3. Keep unknown metadata states fail-closed.
4. Run the test suite and the two-provider mocked CLI smoke test.
5. Do not claim live browser validation unless a real ask-bridge + Chrome + provider run was performed.

## Skill behavior

The Skill must continue to request complete replacement file contents for implementation tasks. Do not regress to plan-only or diff-only code delegation. Preserve parallel multi-provider consultation.
