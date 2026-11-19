# Package manifest — web-first-ask 0.1.0

This archive is the complete source tree intended to become the root of a new Git repository (suggested repository: `jmwangde3/web-first-ask`).

## Included

- Executable Node.js CLI: `bin/wfa.js`
- Task orchestration, idempotency, persistence, provider sessions and recovery: `src/`
- One Codex Skill: `skills/web-first/SKILL.md`
- Automated tests: `tests/`
- Windows/Ubuntu GitHub Actions workflow: `.github/workflows/test.yml`
- Repository rules, docs, changelog and MIT license

## Deliberately excluded

- No MCP server or Codex MCP compatibility entry point.
- No vendored/forked ask-bridge source.
- No second browser automation implementation.
- No code that automatically applies provider-generated source files to a target repository.
- No secrets, local task data, browser profiles or provider credentials.

## Local validation performed for this package

- `npm test`: 15 tests passed, 0 failed.
- `npm run check`: passed.
- `node --check` over all source, test and bin JavaScript files: passed.
- Local npm global-install smoke test: passed.
- `wfa doctor` against a mock ask-bridge executable: passed.
- Two-provider `wfa code --providers chatgpt,gemini` smoke test against a mock ask-bridge batch executable: passed; independent result artifacts and session URLs were persisted.

## Not yet performed

- No real Chrome session or logged-in ChatGPT/Gemini/Claude account was used in this validation.
- No real provider generation or Windows desktop end-to-end test has been run.
- GitHub Actions have not yet run on the destination repository.

The upstream integration contract was source-reviewed against ask-bridge commit `7d4731f60f300f7cf3b98a5a92137144a17f98e9`; see `docs/UPSTREAM.md`.
