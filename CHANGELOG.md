# Changelog

## 0.1.1 — Reliable recovery and exit status

- Preserve the latest successful provider session when inspecting historic tasks or resolving failed follow-ups.
- Return a nonzero exit code for incomplete requests while keeping the task summary and any completed results.
- Keep uncertain submissions recoverable after post-launch process errors.
- Coordinate upstream updates with new task launches.
- Quote provider lists in PowerShell examples so they reach the npm CLI shim as a single argument.

- Disable provider reasoning-strength selection in WFA. Requests use each provider's current web UI setting; model selection, parallel execution and task recovery remain available.
- Bound the local ask-bridge stdio drain after the child process exits, so inherited descendant handles cannot keep `wfa ask` waiting indefinitely. Preserve captured output and record when the drain grace period is used.

## 0.1.0 — Initial project package

- Added local `wfa` CLI backed by the independently installed ask-bridge executable.
- Added single-provider ask, concurrent multi-provider compare and complete-code delegation modes.
- Added workspace/provider session persistence, task ledger, request fingerprinting and duplicate-send protection.
- Added fail-closed handling for timed-out, recoverable and interrupted tasks.
- Added explicit response collection and manual task-abandon controls.
- Added the single Codex `web-first` Skill and Windows/Ubuntu CI.
