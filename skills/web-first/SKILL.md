---
name: web-first
description: Default web-first reasoning and complete-code delegation workflow for local coding agents. Every nontrivial request — requirements, root cause, architecture, debugging, code design or implementation — goes through the local wfa CLI to Gemini (Task mode) + ChatGPT by default, serially, and must return complete file contents or exact replacement blocks, not a plan or a diff. For a project with a Git remote the local agent submits the repository reference plus the requirement and lets the providers read the repository; it only sends code or files when a provider asks for them.
---

# Web-First

## Core role split

- **Gemini (Task mode) + ChatGPT are the default reasoning and implementation partners.** Every `wfa` call goes to both providers, serially, unless the user explicitly asks for one, or one provider is structurally unable to do the task (Gemini document attachments — see Provider known limits). Gemini runs first and lands in Task mode by default, so read the `Gemini mode:` line of every run (see the default pair note below) instead of assuming the switch was pressed.
- **You (the local coding agent) own execution only**: resolve the remote, write the requirement, apply what comes back, run tests, verify, commit. You do not pre-read the repository to build context and you do not reason the design through yourself when a provider can. Do not rewrite their answer from scratch.
- **You submit a repository reference, not a dossier.** The default request is the requirement plus the URL/branch/commit that `wfa` resolves from the Git remote. Files, excerpts or a whole-repository bundle go out only when a provider asks for them (see Repository-first workflow).
- Both providers receive the same prompt in one serial batch. Their answers are independent; compare them, take the stricter/safer variant on conflict, and discard any fragment that arrived corrupted.
- Do not expose or configure an MCP server for this workflow. Call `wfa` directly as a local CLI.
- WFA does not set or change provider reasoning strength; the current setting in the provider web UI is used.

## Default delegation policy

Ask both providers for anything that involves:

- writing or changing code beyond a trivial edit;
- root-cause analysis, architecture, or a design decision;
- reviewing a patch, a contract, or a compatibility boundary;
- anything where a wrong first answer would cost a rewrite.

Do it locally instead (no design, no discovery): resolving the remote and HEAD, writing the requirement, applying a returned patch, running tests, reading logs, committing. Trivial edits stay local: typo, wording, one constant, formatting, a one-line log message, a rename confined to one file. If you are unsure whether something is trivial, it is not.

Never spend local context assembling context the providers can obtain themselves. Reading the repository, choosing "relevant" files and bundling them is exactly the work this workflow exists to remove.

## Repository-first workflow

1. **Default: send the reference.** Inside a Git repository with a remote, `wfa` injects a `REPOSITORY` block (https URL, branch, HEAD commit) into every provider prompt and both providers read the repository directly. Submit the requirement and nothing else.
2. **`REPO_UNREADABLE` is not an answer.** If a provider replies `REPO_UNREADABLE`, `wfa` records `repoUnreadable` on that provider and prints the fallback command. Do not treat it as a completed result and do not paraphrase it into a conclusion.
3. **Fallback: ship the tracked source as an archive.** Run the printed `wfa ask --followup <task-id> --bundle-repo=zip …` command. The archive holds tracked, non-sensitive source only and travels as a native attachment, so the 40 KiB prompt guard does not apply — a 60-file repository compresses to roughly 150 KB and uploads in seconds. Its text entries go through the same secret scan as an inline bundle (a key-shaped line blocks the send unless `--allow-sensitive`), it is capped at 50 MiB, and the block reports uncommitted files because it is packed from the working tree. Bare `--bundle-repo` keeps the older inline transport, where a prompt over 40 KiB must be narrowed with `--exclude` or `--file` rather than raised.
4. **Later rounds: answer the question that was asked.** When a provider asks for a specific file or fact, send exactly that one thing with `--followup <task-id> --file <one-file>`. Never re-bundle, never resend the whole repository, never guess what it "probably" wanted.
5. **No remote, or `--no-repo`:** fall back to explicit `--file`/`--dir` attachments as before.
6. **When you cannot decide — ambiguous requirement, two providers disagreeing, a missing permission or credential — ask the user.** Do not guess and do not silently pick a side.

## Complete-delivery contract

State the delivery format in every request:

- code: `FILE: relative/path` followed by complete contents, or `ANCHOR`/`REPLACE` blocks with exact surrounding lines. No unified diff, no ellipsis, no "rest unchanged", no pseudocode.
- analysis: conclusion, evidence with `path:line`, uncertainty, and the next concrete action.

Never accept "here is the approach" as the answer to an implementation request. If a provider returns a plan, a diff, or a corrupted fragment (LaTeX escaping, lost `diff --git` headers), do not repair it by hand — send one narrow follow-up asking for that file in complete form.

**Check length before you apply.** A "complete file" that is a fraction of the original's size is a summary, not a replacement — measured example: a 292-line README returned as 18 lines and a 187-line policy returned as 24. Compare the returned line count with `wc -l` on the current file; if it shrank without being asked to shrink, reject that block and ask for the file again. Files too large to send whole (for example a 45 KB module) should be returned as `ANCHOR`/`REPLACE` blocks, not as a rewritten file.

## Mandatory behavior for code-design and implementation tasks

When the user asks to implement, fix, refactor, optimize or add code, **do not ask either provider merely for a plan, checklist or proposed diff**. Ask for the actual modified code.

### Before calling the providers

1. Confirm the working directory is the intended project and let `wfa` resolve the Git remote, branch and HEAD. Outside that tree, pass `--repo-url`; to opt out entirely, pass `--no-repo`.
2. Do **not** read the source tree to decide what to attach. Only when there is no remote, or when a provider has already asked for something specific, attach whole files — never isolated snippets, never a hand-picked "relevant subset" chosen on speculation.
3. Do not send secrets, credentials, tokens, private keys, personal data, or sensitive legal/arbitration materials — including through a whole-repository bundle.
4. Write a precise requirement that states behavior, invariants, compatibility constraints and known evidence. Distinguish observed facts from hypotheses. The requirement is where your effort goes, not the packaging.
5. Use a stable workspace key derived from the repository name; each task gets its own fresh conversation, so the key groups history rather than carrying context forward.

### Preferred command

Inside a repository with a remote, the whole request is the requirement:

```powershell
wfa code `
  --workspace <repository-key> `
  --requirement "<precise implementation requirement>"
```

Attach complete files only when there is no remote, with `--no-repo`, or in the `--bundle-repo` fallback after a `REPO_UNREADABLE` answer:

```powershell
wfa code `
  --workspace <repository-key> `
  --no-repo `
  --requirement "<precise implementation requirement>" `
  --file <complete-source-file> `
  --file <focused-test-file>
```

The command builds a strict prompt asking each provider to return:

- `FILE: relative/path` for each changed or new file;
- the **complete contents** of each file, ready to save;
- complete tests and required config changes;
- no diff-only answer, no ellipses, no "rest is unchanged", no pseudocode and no placeholder implementation.

Do not replace `wfa code` with `wfa ask` for a code implementation request unless the user explicitly asks only for a review or explanation.

### After receiving code

1. Read the saved provider result file(s).
2. Verify every returned path against the real repository and the attached source version.
3. Apply the code locally. Providers do not modify the local repository.
4. Resolve inconsistencies and verify imports, callers, types, platform behavior and error paths.
5. Run focused tests and only the additional tests that provide new evidence.
6. Inspect `git diff` and `git status`. Do not claim tests passed unless they were run locally.
7. If a provider omitted a required complete file or invented unavailable interfaces, do not fill gaps by guessing. Gather the missing complete source and make one focused follow-up request.

## General analysis and research

For non-code analysis, use:

```powershell
wfa ask --workspace <repository-key> --prompt-file <prompt-file>
```

Attach files only when the question is about material the providers cannot reach: a private document, a log, a local file outside the repository. For a repository question, let the `REPOSITORY` block do the work. Ask for a direct conclusion, evidence, uncertainty and practical implications. Keep the request focused.

When the attachment is a fragment rather than a whole file, send the enclosing signature and one module-level anchor too, and say where new definitions belong. Measured: a 40-line request handler sent on its own came back with three module-level constants and two `async function`s inserted inside the handler — syntactically valid, one closure rebuilt per request. The provider had no way to know the fragment sat inside a callback, and it did not ask.

## Parallel multi-provider consultation

Multi-provider is the default, not an opt-in. `wfa` sends every request to Gemini (Task mode) + ChatGPT unless you narrow it deliberately.

Narrow to a single provider only when:

- the user asks for one by name;
- the task is structurally impossible for one of them (Gemini document attachments — see Provider known limits);
- you are continuing one provider's existing conversation with `--followup`, which is inherently single-provider.

Do not narrow just to save time or tokens. The second answer is what catches a confident wrong answer, and that is the failure mode this workflow exists to prevent.

```powershell
wfa ask --workspace <repository-key> --prompt-file <prompt-file>
```

For independent code implementations:

```powershell
wfa code --workspace <repository-key> `
  --requirement "<same precise implementation requirement>"
```

Both providers receive the same prompt and attachments in one batch and answer independently. Each gets its own conversation and result file. Do not send one provider's answer to another unless explicitly doing a second-round critique. Compare the results, identify agreement and disagreement, take the stricter variant on conflict, then verify locally.

The default batch runs providers one after another (`--concurrency 1`), because concurrent browser tabs interfere with each other on this setup. Keep it serial. Do not work around interference by launching two separate `wfa` processes against different workspaces.

The default pair is **Gemini in Task mode, then ChatGPT**, and that is what an unflagged call sends. Gemini's Chat/Task switch is page state — not a URL parameter, not `localStorage`, reset to Chat by a reload — so `wfa` presses it through Chrome's debugging port right after the page appears and records the outcome instead of promising it. Read the `Gemini mode:` line of every run:

- `Gemini mode: task (switch pressed before typing)` — the switch landed before any prompt text existed. Trust the mode.
- `Gemini mode: task (NOT applied) - task switch not pressed: the composer already held N characters` — ask-bridge was already typing, so wfa refused to click rather than risk clearing the prompt. The run stayed in Chat; treat the answer as a Chat answer and do not retry just to get Task mode.
- `Gemini mode: task (NOT applied) - <other reason>` — the page never appeared, the switch was missing, or the CDP connection dropped. The run completed in Chat; state that rather than reporting a clean Task run.

`--gemini-mode chat` sends one request in Chat (`wfa gemini-mode chat` saves it for later). Use it when a task is known to break in Task mode, never to paper over a failure you have not diagnosed. A detached plain batch has no coordinator process to hold the debugging session and will record `NOT applied`; that is expected, not an error to retry.

Claude is available when explicitly selected:

```powershell
wfa ask --providers 'chatgpt,gemini,claude' ...
```

## Waiting and recovery

- Run one foreground `wfa` command and let the local CLI/ask-bridge process wait for the provider. Do not create a 30-second `wfa status` or `wfa ask` polling loop.
- `wfa` prints a task ID before waiting and persists it locally.
- A nonzero exit from `ask`, `compare` or `code` can still include completed provider results. Read the task summary and use successful result files before deciding how to recover the unfinished providers.
- If the terminal tool returns while the process is still running, inspect `wfa status <task-id>` once when needed. If it is still running, do not submit again.
- `timed_out`, `recoverable`, `interrupted_unknown`, `stalled` and ambiguous `failed` states may mean the prompt was already submitted. Never resend automatically.
- A `stalled` provider means ask-bridge stayed silent **and** the browser stopped working: no progress line, no metadata change, and no write to ask-bridge's `chrome-devtools-mcp.log` for the last two minutes. The default threshold is `--stall-timeout` 900 s. Generation itself is silent — ask-bridge writes nothing until the answer is done — so five minutes of quiet is normal for a long answer and is not evidence of death. It still locks the workspace: inspect the browser, then `wfa collect` or `wfa resolve`.
- While a batch is quiet, `guardedBatch` prints `[wfa] still waiting: gemini quiet 240s (stall limit 900s)` once a minute. That line is synthetic: it carries no job id and is not written to `batch.stdout.log`. If it stops appearing while the process is alive, the process is no longer in the waiting loop; if the process is gone entirely, use `wfa status` once rather than resubmitting.
- `--detach` does not outlive a host that reaps background processes. Measured in an IDE/agent runner: the worker is killed when the calling tool call ends; whether the prompt had already been submitted is then unknown, and guessing wrong means sending it twice. **Empty `batch.*.log` is not proof that nothing was sent** — a detached serial worker captures ask-bridge itself, so those files used to stay at 0 bytes for the whole run. Since 0.2.10 the worker forwards provider output and the `still waiting` heartbeat to the batch log, and `failed_before_start` (plain `failed`, no lock, safe to rerun) requires that no `metadata.json`, thread URL, result, or completion proof exists at all. If any of those exists the job becomes `interrupted_unknown`: run `wfa status` once, check the conversation, then `wfa resolve` — do not resubmit. In practice, prefer the foreground or put `wfa ask` itself in the background.
- A `WORKSPACE_PROVIDER_LOCKED` error is not a transient failure. Read the task ID it names, run `wfa status <task-id>` once, and either collect the result or, after confirming the generation is dead in the browser, `wfa resolve <task-id> --provider <provider> --confirm`.
- `--new-session` does not bypass the lock. A request that may already have reached the provider stays blocking on purpose; a resend into an uncertain conversation is worse than an explicit resolve.
- Failures that provably happened before submission — the tab never loaded, the send button never became enabled, or a Gemini attachment upload timed out — release the lock automatically. Do not spend a `wfa resolve` on them; just fix the cause and retry.
- Progress now streams: `[ask-bridge stdout] …` lines appear on stderr while the batch runs. Use them to decide whether the provider is working, and do not treat prolonged silence as failure while the process is alive.
- If ask-bridge writes matching terminal `completed` metadata and a complete `response.md`, WFA automatically adopts the saved result during task refresh. Use `wfa collect <task-id> --provider <provider>` to return that result without another browser request or confirmation.
- `STORE_LOCK_TIMEOUT` names the process holding the task-store lock. `wfa list`, `wfa status` and `wfa result` keep working during a lock wait because reads do not take the lock. If the named owner is gone, run `wfa unlock` once; if that reports `STORE_LOCK_UNRECLAIMABLE`, the data directory is unusable and `WFA_HOME` should point at a fast local volume.
- If no trusted terminal artifact exists, `wfa collect --confirm-complete` uses ask-bridge `get` as a manual recovery path. Independently confirm in the browser that generation has stopped first, because `get` itself does not establish completion.
- If the old generation is definitely no longer active and cannot be collected, unlock it only with:
  `wfa resolve <task-id> --provider <provider> --confirm`
- Reuse the same `request_id` only for an identical request. A changed prompt or attachment set is a new logical request and needs a new request ID.

## Session rules

- Use the same `--workspace` key for the same repository/project. The key groups history; it no longer feeds a saved conversation into the next task.
- **New tasks start a fresh provider conversation by default.** Use `--continue-session` only when you deliberately want the provider to keep the previous conversation's context, and `--followup <task-id>` to continue one verified task thread.
- A fresh task that still returns the previous conversation URL is reported as `threadMismatch` on the provider, shown by `wfa status`, and that URL is never saved for reuse. Treat a mismatched answer as unpublishable: it may belong to another task.
- `--new-session` is now the default and is kept only as an explicit alias. It cannot guarantee isolation because ask-bridge can reuse an already open tab; `threadMismatch` is the evidence you check instead of assuming.
- Parallel provider jobs use separate tabs and separate provider conversations; never point two concurrent jobs at the same conversation.

## Provider known limits

Measured against ask-bridge 0.4.0; full evidence and reproductions are in `docs/known-issues.md` of the `web-first-ask` repository (U1–U10). Those are upstream defects — `wfa` detects and works around them, it does not fix them.

- **Gemini verifies an attachment by whole filename, so long names fail.** `--file` with a document (`.md`, `.txt`, `.pdf`, `.docx`, `.xlsx`) is uploaded, then ask-bridge looks for the entire filename in the page text and reports `Timed out waiting for Gemini to show attachment '<name>'` after 50–60 s, because the attachment label is truncated past roughly 20 characters (measured: 20-character stem passes, 21 fails). So `wfa` inlines text and refuses other binary documents (`GEMINI_ATTACHMENT_UNSUPPORTED`); inlined bytes count against the 40 KiB budget. If you force an upload with `--allow-gemini-attachments`, keep the stem at 20 characters or fewer. Archives (`zip`, `tar`, `gz`, `tgz`, `7z`) upload normally, and `--bundle-repo=zip` names them `<slug8>-<hex8>.zip` for exactly this reason — measured, a 135 KB zip with 100 entries arrived in 17 s — so use it for whole-repository work with Gemini.
- **Prompts over roughly 44 KiB are truncated without a signal.** This is the most dangerous failure mode: the answer looks normal and arrives faster. Always run `--dry-run` first and treat exit 2 as a stop sign.
- **ChatGPT long answers may land in Canvas.** When the response is replaced by a download link plus a hash, `response.md` does not contain the artifact. Ask for smaller chunks, or request the content to be repeated inline in the chat.
- **Gemini corrupts Markdown diffs.** `||` becomes `\vert{}\vert{}`, quoted variables get mangled and `diff --git` headers disappear. Never ask Gemini for a patch; ask for "file path + original block + replacement block" and apply it locally.
- **Gemini often cannot read a public repository.** Measured today: a repository-first request came back as `REPO_UNREADABLE` in 12 seconds. That is a normal outcome, not a failure of the request — run the `--bundle-repo=zip` fallback. Do not inline a whole repository and do not retry the same prompt hoping for a different result.
- **ChatGPT repository reading is slow, not broken.** A repository-first implementation request took 28 minutes and still finished. Do not kill it early; the stall watchdog only fires when both wfa and the browser have been quiet, and a generating tab keeps writing `chrome-devtools-mcp.log`.
- **A provider can answer "I cannot open the attachment" and still be `completed`.** Measured on `--bundle-repo=zip`: `state: completed`, body "当前会话环境中没有可用的文件解压或本地文件读取工具", no usable output. `wfa code` and `wfa status` flag this now, but the fix is on your side: resend the content as text, or point the provider at a reachable URL. A `completed` task that says it could not read the files has not answered the question.
- **Do not assume provider-side session isolation.** See Session rules and `threadMismatch`.

## Trust and evidence

- Provider answers are suggestions, not verified facts or test results.
- Do not treat generated code as applied, compiled or tested until you have done so locally.
- For current public facts, verify authoritative sources when necessary; do not rely solely on a web provider's memory.
- Keep sensitive local material out of provider requests.
- Prefer one comprehensive request with complete relevant files over repeated short prompts that force the model to rediscover context.


## Context-efficient code workflow

- Prefer the repository reference over any attachment. `wfa code --requirement ...` is the whole command when a remote exists.
- When you do need attachments, `wfa code --file <directory> --exclude "<glob>"` beats enumerating files by hand. Directory scans recurse and skip common generated/dependency folders.
- `--bundle-repo` is the `REPO_UNREADABLE` fallback and nothing else. `--bundle-repo=zip` (preferred) packs tracked, non-sensitive files into a zip attachment and reports `repositoryArchive: {files, sourceBytes, archiveBytes, ratio, skipped}` in `--dry-run`. Bare `--bundle-repo` inlines a bounded selection and reports `bundle`.
- Run `--dry-run` before sending a large context. Review `promptBytesByProvider`, `promptSizeRisk`, `estimatedTokens`, secret findings and unscanned native/image attachments. The token figure is heuristic, not an exact provider count.
- Keep the prompt **text** at or below 40 KiB per provider (attachments upload outside the prompt and are not capped). ask-bridge truncates prompt text silently at roughly 44 KiB — the provider answers from a partial prompt with no truncation signal, an exit code of 0 and a plausible-looking answer. A `--dry-run` above 40 KiB exits 2 on purpose; `--allow-oversize` is for a size you have measured and accepted, not for making the warning go away.
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
