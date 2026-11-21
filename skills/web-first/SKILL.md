---
name: web-first
description: Default web-first reasoning and complete-code delegation workflow for local coding agents. Use ChatGPT Web through the local wfa CLI for nontrivial requirements, research, architecture, debugging and especially code design/implementation. Coding requests must ask ChatGPT for complete modified file contents, not a plan or diff-only response. Supports parallel ChatGPT/Gemini/Claude consultation and independent comparison.
---

# Web-First

## Core role split

- **ChatGPT Web is the default reasoning and implementation partner** for nontrivial engineering work: requirements, root-cause analysis, technical decisions, architecture, debugging and code changes.
- **You (the local coding agent) are the execution owner**: inspect the actual repository, collect complete source evidence, call `wfa`, review returned code, edit local files, run tests, inspect diffs and report verified results.
- Do not expose or configure an MCP server for this workflow. Call `wfa` directly as a local CLI.
- Default provider is ChatGPT. WFA does not set or change provider reasoning strength; the current setting in the provider web UI is used.
- Do not delegate trivial one-line changes or tasks that need no meaningful reasoning.

## Mandatory behavior for code-design and implementation tasks

When the user asks to implement, fix, refactor, optimize or add code, **do not ask ChatGPT merely for a plan, checklist or proposed diff**. Ask it to produce the actual modified code.

### Before calling ChatGPT

1. Inspect `git status`, the relevant source files, callers, types/interfaces, configuration and focused tests.
2. Identify the smallest complete set of files ChatGPT needs. Attach whole files, not isolated snippets. Include call sites and tests where they constrain behavior.
3. Do not attach the whole repository indiscriminately. Do not send secrets, credentials, tokens, private keys, personal data, or sensitive legal/arbitration materials.
4. Write a precise requirement that states behavior, invariants, compatibility constraints and known evidence. Distinguish observed facts from hypotheses.
5. Use a stable workspace key derived from the repository name so the provider conversation can continue across tasks.

### Preferred command

Use `wfa code` and attach the complete files:

```powershell
wfa code `
  --workspace <repository-key> `
  --requirement "<precise implementation requirement>" `
  --file <complete-source-file> `
  --file <caller-or-interface-file> `
  --file <focused-test-file>
```

The command builds a strict prompt asking ChatGPT to return:

- `FILE: relative/path` for each changed or new file;
- the **complete contents** of each file, ready to save;
- complete tests and required config changes;
- no diff-only answer, no ellipses, no "rest is unchanged", no pseudocode and no placeholder implementation.

Do not replace `wfa code` with `wfa ask` for a code implementation request unless the user explicitly asks only for a review or explanation.

### After receiving code

1. Read the saved provider result file(s).
2. Verify every returned path against the real repository and the attached source version.
3. Apply the code locally. ChatGPT does not modify the local repository.
4. Resolve inconsistencies and verify imports, callers, types, platform behavior and error paths.
5. Run focused tests and only the additional tests that provide new evidence.
6. Inspect `git diff` and `git status`. Do not claim tests passed unless they were run locally.
7. If ChatGPT omitted a required complete file or invented unavailable interfaces, do not fill gaps by guessing. Gather the missing complete source and make one focused follow-up request.

## General analysis and research

For non-code analysis, use:

```powershell
wfa ask --workspace <repository-key> --prompt-file <prompt-file>
```

Attach relevant files with repeated `--file` arguments. Ask for a direct conclusion, evidence, uncertainty and practical implications. Keep the request focused.

## Parallel multi-provider consultation

Preserve and use the multi-provider comparison capability when:

- the user explicitly requests multiple providers;
- an independent second implementation/review materially reduces risk;
- the task has a meaningful design uncertainty that benefits from independent answers.

Use:

```powershell
wfa compare --providers 'chatgpt,gemini' --workspace <repository-key> --prompt-file <prompt-file>
```

For independent code implementations:

```powershell
wfa code --providers 'chatgpt,gemini' --workspace <repository-key> `
  --requirement "<same precise implementation requirement>" `
  --file <complete-source-file> --file <focused-test-file>
```

The same prompt and attachments are sent independently and concurrently. Each provider has its own conversation and result file. Do not send one provider's answer to another unless explicitly doing a second-round critique. The local agent compares the results, identifies agreement and disagreement, selects or synthesizes the best implementation, then verifies it locally. Do not automatically fan out every routine task; avoid unnecessary provider cost.

If concurrent browser sessions interfere with each other on this machine, serialise the same batch instead of running two commands:

```powershell
wfa compare --providers 'chatgpt,gemini' --concurrency 1 --workspace <repository-key> --prompt-file <prompt-file>
```

`--concurrency 1` keeps one batch, one set of result files and the same comparison semantics; only the wall-clock time changes. Do not work around interference by launching two separate `wfa` processes against different workspaces.

Default comparison set is ChatGPT + Gemini. Claude is available when explicitly selected:

```powershell
wfa compare --providers 'chatgpt,gemini,claude' ...
```

## Waiting and recovery

- Run one foreground `wfa` command and let the local CLI/ask-bridge process wait for the provider. Do not create a 30-second `wfa status` or `wfa ask` polling loop.
- `wfa` prints a task ID before waiting and persists it locally.
- A nonzero exit from `ask`, `compare` or `code` can still include completed provider results. Read the task summary and use successful result files before deciding how to recover the unfinished providers.
- If the terminal tool returns while the process is still running, inspect `wfa status <task-id>` once when needed. If it is still running, do not submit again.
- `timed_out`, `recoverable`, `interrupted_unknown` and ambiguous `failed` states may mean the prompt was already submitted. Never resend automatically.
- A `WORKSPACE_PROVIDER_LOCKED` error is not a transient failure. Read the task ID it names, run `wfa status <task-id>` once, and either collect the result or, after confirming the generation is dead in the browser, `wfa resolve <task-id> --provider <provider> --confirm`.
- `--new-session` does not bypass the lock. A request that may already have reached the provider stays blocking on purpose; a resend into an uncertain conversation is worse than an explicit resolve.
- Failures that provably happened before submission — the tab never loaded, the send button never became enabled, or a Gemini attachment upload timed out — release the lock automatically. Do not spend a `wfa resolve` on them; just fix the cause and retry.
- Progress now streams: `[ask-bridge stdout] …` lines appear on stderr while the batch runs. Use them to decide whether the provider is working, and do not treat prolonged silence as failure while the process is alive.
- If ask-bridge writes matching terminal `completed` metadata and a complete `response.md`, WFA automatically adopts the saved result during task refresh. Use `wfa collect <task-id> --provider <provider>` to return that result without another browser request or confirmation.
- If no trusted terminal artifact exists, `wfa collect --confirm-complete` uses ask-bridge `get` as a manual recovery path. Independently confirm in the browser that generation has stopped first, because `get` itself does not establish completion.
- If the old generation is definitely no longer active and cannot be collected, unlock it only with:
  `wfa resolve <task-id> --provider <provider> --confirm`
- Reuse the same `request_id` only for an identical request. A changed prompt or attachment set is a new logical request and needs a new request ID.

## Session rules

- Use the same `--workspace` key for the same repository/project. Each provider has its own saved conversation URL for that workspace.
- New tasks continue the provider's saved conversation by default.
- Use `--new-session` only when isolation is intentional (for example, an independent second opinion).
- `--new-session` only stops WFA from supplying a saved conversation URL. The current ask-bridge build can still reuse an already open provider tab, so isolation is not guaranteed. Verify it: check that the answer addresses this prompt, not the previous one, and compare the returned conversation URL with the previous task's. If the provider answers an older question, treat that whole task as void and rerun it under a different workspace key.
- Parallel provider jobs use separate tabs and separate provider conversations; never point two concurrent jobs at the same conversation.

## Provider known limits

Measured against ask-bridge 0.2.1; full evidence and reproductions are in `docs/known-issues.md` of the `web-first-ask` repository.

- **Gemini attachments do not work.** Any `--file` request to Gemini fails after 50–60 s with `ATTACHMENT_UPLOAD_TIMEOUT`. Inline the content in the prompt instead, and keep it under 40 KiB.
- **Prompts over roughly 44 KiB are truncated without a signal.** This is the most dangerous failure mode: the answer looks normal and arrives faster. Always run `--dry-run` first and treat exit 2 as a stop sign.
- **ChatGPT long answers may land in Canvas.** When the response is replaced by a download link plus a hash, `response.md` does not contain the artifact. Ask for smaller chunks, or request the content to be repeated inline in the chat.
- **Gemini corrupts Markdown diffs.** `||` becomes `\vert{}\vert{}`, quoted variables get mangled and `diff --git` headers disappear. Never ask Gemini for a patch; ask for "file path + original block + replacement block" and apply it locally.
- **Do not assume provider-side session isolation.** See the `--new-session` caveat under Session rules.

## Trust and evidence

- Provider answers are suggestions, not verified facts or test results.
- Do not treat generated code as applied, compiled or tested until you have done so locally.
- For current public facts, verify authoritative sources when necessary; do not rely solely on a web provider's memory.
- Keep sensitive local material out of provider requests.
- Prefer one comprehensive request with complete relevant files over repeated short prompts that force the model to rediscover context.


## Context-efficient code workflow

- Prefer `wfa code --file <directory> --exclude "<glob>"` over enumerating many files manually. Directory scans recurse and skip common generated/dependency folders.
- `wfa code` line-numbers recognized text source by default. Use `--no-bundle-lines` only when separate raw source attachments are preferable.
- Run `--dry-run` before sending a large context. Review `promptBytesByProvider`, `promptSizeRisk`, `estimatedTokens`, secret findings and unscanned native/image attachments. The token figure is heuristic, not an exact provider count.
- Keep the prompt body at or below 40 KiB per provider. ask-bridge truncates silently at roughly 44 KiB — the provider answers from a partial prompt with no truncation signal, an exit code of 0 and a plausible-looking answer. A `--dry-run` above 40 KiB exits 2 on purpose; `--allow-oversize` is for a size you have measured and accepted, not for making the warning go away.
- When a request legitimately needs more than 40 KiB, split it on file boundaries and state the cross-file contract in every part. Each part is a separate provider conversation, so conclusions that depend on files in another part must be verified locally rather than assumed.
- Use `--mode spec` for large refactors or files where complete-file output is likely to be wasteful; use `full-file` for small/medium changes that should be returned as complete files.
- Keep native documents and images as native attachments; do not try to flatten PDF/Office binary files into a text source bundle.
- Use `.wfa/active-brief.md` for project hot-state handoff. It is injected only for a new/fresh provider conversation. Use `--brief-file` for an explicit one-off brief.

## Follow-up and recovery

- For a completed WFA task, use `--followup <task-id>` to continue the same provider conversation. Do not copy the parent answer into the prompt again unless the task specifically needs a quoted excerpt.
- Use `wfa wait <task-id>` or `wfa attach <task-id>` to observe a saved task without resending. They automatically adopt a result only when ask-bridge writes matching per-job `id`/`provider` metadata with `state: completed` after a stable, non-empty `response.md`. They never infer completion from repeated text or call `ask-bridge get`.
- `wfa collect <task-id> --provider <provider>` returns an already verified result idempotently without another confirmation. Use `--confirm-complete` only for manual recovery when no trusted batch terminal artifact exists and you have independently confirmed in the browser that generation has stopped; `ask-bridge get` itself does not prove completion.
- A verified result may be read while ask-bridge finishes batch cleanup, but the same workspace/provider remains locked until the owning process exits.
- On `RATE_LIMITED`, `LOGIN_REQUIRED`, or `CLOUDFLARE_BLOCKED`, follow the displayed recovery hint. WFA never automatically resends an uncertain request.
- Use `wfa result` to inspect output. `wfa stage` is non-destructive. `wfa apply --confirm` is the only path that writes staged complete files into the workspace; review `git diff` and run tests afterward.
- `spec` results are instructions for the local coding agent and cannot be staged as full-file replacements.
