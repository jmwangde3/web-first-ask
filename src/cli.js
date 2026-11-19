import { copyFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { getHomeDir } from "./paths.js";
import { loadConfig } from "./config.js";
import { executeTask, refreshTask } from "./runner.js";
import { collectTask, listTasks, abandonProvider } from "./recovery.js";
import { checkAskBridge, resolveAskBridge, runProcess } from "./ask-bridge.js";
import { buildCodePrompt, buildComparePrompt } from "./prompts.js";
import { normalizeProviders } from "./jobs.js";
import { WfaError } from "./errors.js";
import { updateAskBridge } from "./maintenance.js";
import { truncate } from "./util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALUE_FLAGS = new Set([
  "provider", "providers", "workspace", "prompt", "prompt-file", "requirement",
  "file", "image", "timeout", "request-id", "concurrency", "reasoning",
  "reasoning-map", "model", "model-map", "context", "limit",
]);
const REPEAT_FLAGS = new Set(["file", "image"]);

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equalAt = token.indexOf("=");
    const name = token.slice(2, equalAt === -1 ? undefined : equalAt);
    if (!name) throw new WfaError("ARGUMENT_ERROR", `Invalid option: ${token}`);
    let value;
    if (equalAt !== -1) {
      value = token.slice(equalAt + 1);
    } else if (VALUE_FLAGS.has(name)) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new WfaError("ARGUMENT_ERROR", `Option --${name} requires a value.`);
      }
    } else {
      value = true;
    }
    if (REPEAT_FLAGS.has(name)) {
      options[name] ??= [];
      options[name].push(value);
    } else {
      options[name] = value;
    }
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
  if (options.prompt && options["prompt-file"]) {
    throw new WfaError("ARGUMENT_ERROR", "Use only one of --prompt and --prompt-file.");
  }
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

function printTask(task, json = false, replayed = false) {
  const children = Object.fromEntries(Object.entries(task.children ?? {}).map(([provider, child]) => [provider, {
    state: child.state,
    result: child.resultPath ?? null,
    thread: child.threadUrl ?? null,
    error: child.error ?? null,
  }]));
  const summary = {
    taskId: task.taskId,
    requestId: task.requestId,
    workspace: task.workspace,
    kind: task.kind,
    state: task.state,
    replayed,
    providers: children,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Task: ${task.taskId}${replayed ? " (existing request; not resent)" : ""}\n`);
  process.stdout.write(`Workspace: ${task.workspace}\nState: ${task.state}\n`);
  for (const [provider, child] of Object.entries(children)) {
    process.stdout.write(`- ${provider}: ${child.state}\n`);
    if (child.result) process.stdout.write(`  Result: ${child.result}\n`);
    if (child.thread) process.stdout.write(`  Conversation: ${child.thread}\n`);
    if (child.error) process.stdout.write(`  Detail: ${truncate(child.error, 500)}\n`);
  }
  process.stdout.write("Use `wfa status <task-id>` to inspect or `wfa collect <task-id> --provider <provider> --confirm-complete` only after confirming generation has finished.\n");
}

function help() {
  process.stdout.write(`web-first-ask (wfa) — Codex-first web AI delegation

Commands:
  wfa ask       Ask one provider (default: ChatGPT)
  wfa compare   Ask multiple providers concurrently and keep separate answers
  wfa code      Ask for complete replacement code for attached source files
  wfa status    Inspect a task by ID
  wfa list      List recent tasks
  wfa collect   Collect a response after you have confirmed generation completed
  wfa resolve   Abandon an unresolved provider task after confirming it is no longer running
  wfa login     Log in to a provider through ask-bridge
  wfa doctor    Check Node.js and ask-bridge integration
  wfa install-skill  Install the web-first Skill into the Codex user Skills directory
  wfa upstream update  Update ask-bridge using its official updater

Common options:
  --provider chatgpt|gemini|claude
  --providers chatgpt,gemini[,claude]
  --workspace <stable-project-key>
  --prompt <text> | --prompt-file <path> | stdin
  --file <path>        Repeatable document/source attachment
  --image <path>       Repeatable image attachment (not supported by Gemini)
  --timeout <seconds>  Default 1200; maximum 7200

  --model <name>       Single-provider request only
  --model-map chatgpt=<name>,gemini=<name>
  --context <text>     Additional code-generation context
  --download-images    Download generated images (off by default)
  --new-session        Do not reuse the saved workspace/provider conversation
  --request-id <id>    Reuse only to recover the exact same logical request
  --json               Print a compact machine-readable summary

Code mode:
  wfa code --requirement "..." --file src/a.js --file test/a.test.js --workspace repo-name

Multi-provider:
  wfa compare --providers 'chatgpt,gemini' --prompt-file question.md --workspace repo-name
  wfa code --providers 'chatgpt,gemini' --requirement "..." --file src/a.js

Safety:
  A timed-out/recoverable/unknown task is never resent automatically.
  A provider/workspace remains locked until collect or explicit resolve.
`);
}

async function runLogin(provider, config) {
  const command = resolveAskBridge(config);
  const result = await runProcess(command, ["--backend", "browser", "--provider", provider, "login"], { inherit: true });
  if (result.spawnError || result.code !== 0) {
    throw new WfaError("LOGIN_FAILED", result.spawnError?.message ?? `ask-bridge login exited with ${result.code}.`);
  }
}

async function installSkill() {
  const source = path.join(ROOT, "skills", "web-first", "SKILL.md");
  const destination = path.join(os.homedir(), ".codex", "skills", "web-first", "SKILL.md");
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  process.stdout.write(`Installed Skill: ${destination}\nRestart or refresh Codex Skill discovery if needed.\n`);
}

async function doctor(config) {
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const supported = (nodeMajor === 20 && nodeMinor >= 19)
    || (nodeMajor === 22 && nodeMinor >= 12)
    || nodeMajor >= 23;
  if (!supported) {
    throw new WfaError("NODE_VERSION", `ask-bridge requires Node.js ^20.19.0, ^22.12.0 or >=23.0.0; found ${process.versions.node}.`);
  }
  const result = await checkAskBridge(config);
  process.stdout.write(`Node.js: ${process.versions.node} OK\n`);
  process.stdout.write(`ask-bridge: ${result.version}\n`);
  process.stdout.write(`Batch command: available\n`);
  process.stdout.write(`Data directory: ${getHomeDir()}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    help();
    return;
  }
  const { positional, options } = parseArgs(rest);
  if (options.help) {
    help();
    return;
  }
  if (
    Object.prototype.hasOwnProperty.call(options, "reasoning")
    || Object.prototype.hasOwnProperty.call(options, "reasoning-map")
  ) {
    throw new WfaError(
      "REASONING_DISABLED",
      "Reasoning-strength selection is temporarily disabled. Remove --reasoning/--reasoning-map; WFA now uses each provider's current web UI setting.",
    );
  }
  const home = getHomeDir();
  const config = await loadConfig(home);
  const store = new Store(home);

  if (command === "doctor") return doctor(config);
  if (command === "install-skill") return installSkill();
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
    const result = tasks.slice(0, Number(options.limit ?? 20)).map((task) => ({
      taskId: task.taskId,
      workspace: task.workspace,
      kind: task.kind,
      state: task.state,
      providers: Object.fromEntries(Object.entries(task.children).map(([key, value]) => [key, value.state])),
      createdAt: task.createdAt,
    }));
    process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : result.map((item) => `${item.taskId}  ${item.state.padEnd(16)} ${item.workspace}  ${Object.entries(item.providers).map(([p, s]) => `${p}:${s}`).join(" ")}`).join("\n")}\n`);
    return;
  }
  if (command === "collect") {
    const taskId = positional[0];
    if (!taskId) throw new WfaError("ARGUMENT_ERROR", "Usage: wfa collect <task-id> --provider <provider> --confirm-complete");
    const result = await collectTask(taskId, {
      provider: options.provider,
      confirmComplete: Boolean(options["confirm-complete"]),
      home,
      store,
      config,
    });
    process.stdout.write(`Collected ${result.provider}: ${result.resultPath}\nTask state: ${result.task.state}\n`);
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

  let prompt = command === "code" && options.requirement
    ? (options["prompt-file"] ? await readPrompt({ "prompt-file": options["prompt-file"] }) : "")
    : await readPrompt(options);
  const files = options.file ?? [];
  const images = options.image ?? [];
  if (command === "code") {
    const requirement = options.requirement || prompt;
    if (!requirement) throw new WfaError("ARGUMENT_ERROR", "wfa code requires --requirement or --prompt.");
    if (!files.length) throw new WfaError("ARGUMENT_ERROR", "wfa code requires at least one complete source/test file via --file.");
    prompt = buildCodePrompt({
      requirement,
      filePaths: files.map((file) => path.relative(process.cwd(), path.resolve(file)) || path.basename(file)),
      context: options.context ?? "",
    });
  }
  if (!prompt) throw new WfaError("EMPTY_PROMPT", "Provide --prompt, --prompt-file, or pipe prompt text through stdin.");

  let providers;
  if (command === "compare") {
    providers = normalizeProviders(
      options.providers ? [options.providers] : (options.provider ? [options.provider] : []),
      config.defaultCompareProviders,
    );
  } else if (options.providers) {
    providers = normalizeProviders([options.providers], config.defaultCompareProviders);
  } else {
    providers = normalizeProviders([options.provider], [config.defaultProvider]);
  }
  if (providers.length > 1) prompt = buildComparePrompt(prompt);


  const modelByProvider = parseMap(options["model-map"], "model-map");

  const result = await executeTask({
    kind: command,
    prompt,
    providers,
    provider: options.provider,
    workspace: defaultWorkspace(options.workspace),
    files,
    images,
    timeoutSeconds: options.timeout ? Number(options.timeout) : config.defaultTimeoutSeconds,
    concurrency: options.concurrency ? Number(options.concurrency) : undefined,

    model: options.model,
    modelByProvider,
    requestId: options["request-id"],
    fresh: Boolean(options["new-session"]),
    downloadImages: options["download-images"] === undefined ? undefined : Boolean(options["download-images"]),
    onTaskCreated: (task) => {
      process.stderr.write(`Started task ${task.taskId} (request ${task.requestId}); waiting inside one local CLI process.\n`);
    },
  }, { home, store, config });

  printTask(result.task, Boolean(options.json), Boolean(result.replayed));
  return result.task.state === "completed" ? 0 : 1;
}
