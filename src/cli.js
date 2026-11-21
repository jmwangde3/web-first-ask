import { copyFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyStore } from "./policy-store.js";
import { resolveRepository } from "./repository.js";
import { getHomeDir } from "./paths.js";
import { loadConfig, saveBrowserMode } from "./config.js";
import { executeTask, refreshTask } from "./managed-runner.js";
import { runDetachedBatchWorker } from "./runner.js";
import { collectTask, listTasks, abandonProvider, waitForTask } from "./recovery.js";
import { checkAskBridge, prepareChromeStartup, resolveAskBridge, runProcess } from "./ask-bridge.js";
import { buildCodePrompt, buildComparePrompt } from "./prompts.js";
import { normalizeProviders } from "./jobs.js";
import { WfaError } from "./errors.js";
import { updateAskBridge } from "./maintenance.js";
import { truncate } from "./util.js";
import { expandAttachmentInputs } from "./attachments.js";
import { readTaskResult, stageTaskFiles, applyStagedFiles } from "./stage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALUE_FLAGS = new Set([
  "provider", "providers", "workspace", "prompt", "prompt-file", "requirement",
  "file", "image", "timeout", "request-id", "concurrency", "reasoning",
  "reasoning-map", "model", "model-map", "context", "limit",
  "mode", "brief-file", "followup", "dir", "exclude", "poll-ms",
  "repo-url", "stall-timeout", "target",
]);
const REPEAT_FLAGS = new Set(["file", "image", "dir", "exclude"]);

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const equalAt = token.indexOf("=");
    const name = token.slice(2, equalAt === -1 ? undefined : equalAt);
    if (!name) throw new WfaError("ARGUMENT_ERROR", `Invalid option: ${token}`);
    let value;
    if (equalAt !== -1) value = token.slice(equalAt + 1);
    else if (VALUE_FLAGS.has(name)) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new WfaError("ARGUMENT_ERROR", `Option --${name} requires a value.`);
      }
    } else value = true;
    if (REPEAT_FLAGS.has(name)) { options[name] ??= []; options[name].push(value); }
    else options[name] = value;
  }
  return { positional, options };
}

function parseMap(value, label) {
  if (!value) return {};
  const result = {};
  for (const part of String(value).split(",")) {
    const index = part.indexOf("=");
    if (index < 1 || index === part.length - 1) {
      throw new WfaError("ARGUMENT_ERROR", `Invalid ${label} entry "${part}". Use provider=value pairs separated by commas.`);
    }
    result[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }
  return result;
}

async function readPrompt(options) {
  if (options.prompt && options["prompt-file"]) throw new WfaError("ARGUMENT_ERROR", "Use only one of --prompt and --prompt-file.");
  if (options["prompt-file"]) return (await readFile(path.resolve(options["prompt-file"]), "utf8")).trim();
  if (options.prompt) return String(options.prompt).trim();
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return "";
}

function defaultWorkspace(value) {
  return value || path.basename(process.cwd()).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "") || "workspace";
}

// `--bundle-repo` stays a bare flag, but `--bundle-repo=zip` switches the
// transport from inline text (subject to the prompt truncation ceiling) to a
// native archive upload (not subject to it).
function resolveBundleRepoMode(value, command) {
  if (!value) return null;
  if (command !== "code") {
    throw new WfaError("ARGUMENT_ERROR", "--bundle-repo is only supported by wfa code.");
  }
  const mode = value === true ? "inline" : String(value).toLowerCase();
  if (!["inline", "zip"].includes(mode)) {
    throw new WfaError("ARGUMENT_ERROR", `Invalid --bundle-repo value "${value}". Use --bundle-repo, --bundle-repo=inline, or --bundle-repo=zip.`);
  }
  return mode;
}

function printTask(task, json = false, replayed = false) {
  const children = Object.fromEntries(Object.entries(task.children ?? {}).map(([provider, child]) => [provider, {
    state: child.state, result: child.resultPath ?? null, thread: child.threadUrl ?? null,
    error: child.error ?? null, errorCode: child.errorCode ?? null,
    recoveryHint: child.recoveryHint ?? null,
    autoCollected: child.completionProof?.source === "ask-bridge-batch-terminal",
    retryAfterAt: child.retryAfterAt ?? null, retryAfterEstimated: child.retryAfterEstimated ?? false,
    responseHeuristics: child.responseHeuristics ?? null,
    sessionIsolationWarning: child.sessionIsolationWarning ?? null,
    threadMismatch: child.threadMismatch ?? null,
    repoUnreadable: Boolean(child.repoUnreadable), repoUnreadableEvidence: child.repoUnreadableEvidence ?? null,
    repoFallbackCommand: child.repoFallbackCommand ?? null,
    stall: child.stall ?? null, retriedAsSingleBatch: Boolean(child.retriedAsSingleBatch),
    retryLogs: child.retryLogs ?? null,
  }]));
  const summary = { taskId: task.taskId, requestId: task.requestId, workspace: task.workspace,
    kind: task.kind, state: task.state,
    sessionPolicy: task.sessionPolicy ?? (task.fresh ? "fresh" : "continue"),
    executionPending: Boolean(task.executionPending), replayed,
    retryWarnings: task.retryWarnings ?? [], providers: children };
  if (json) { process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`); return; }
  process.stdout.write(`Task: ${task.taskId}${replayed ? " (existing request; not resent)" : ""}\n`);
  process.stdout.write(`Workspace: ${task.workspace}\nState: ${task.state}\nSession: ${summary.sessionPolicy}\n`);
  if (task.executionPending) process.stdout.write("Execution cleanup: pending; completed results are readable but the workspace/provider lock remains active.\n");
  for (const warning of task.retryWarnings ?? []) process.stdout.write(`Retry: ${warning}\n`);
  for (const [provider, child] of Object.entries(children)) {
    process.stdout.write(`- ${provider}: ${child.state}${child.retriedAsSingleBatch ? " (after a single-job retry)" : ""}\n`);
    if (child.result) process.stdout.write(`  Result: ${child.result}\n`);
    if (child.thread) process.stdout.write(`  Conversation: ${child.thread}\n`);
    if (child.errorCode) process.stdout.write(`  Error: ${child.errorCode}${child.retryAfterAt ? ` (retry after ${child.retryAfterAt}${child.retryAfterEstimated ? ", estimated" : ""})` : ""}\n`);
    if (child.error) process.stdout.write(`  Detail: ${truncate(child.error, 500)}\n`);
    if (child.recoveryHint) process.stdout.write(`  Hint: ${child.recoveryHint}\n`);
    for (const reason of child.responseHeuristics?.reasons ?? []) process.stdout.write(`  Warning: ${reason}\n`);
    if (child.sessionIsolationWarning) process.stdout.write(`  Warning: ${child.sessionIsolationWarning}\n`);
    if (child.threadMismatch) process.stdout.write(`  THREAD MISMATCH: expected ${child.threadMismatch.expected}; actual ${child.threadMismatch.actual}. Do not trust session isolation.\n`);
    if (child.repoUnreadable) process.stdout.write(`  REPO_UNREADABLE: ${child.repoUnreadableEvidence?.matched}\n  Next: ${child.repoFallbackCommand}\n`);
    if (child.stall) process.stdout.write(`  STALLED: ${child.stall.silentSeconds}s without progress/metadata changes.\n  Next: wfa collect ${task.taskId} --provider ${provider} OR wfa resolve ${task.taskId} --provider ${provider} --confirm (after verification).\n`);
  }
  process.stdout.write("Verified ask-bridge completed artifacts are collected automatically. Use `wfa collect <task-id> --provider <provider>` to retrieve a saved result; --confirm-complete is only for manual recovery.\n");
}

function help() {
  process.stdout.write(`web-first-ask (wfa) — Codex-first web AI delegation

Commands:
  wfa ask       Ask the default providers (chatgpt+gemini, serial) in separate batches
  wfa compare   Ask multiple providers; sequential by default
  wfa code      Ask for complete replacement code; repository reference by default
  wfa status    Inspect a task by ID
  wfa list      List recent tasks, refreshing detached/running states
  wfa wait      Wait for a task; adopt verified results and optionally stage completed code
  wfa attach    Reattach read-only to saved task status; never resubmit
  wfa collect   Return a verified saved result; manual get requires --confirm-complete
  wfa result    Read a saved provider result
  wfa stage     Stage full-file or exact ANCHOR/REPLACE code for review
  wfa apply     Apply staged code only after explicit confirmation
  wfa resolve   Abandon an unresolved provider task after confirming it is no longer running
  wfa login     Log in to a provider through ask-bridge
  wfa browser-mode [headless|headful]  Show or save browser mode and Chrome repair status
  wfa doctor    Check Node.js, ask-bridge integration and Chrome startup repair
  wfa install-skill [--target codex|workbuddy|path]  Install web-first Skill
  wfa upstream update  Update ask-bridge using its official updater

Common options:
  --provider chatgpt|gemini|claude
  --providers chatgpt,gemini[,claude]
  --workspace <stable-project-key>
  --prompt <text> | --prompt-file <path> | stdin
  --repo-url <url>     Override the detected Git remote URL
  --no-repo            Do not add a repository reference
  --bundle-repo        Inline a directory tree and a bounded selection of tracked sources
  --bundle-repo=zip    Attach the tracked sources as a zip instead of inlining (no prompt ceiling)
  --file <path|glob|dir> Repeatable source/document attachment; directories recurse
  --dir <path>         Alias for recursive directory attachment
  --image <path|glob>  Repeatable image attachment (not supported by Gemini)
  --exclude <glob>     Repeatable source or repository bundle exclusions
  --timeout <seconds>  Default 1200; maximum 7200
  --stall-timeout <s>  Default 300; 0 disables inactivity watchdog
  --concurrency <N>    Jobs in flight (1..3); default 1, using separate batches

  --model <name>       Single-provider request only; add --provider
  --model-map chatgpt=<name>,gemini=<name>
  --context <text>     Additional code-generation context
  --download-images    Download generated images (off by default)
  --continue-session  Reuse a workspace's previous conversation (opt-in)
  --new-session        Explicitly request fresh conversation (default)
  --fresh              Alias for --new-session
  --followup <id>      Continue exact saved provider conversation
  --mode full-file|spec Select complete-file delivery or compact implementation specification
  --brief-file <path>  Explicit project handoff context
  --no-brief           Disable automatic .wfa/active-brief.md injection
  --bundle-lines       Bundle selected text files with path:line prefixes
  --detach             Run background WFA serial worker or ask-bridge with task-specific logs
  --stage              Stage completed full-file code without applying it
  --poll-ms <ms>       Polling interval for wait/attach (250..60000; default 2000)
  --dry-run            Preview repository reference, dirty/unpushed warnings and risks
  --allow-oversize     Send an inline prompt over 40 KiB anyway (truncation risk; attachments are unaffected)
  --allow-gemini-attachments  Force native Gemini upload instead of inlining text
  --allow-sensitive    Explicitly allow sending text flagged by secret scanner
  --no-bundle-lines     Disable selected-source bundle for wfa code
  --request-id <id>    Reuse only to recover the exact same logical request
  --json               Print machine-readable summary

Code mode:
  wfa code --workspace repo-name --requirement "Implement the new feature"
  wfa code --requirement "..." --no-repo --file src/a.js
  wfa code --followup <task-id> --provider chatgpt --bundle-repo --requirement "Complete original implementation"

Safety:
  Each new task requests a new conversation; ask-bridge may still reuse tabs.
  Thread mismatches and REPO_UNREADABLE are surfaced, not accepted silently.
  Dirty/unpushed local state is warned and never silently represented as remote code.
  Stalled/uncertain tasks remain locked until collection or explicit resolve.
  Stage/apply reject corrupted LaTeX output and require exact anchor matching.
  wfa apply --confirm alone writes provider-generated code into the workspace.
`);
}

async function runLogin(provider, config) {
  const command = resolveAskBridge(config);
  const result = await runProcess(command, ["--backend", "browser", "--provider", provider, "login"], { inherit: true });
  if (result.spawnError || result.code !== 0) {
    throw new WfaError("LOGIN_FAILED", result.spawnError?.message ?? `ask-bridge login exited with ${result.code}.`);
  }
}

async function installSkill(target = "codex") {
  if (typeof target !== "string" || !target.trim()) throw new WfaError("ARGUMENT_ERROR", "--target must be codex, workbuddy or an explicit directory.");
  const source = path.join(ROOT, "skills", "web-first", "SKILL.md");
  const alias = target.toLowerCase();
  const base = alias === "codex" || alias === "workbuddy"
    ? path.join(os.homedir(), `.${alias}`, "skills")
    : path.resolve(target === "~" ? os.homedir()
      : target.startsWith("~/") || target.startsWith("~\\") ? path.join(os.homedir(), target.slice(2)) : target);
  const destination = path.join(base, "web-first", "SKILL.md");
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  process.stdout.write(`Installed Skill: ${destination}\nRestart or refresh Skill discovery if needed.\n`);
}

function printChromeStatus(status, output = process.stdout) {
  output.write(`Chrome startup profile: ${status.profileStatus}; repaired: ${status.repairedProfiles.length}; log rotated: ${status.logRotated ? "yes" : "no"}\n`);
  for (const warning of status.warnings ?? []) output.write(`Chrome startup warning: ${warning}\n`);
}

async function doctor(config) {
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const supported = (nodeMajor === 20 && nodeMinor >= 19)
    || (nodeMajor === 22 && nodeMinor >= 12) || nodeMajor >= 23;
  if (!supported) throw new WfaError("NODE_VERSION", `ask-bridge requires Node.js ^20.19.0, ^22.12.0 or >=23.0.0; found ${process.versions.node}.`);
  const chrome = await prepareChromeStartup({ apply: true });
  const result = await checkAskBridge(config);
  process.stdout.write(`Node.js: ${process.versions.node} OK\n`);
  process.stdout.write(`ask-bridge: ${result.version}\nBatch command: available\nData directory: ${getHomeDir()}\n`);
  printChromeStatus(chrome);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") { help(); return; }
  const { positional, options } = parseArgs(rest);
  if (options.help) { help(); return; }
  if (Object.prototype.hasOwnProperty.call(options, "engine")) {
    throw new WfaError("UNSUPPORTED_ENGINE", "--engine is not supported. WFA uses ask-bridge only; no external engine is selected or invoked.");
  }
  if (Object.prototype.hasOwnProperty.call(options, "reasoning")
    || Object.prototype.hasOwnProperty.call(options, "reasoning-map")) {
    throw new WfaError("REASONING_DISABLED", "Reasoning-strength selection is temporarily disabled. Remove --reasoning/--reasoning-map; WFA now uses each provider's current web UI setting.");
  }
  const home = getHomeDir();
  const store = new PolicyStore(home);

  // Private detached-worker entry point. It only executes pre-existing tasks;
  // no new provider submission can be triggered by a user-supplied prompt.
  if (command === "__batch-worker") {
    if (positional.length !== 2 || Object.keys(options).length) {
      throw new WfaError("ARGUMENT_ERROR", "Invalid detached batch worker invocation.");
    }
    return runDetachedBatchWorker(positional[0], positional[1], { home, store });
  }
  if (command === "browser-mode") {
    if (positional.length > 1 || Object.keys(options).length > 0) {
      throw new WfaError("ARGUMENT_ERROR", "Usage: wfa browser-mode [headless|headful]");
    }
    const [mode] = positional;
    if (mode === undefined) {
      const config = await loadConfig(home);
      process.stdout.write(`${config.browserMode}\n`);
      const status = await prepareChromeStartup({ apply: false });
      // Preserve the existing stdout format (one mode) for scripts using it.
      printChromeStatus(status, process.stderr);
      return;
    }
    await saveBrowserMode(store, mode);
    const status = await prepareChromeStartup({ apply: true });
    process.stdout.write(`Saved browser mode: ${mode}\n`);
    printChromeStatus(status);
    process.stdout.write("If ask-bridge is already running Chrome, wait for active tasks to finish and run `ask-bridge close` to use this mode on the next request.\n");
    return;
  }
  const config = await loadConfig(home);
  if (command === "doctor") return doctor(config);
  if (command === "install-skill") {
    if (positional.length || Object.keys(options).some((key) => key !== "target")) {
      throw new WfaError("ARGUMENT_ERROR", "Usage: wfa install-skill [--target codex|workbuddy|<skills-directory>]");
    }
    return installSkill(options.target);
  }
  if (command === "login") {
    const provider = normalizeProviders([options.provider], [config.defaultProvider])[0];
    return runLogin(provider, config);
  }
  if (command === "upstream") {
    if (positional[0] !== "update") throw new WfaError("ARGUMENT_ERROR", "Usage: wfa upstream update");
    return updateAskBridge(config, store);
  }
  if (command === "status") {
    const taskId = positional[0];
    if (!taskId) throw new WfaError("ARGUMENT_ERROR", "Usage: wfa status <task-id>");
    const task = await refreshTask(taskId, { home, store });
    return printTask(task, Boolean(options.json));
  }
  if (command === "list") {
    const tasks = await listTasks({ home, store });
    const limit = Number(options.limit ?? 20);
    const selected = tasks.slice(0, limit);
    const refreshed = await Promise.all(selected.map(async (task) => {
      if (task.detached || task.executionPending || ["preparing", "running"].includes(task.state)) {
        return refreshTask(task.taskId, { home, store });
      }
      return task;
    }));
    const result = refreshed.map((task) => ({
      taskId: task.taskId, workspace: task.workspace, kind: task.kind, state: task.state,
      providers: Object.fromEntries(Object.entries(task.children).map(([key, value]) => [key, value.state])),
      createdAt: task.createdAt,
    }));
    process.stdout.write(`${options.json ? JSON.stringify(result, null, 2)
      : result.map((item) => `${item.taskId}  ${item.state.padEnd(16)} ${item.workspace}  ${Object.entries(item.providers).map(([p, s]) => `${p}:${s}`).join(" ")}`).join("\n")}\n`);
    return;
  }
  if (command === "wait" || command === "attach") {
    const taskId = positional[0];
    if (!taskId) throw new WfaError("ARGUMENT_ERROR", `Usage: wfa ${command} <task-id> [--provider <provider>] [--timeout <seconds>] [--stage] [--json]`);
    if (options["no-collect"]) throw new WfaError("ARGUMENT_ERROR", "--no-collect is obsolete: wait and attach never resend or invoke ask-bridge get.");
    const timeoutSeconds = options.timeout === undefined ? 300 : Number(options.timeout);
    const pollMs = options["poll-ms"] === undefined ? 2000 : Number(options["poll-ms"]);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 7200) {
      throw new WfaError("INVALID_TIMEOUT", "Wait timeout must be an integer from 0 to 7200 seconds.");
    }
    if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60000) {
      throw new WfaError("INVALID_POLL_INTERVAL", "--poll-ms must be an integer from 250 to 60000.");
    }
    const result = await waitForTask(taskId, {
      provider: options.provider, timeoutSeconds, pollMs, stage: Boolean(options.stage), home, store, config,
    });
    printTask(result.task, Boolean(options.json), false);
    if (!options.json) {
      for (const item of result.collected ?? []) {
        process.stdout.write(`Auto-collected (${item.provider}) from verified ask-bridge terminal metadata: ${item.resultPath}\n`);
      }
      for (const s of result.staged ?? []) {
        process.stdout.write(`Staged (${s.provider}): ${s.files?.length ?? 0} file(s) -> ${s.stageRoot}\n`);
      }
      if (result.task.executionPending) process.stdout.write("ask-bridge batch cleanup is still running; completed results are safe to read, but the workspace remains locked until the process exits.\n");
    }
    return result.task.state === "completed" ? 0 : 1;
  }
  if (command === "collect") {
    const taskId = positional[0];
    if (!taskId) throw new WfaError("ARGUMENT_ERROR", "Usage: wfa collect <task-id> --provider <provider> [--confirm-complete]");
    const result = await collectTask(taskId, {
      provider: options.provider, confirmComplete: Boolean(options["confirm-complete"]), home, store, config,
    });
    process.stdout.write(`${result.autoCollected ? "Auto-collected" : result.alreadyCollected ? "Result already saved" : "Manually collected"} (${result.provider}): ${result.resultPath}\nTask state: ${result.task.state}${result.executionPending ? " (batch cleanup pending; workspace remains locked)" : ""}\n`);
    return;
  }
  if (command === "result") {
    const taskId = positional[0];
    if (!taskId) throw new WfaError("ARGUMENT_ERROR", "Usage: wfa result <task-id> --provider <provider> [--stdout]");
    const result = await readTaskResult(taskId, { provider: options.provider, stdout: Boolean(options.stdout), home, store });
    if (options.stdout) {
      for (const reason of result.responseHeuristics?.reasons ?? []) process.stderr.write(`Warning: ${reason}\n`);
      if (result.sessionIsolationWarning) process.stderr.write(`Warning: ${result.sessionIsolationWarning}\n`);
      process.stdout.write(result.body);
      if (!result.body.endsWith("\n")) process.stdout.write("\n");
    } else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "stage") {
    const taskId = positional[0];
    if (!taskId) throw new WfaError("ARGUMENT_ERROR", "Usage: wfa stage <task-id> --provider <provider>");
    const result = await stageTaskFiles(taskId, { provider: options.provider, home, store });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "apply") {
    const taskId = positional[0];
    if (!taskId) throw new WfaError("ARGUMENT_ERROR", "Usage: wfa apply <task-id> --provider <provider> [--confirm]");
    if (!options.confirm) {
      const staged = await stageTaskFiles(taskId, { provider: options.provider, home, store });
      const preview = await applyStagedFiles(taskId, { provider: options.provider, home, store });
      process.stdout.write(`${JSON.stringify({ ...preview, staged }, null, 2)}\n`);
      process.stdout.write("Preview only. Inspect the staged files, then run the same command with --confirm to apply.\n");
      return;
    }
    const result = await applyStagedFiles(taskId, { provider: options.provider, confirm: true, home, store });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "resolve") {
    const taskId = positional[0];
    if (!taskId || !options.provider) throw new WfaError("ARGUMENT_ERROR", "Usage: wfa resolve <task-id> --provider <provider> --confirm");
    await refreshTask(taskId, { home, store });
    const provider = normalizeProviders([options.provider])[0];
    const result = await abandonProvider(taskId, provider, { confirm: Boolean(options.confirm), home, store });
    process.stdout.write(`Provider ${options.provider} abandoned. Task state: ${result.state}\n`);
    return;
  }
  if (!["ask", "compare", "code"].includes(command)) {
    throw new WfaError("UNKNOWN_COMMAND", `Unknown command "${command}". Run wfa --help.`);
  }

  if (options["continue-session"] && (options["new-session"] || options.fresh)) {
    throw new WfaError("ARGUMENT_ERROR", "--continue-session conflicts with --fresh/--new-session.");
  }
  if (options["repo-url"] && options["no-repo"]) throw new WfaError("ARGUMENT_ERROR", "--repo-url conflicts with --no-repo.");
  const repository = await resolveRepository({
    cwd: process.cwd(), repoUrl: options["repo-url"], noRepo: Boolean(options["no-repo"]),
  });
  let prompt = command === "code" && options.requirement
    ? (options["prompt-file"] ? await readPrompt({ "prompt-file": options["prompt-file"] }) : "")
    : await readPrompt(options);
  const rawFiles = [...(options.file ?? []), ...(options.dir ?? [])];
  const rawImages = options.image ?? [];
  const expanded = rawFiles.length || rawImages.length
    ? await expandAttachmentInputs({ files: rawFiles, images: rawImages, excludes: options.exclude ?? [], cwd: process.cwd() })
    : { files: [], images: [] };
  const files = expanded.files;
  const images = expanded.images;
  const bundleRepoMode = resolveBundleRepoMode(options["bundle-repo"], command);
  let mode = "full-file";
  if (command === "code") {
    const requirement = options.requirement || prompt;
    if (!requirement) throw new WfaError("ARGUMENT_ERROR", "wfa code requires --requirement or --prompt.");
    if (!files.length && !repository.available && !bundleRepoMode) {
      throw new WfaError("ARGUMENT_ERROR", "wfa code requires --file/--dir or a Git repository with a remote (--repo-url also works).");
    }
    mode = String(options.mode ?? "full-file").toLowerCase();
    if (!["full-file", "spec"].includes(mode)) {
      throw new WfaError("ARGUMENT_ERROR", `Invalid --mode "${mode}". Use "full-file" or "spec".`);
    }
    prompt = buildCodePrompt({
      requirement,
      filePaths: bundleRepoMode === "zip"
        ? ["Source: extract the attached repository archive and read the files you need from it"]
        : bundleRepoMode
          ? ["Source: use the inlined REPOSITORY SOURCE BUNDLE below, not a remote reference"]
          : files.length ? [...files, ...images].map((file) => {
            const relative = path.relative(process.cwd(), path.resolve(file));
            return (relative || path.basename(file)).split(path.sep).join("/");
          }) : (repository.available ? ["Source: read the REPOSITORY reference below directly"] : []),
      context: [options.context, ...(options.requirement && prompt ? [prompt] : [])].filter(Boolean).join("\n\n"),
      mode,
    });
  }
  if (!prompt) throw new WfaError("EMPTY_PROMPT", "Provide --prompt, --prompt-file, or pipe prompt text through stdin.");
  if (options.stage && (command !== "code" || mode !== "full-file")) {
    throw new WfaError("STAGE_REQUIRES_FULL_FILE", "--stage requires wfa code --mode full-file; spec and ordinary ask/compare results cannot be staged.");
  }
  let followupDefaultProviders = null;
  if (options.followup && !options.providers && !options.provider) {
    const snap = await store.snapshot();
    const parent = snap.tasks.tasks[options.followup];
    if (parent?.providers?.length === 1) followupDefaultProviders = parent.providers;
    if (parent?.providers?.length > 1) {
      throw new WfaError("FOLLOWUP_PROVIDER_REQUIRED", `Parent task ${options.followup} has multiple providers. Specify exactly one --provider to continue a verified conversation.`);
    }
  }
  let providers;
  if (command === "compare") {
    providers = normalizeProviders(options.providers ? [options.providers] : (options.provider ? [options.provider] : []), config.defaultCompareProviders);
  } else if (options.providers) providers = normalizeProviders([options.providers], config.defaultCompareProviders);
  else providers = normalizeProviders([options.provider], followupDefaultProviders ?? config.defaultProviders);
  if (providers.length > 1) prompt = buildComparePrompt(prompt, command === "code" ? mode : "full-file");
  if (options["new-session"] || options.fresh) {
    process.stderr.write("Note: --new-session is already the default. ask-bridge can still reuse an open tab; inspect any threadMismatch warning.\n");
  }
  for (const warning of repository.warnings ?? []) process.stderr.write(`Repository warning: ${warning}\n`);
  const modelByProvider = parseMap(options["model-map"], "model-map");
  const result = await executeTask({
    kind: command, prompt, providers, provider: options.provider,
    workspace: defaultWorkspace(options.workspace), files, images, workspaceRoot: process.cwd(),
    repository, repoUrl: options["repo-url"], noRepo: Boolean(options["no-repo"]),
    bundleRepo: Boolean(bundleRepoMode), bundleRepoMode, repoExcludes: options.exclude ?? [],
    bundleLines: command === "code" ? options["no-bundle-lines"] !== true : Boolean(options["bundle-lines"]),
    dryRun: Boolean(options["dry-run"]), allowSensitive: Boolean(options["allow-sensitive"]),
    allowOversize: Boolean(options["allow-oversize"]),
    allowGeminiAttachments: Boolean(options["allow-gemini-attachments"]),
    briefFile: options["brief-file"], noBrief: Boolean(options["no-brief"]),
    followupTaskId: options.followup, continueSession: Boolean(options["continue-session"]),
    stallTimeoutSeconds: options["stall-timeout"] === undefined ? 300 : Number(options["stall-timeout"]),
    detach: Boolean(options.detach), mode,
    timeoutSeconds: options.timeout ? Number(options.timeout) : config.defaultTimeoutSeconds,
    concurrency: options.concurrency ? Number(options.concurrency) : undefined,
    model: options.model, modelByProvider, requestId: options["request-id"],
    fresh: Boolean(options["new-session"] || options.fresh),
    downloadImages: options["download-images"] === undefined ? undefined : Boolean(options["download-images"]),
    onProgressLine: (stream, line) => { process.stderr.write(`[ask-bridge ${stream}] ${line}\n`); },
    onTaskCreated: (task) => {
      process.stderr.write(`Started task ${task.taskId} (request ${task.requestId}); ${options.detach ? "detached worker" : "waiting inside one local CLI process"}.\n`);
    },
  }, { home, store, config });
  if (result.dryRun) {
    process.stdout.write(`${JSON.stringify(result.preview, null, 2)}\n`);
    return result.preview.blocked ? 2 : 0;
  }
  if (options.stage && !result.detached && result.task.state === "completed") {
    for (const p of Object.keys(result.task.children ?? {})) {
      if (result.task.children[p]?.state === "completed" && result.task.children[p].resultPath) {
        await stageTaskFiles(result.task.taskId, { provider: p, home, store });
      }
    }
  }
  printTask(result.task, Boolean(options.json), Boolean(result.replayed));
  if (result.detached) return 0;
  return result.task.state === "completed" ? 0 : 1;
}
