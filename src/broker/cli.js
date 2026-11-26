import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "../paths.js";
import { WfaError } from "../errors.js";
import { startBroker } from "./server.js";
import { createCdpRunner } from "./runner.js";
import {
  discoverBroker,
  ensureBroker,
  createTurn,
  diagnoseBrokerUnreachable,
  getStatus,
  request,
  waitForTurn as clientWaitForTurn,
} from "./client.js";
import { TURN_STATES } from "./turns.js";
import { clearBrokerRecord, readBrokerRecord } from "./lifecycle.js";
import * as defaultJournal from "./journal.js";
import { loadConfig } from "../config.js";

const VALUE_FLAGS = new Set(["mode", "state", "timeout", "provider", "prompt", "prompt-file", "request-id"]);

// Side finding (2026-11-26 branch acceptance): `wfa broker status --json
// | head -4` crashed with EPIPE because stdout.write to a closed pipe has
// no error handler. A stream guarded once never gets a second listener.
const pipeGuardedStreams = new WeakSet();

// Install a closed-pipe guard on the CLI output streams. A consumer that
// closes early (e.g. `| head`) is not a failure: exit 0 instead of
// crashing with an uncaught EPIPE. Any other stream error keeps the old
// behaviour (it surfaces as an uncaught exception). `exit` is injectable
// so tests can observe the decision without killing the test process.
export function installPipeGuard({ stdout = process.stdout, stderr = process.stderr, exit = (code) => process.exit(code) } = {}) {
  for (const stream of [stdout, stderr]) {
    if (!stream || typeof stream.on !== "function" || pipeGuardedStreams.has(stream)) continue;
    pipeGuardedStreams.add(stream);
    stream.on("error", (err) => {
      if (err?.code === "EPIPE") {
        exit(0);
        return;
      }
      throw err;
    });
  }
}

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
    options[name] = value;
  }
  return { positional, options };
}

function printBrokerHelp(stdout = process.stdout) {
  stdout.write(`web-first-ask (wfa) — Broker Engine

Commands:
  wfa broker start [--mode background|visible|headless] [--detach] [--json]
  wfa broker status [--json]
  wfa broker turns [--state <state>] [--json]
  wfa broker clear-orphan <turnId> [--json]
  wfa broker stop [--json]
  wfa broker wait <id> [--timeout <s>] [--json]
  wfa broker ask --provider <chatgpt|gemini> (--prompt <text> | --prompt-file <path> | stdin)
                 [--mode <background|visible|headless>] [--request-id <id>] [--wait] [--timeout <s>] [--json]

Options:
  --mode <mode>           Runner browser mode: background (default), visible, or headless
  --detach                Run broker in the background
  --json                  Output machine-readable JSON
  --state <state>         Filter turns by state
  --timeout <s>           Timeout in seconds (default: 600 for wait/ask)
  --provider <provider>   Provider: chatgpt or gemini
  --prompt <text>         Prompt text to submit
  --prompt-file <path>    Path to prompt file
  --request-id <id>       Optional idempotency key (auto-generated UUID if omitted)
  --wait                  Wait for turn completion
  --help, -h              Show this help message
`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function spawnDetachedBroker({ home, mode = "background", deps = {}, stdout } = {}) {
  const effectiveHome = home || deps.home || getHomeDir();

  const readRecordFn = deps.readBrokerRecord || readBrokerRecord;
  const clearRecordFn = deps.clearBrokerRecord || clearBrokerRecord;
  const checkPidAlive = deps.isPidAlive || pidAlive;
  const staleRecord = await readRecordFn(effectiveHome).catch(() => null);

  if (staleRecord && !checkPidAlive(staleRecord.pid)) {
    await clearRecordFn(effectiveHome, staleRecord.instanceId);
  }

  const logsDir = path.join(effectiveHome, "logs");
  await (deps.mkdir || mkdir)(logsDir, { recursive: true });
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logsDir, `broker-${iso}.log`);
  const openSyncFn = deps.openSync || openSync;
  const closeSyncFn = deps.closeSync || closeSync;
  const fd = openSyncFn(logPath, "a");

  const spawnFn = deps.spawn || spawn;
  const binPath = deps.binPath || process.argv[1] || path.resolve("bin/wfa.js");
  let child;
  try {
    child = spawnFn(process.execPath, [binPath, "broker", "start", "--mode", mode], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        ...(deps.env || {}),
        WFA_HOME: effectiveHome,
      },
    });
    if (child && typeof child.unref === "function") {
      child.unref();
    }
    return child;
  } finally {
    try {
      closeSyncFn(fd);
    } catch {}
  }
}

async function handleStart(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const home = deps.home || getHomeDir();
  const { options } = parseArgs(argv);

  if (options.help) {
    printBrokerHelp(stdout);
    return { code: 0 };
  }

  let runnerMode = "background";
  if (options.mode) {
    runnerMode = String(options.mode).toLowerCase();
    if (!["background", "visible", "headless"].includes(runnerMode)) {
      stderr.write(`wfa: INVALID_ARGUMENT: Invalid mode: ${options.mode}\n`);
      return { code: 1 };
    }
  }

  const discover = deps.discoverBroker || discoverBroker;

  if (options.detach) {
    const existing = await discover(home);
    if (existing) {
      if (options.json) {
        stdout.write(`${JSON.stringify(existing, null, 2)}\n`);
      } else {
        stdout.write(`broker already running on 127.0.0.1:${existing.port} (pid ${existing.pid})\n`);
      }
      return { code: 0 };
    }

    await spawnDetachedBroker({ home, mode: runnerMode, deps, stdout });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await (deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(200);
      const record = await discover(home);
      if (record) {
        if (options.json) {
          stdout.write(`${JSON.stringify(record, null, 2)}\n`);
        } else {
          stdout.write(`broker listening on 127.0.0.1:${record.port} (pid ${record.pid})\n`);
        }
        return { code: 0 };
      }
    }

    stderr.write("wfa: BROKER_TIMEOUT: Broker failed to start within 20s\n");
    return { code: 1 };
  }

  const makeRunner = deps.createCdpRunner || createCdpRunner;
  // F6 (coordinator wiring): load the user config once so the runner
  // (and runCdpTurn via deps.config) sees pace/cooldown/stagger ranges.
  // A config load failure must not stop the broker: defaults apply.
  let brokerConfig = deps.config ?? null;
  if (!brokerConfig) {
    try {
      brokerConfig = await (deps.loadConfig || loadConfig)(home);
    } catch {
      brokerConfig = null;
    }
  }
  const runner = makeRunner({
    home, mode: runnerMode,
    deps: brokerConfig ? { ...deps, config: brokerConfig } : deps,
  });

  const startFn = deps.startBroker || startBroker;
  let serverInstance;
  try {
    serverInstance = await startFn({
      home,
      mode: "tray",
      runner,
      log: deps.log || (() => {}),
    });
  } catch (err) {
    stderr.write(`wfa: ${err?.code || "BROKER_START_FAILED"}: ${err?.message || String(err)}\n`);
    return { code: 1 };
  }

  if (options.json) {
    stdout.write(`${JSON.stringify({
      instanceId: serverInstance.instanceId,
      port: serverInstance.port,
      token: serverInstance.token,
      url: serverInstance.url,
      pid: process.pid,
    }, null, 2)}\n`);
  } else {
    stdout.write(`broker listening on 127.0.0.1:${serverInstance.port} (pid ${process.pid})\n`);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve({ code: 0 });
    };

    const onSignal = async () => {
      try {
        await serverInstance.close();
      } catch {}
      finish();
    };

    if (serverInstance?.closed && typeof serverInstance.closed.then === "function") {
      serverInstance.closed.then(finish, finish);
    }

    if (deps.onServerReady) {
      deps.onServerReady(serverInstance, onSignal);
    }

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

async function handleStatus(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const home = deps.home || getHomeDir();
  const { options } = parseArgs(argv);

  if (options.help) {
    printBrokerHelp(stdout);
    return { code: 0 };
  }

  const discover = deps.discoverBroker || discoverBroker;
  const record = await discover(home);

  if (!record) {
    if (options.json) {
      stdout.write(`${JSON.stringify({ running: false }, null, 2)}\n`);
    } else {
      stdout.write("broker: not running\n");
    }
    return { code: 0 };
  }

  const getStatusFn = deps.getStatus || getStatus;
  try {
    const res = await getStatusFn(record);
    const body = res?.json || {};
    const effectivePort = body.port ?? record.port ?? "";
    if (options.json) {
      stdout.write(`${JSON.stringify({ ...body, ...(body.port !== undefined ? {} : { port: record.port }) }, null, 2)}\n`);
    } else {
      stdout.write(`instanceId: ${body.instanceId ?? ""}\npid: ${body.pid ?? ""}\nport: ${effectivePort}\nmode: ${body.mode ?? ""}\nstartedAt: ${body.startedAt ?? ""}\n`);
      if (body.chrome) {
        stdout.write(`chrome: pid=${body.chrome.pid ?? ""} port=${body.chrome.port ?? ""}\n`);
      }
      if (body.providers) {
        stdout.write(`running: chatgpt=${body.providers.chatgpt ?? 0} gemini=${body.providers.gemini ?? 0}\n`);
      }
    }
    return { code: 0 };
  } catch {
    if (options.json) {
      stdout.write(`${JSON.stringify({ running: false }, null, 2)}\n`);
    } else {
      stdout.write("broker: not running\n");
    }
    return { code: 0 };
  }
}

async function handleTurns(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const home = deps.home || getHomeDir();
  const { options } = parseArgs(argv);

  if (options.help) {
    printBrokerHelp(stdout);
    return { code: 0 };
  }

  if (options.state && !TURN_STATES.includes(options.state)) {
    stderr.write(`wfa: INVALID_ARGUMENT: Invalid turn state: ${options.state}\n`);
    return { code: 1 };
  }

  const discover = deps.discoverBroker || discoverBroker;
  const record = await discover(home);
  if (!record) {
    stderr.write("wfa: BROKER_NOT_RUNNING: Broker is not running\n");
    return { code: 1 };
  }

  const reqFn = deps.request || request;
  const route = options.state ? `/turns?state=${encodeURIComponent(options.state)}` : "/turns";
  try {
    const res = await reqFn(record, "GET", route);
    const turns = res?.json || [];
    const journal = deps.journal || defaultJournal;
    const orphans = await journal.listOrphans(home).catch(() => []);

    if (options.json) {
      stdout.write(`${JSON.stringify({ turns, orphans }, null, 2)}\n`);
    } else {
      for (const turn of turns) {
        const elapsed = turn.startedAt
          ? `${Math.round((Date.now() - new Date(turn.startedAt).getTime()) / 1000)}s`
          : "-";
        const preview = (turn.promptPreview || "").slice(0, 60);
        stdout.write(`${turn.id}  ${turn.state}  ${turn.provider}  ${elapsed}  ${turn.reason || "-"}  ${preview}\n`);
      }
      stdout.write(`orphaned turns: ${orphans.length}\n`);
      for (const orphan of orphans) {
        stdout.write(`  ${orphan.turnId}  ${orphan.submittedAt}  ${orphan.provider}\n`);
      }
    }
    return { code: 0, turns, orphans };
  } catch (err) {
    stderr.write(`wfa: BROKER_UNREACHABLE: ${err?.message || String(err)}\n`);
    return { code: 1 };
  }
}

async function handleStop(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const home = deps.home || getHomeDir();
  const { options } = parseArgs(argv);

  if (options.help) {
    printBrokerHelp(stdout);
    return { code: 0 };
  }

  const discover = deps.discoverBroker || discoverBroker;
  const record = await discover(home);
  if (!record) {
    stderr.write("wfa: BROKER_UNREACHABLE: Broker is not running\n");
    return { code: 1 };
  }

  const reqFn = deps.request || request;
  try {
    await reqFn(record, "POST", "/shutdown");
    if (options.json) {
      stdout.write(`${JSON.stringify({ stopping: true }, null, 2)}\n`);
    } else {
      stdout.write("broker stopping\n");
    }
    return { code: 0 };
  } catch (err) {
    stderr.write(`wfa: BROKER_UNREACHABLE: ${err?.message || String(err)}\n`);
    return { code: 1 };
  }
}

function readStdinFromStream(stream = process.stdin, firstByteTimeoutMs = 400) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof stream.pause === "function") {
        try { stream.pause(); } catch {}
      }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    };
    const timer = setTimeout(() => { if (!chunks.length) finish(); }, firstByteTimeoutMs);
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", finish);
    stream.on("error", finish);
    if (typeof stream.resume === "function") {
      try { stream.resume(); } catch {}
    }
  });
}

async function resolvePrompt(options, positional = [], deps = {}) {
  if (options.prompt && options["prompt-file"]) {
    throw new WfaError("INVALID_ARGUMENT", "Use only one of --prompt and --prompt-file.");
  }
  if (options["prompt-file"]) {
    const readFileFn = deps.readFile || readFile;
    const content = await readFileFn(path.resolve(options["prompt-file"]), "utf8");
    return content.trim();
  }
  if (options.prompt) {
    return String(options.prompt).trim();
  }
  if (positional.length) {
    return positional.join(" ").trim();
  }
  if (deps.readStdin) {
    return (await deps.readStdin()).trim();
  }
  const stdinStream = deps.stdin || process.stdin;
  if (!stdinStream.isTTY) {
    return await readStdinFromStream(stdinStream, 400);
  }
  return "";
}

async function waitForTurn({
  record,
  turnId,
  home,
  timeoutSec = 600,
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
  deps = {},
}) {
  const waitFn = deps.waitForTurn || clientWaitForTurn;
  let turn;
  try {
    turn = await waitFn({
      record,
      turnId,
      home,
      timeoutMs: timeoutSec * 1000,
      deps,
    });
  } catch (err) {
    if (err?.code === "TIMEOUT") {
      stderr.write(`wfa: TIMEOUT: Turn ${turnId} did not finish within ${timeoutSec}s\n`);
      return { code: 1 };
    }
    throw err;
  }

  const state = turn.state;
  if (state === "completed") {
    if (json) {
      stdout.write(`${JSON.stringify(turn, null, 2)}\n`);
    } else {
      const text = turn.text || "";
      stdout.write(`${text}${text.endsWith("\n") ? "" : "\n"}`);
    }
    return { code: 0, turn };
  }

  if (json) {
    stdout.write(`${JSON.stringify(turn, null, 2)}\n`);
  } else {
    const warning = turn.sendCommittedAt ? " (prompt was already sent; do not resend)" : "";
    stderr.write(`[broker] turn ${turnId} ended with state=${state} reason=${turn.reason || ""}${warning}\n`);
  }
  return { code: 1, turn };
}

async function handleWait(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const home = deps.home || getHomeDir();
  const { positional, options } = parseArgs(argv);

  if (options.help) {
    printBrokerHelp(stdout);
    return { code: 0 };
  }

  const turnId = positional[0];
  if (!turnId) {
    stderr.write("wfa: INVALID_ARGUMENT: Turn ID is required\n");
    return { code: 1 };
  }

  let timeoutSec = 600;
  if (options.timeout !== undefined) {
    const t = Number(options.timeout);
    if (!Number.isFinite(t) || t <= 0) {
      stderr.write(`wfa: INVALID_ARGUMENT: Invalid --timeout: ${options.timeout}\n`);
      return { code: 1 };
    }
    timeoutSec = t;
  }

  const discover = deps.discoverBroker || discoverBroker;
  const record = await discover(home);
  if (!record) {
    const diag = await diagnoseBrokerUnreachable({ home, turnId, deps });
    const err = Object.assign(
      new Error(`BROKER_UNREACHABLE: Broker is not running (submissionState=${diag.submissionState}, safeToResend=${diag.safeToResend})`),
      { code: "BROKER_UNREACHABLE", turnId, ...diag }
    );
    stderr.write(`wfa: ${err.message}\n`);
    return { code: 1, error: err };
  }

  return await waitForTurn({
    record,
    turnId,
    home,
    timeoutSec,
    json: Boolean(options.json),
    stdout,
    stderr,
    deps,
  });
}

async function handleBrokerAsk(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const home = deps.home || getHomeDir();

  let positional, options;
  try {
    const parsed = parseArgs(argv);
    positional = parsed.positional;
    options = parsed.options;
  } catch (err) {
    stderr.write(`wfa: ${err?.code || "INVALID_ARGUMENT"}: ${err?.message || String(err)}\n`);
    return { code: 2 };
  }

  if (options.help) {
    printBrokerHelp(stdout);
    return { code: 0 };
  }

  const provider = options.provider ? String(options.provider).toLowerCase() : "";
  if (!provider || !["chatgpt", "gemini", "claude"].includes(provider)) {
    stderr.write("wfa: INVALID_ARGUMENT: Provider must be chatgpt, gemini, or claude\n");
    return { code: 2 };
  }

  let mode;
  if (options.mode) {
    mode = String(options.mode).toLowerCase();
    if (!["background", "visible", "headless"].includes(mode)) {
      stderr.write(`wfa: INVALID_ARGUMENT: Invalid mode: ${options.mode}\n`);
      return { code: 2 };
    }
  }

  let requestId;
  if (options["request-id"] !== undefined) {
    requestId = String(options["request-id"]).trim();
    if (!requestId) {
      stderr.write("wfa: INVALID_ARGUMENT: Option --request-id must be a non-empty string.\n");
      return { code: 2 };
    }
  } else {
    requestId = deps.requestId || randomUUID();
  }

  let prompt;
  try {
    prompt = await resolvePrompt(options, positional, deps);
  } catch (err) {
    stderr.write(`wfa: ${err?.code || "INVALID_ARGUMENT"}: ${err?.message || String(err)}\n`);
    return { code: 2 };
  }

  if (!prompt) {
    stderr.write("wfa: INVALID_ARGUMENT: Prompt is required\n");
    return { code: 2 };
  }

  let timeoutSec = 600;
  if (options.timeout !== undefined) {
    const t = Number(options.timeout);
    if (!Number.isFinite(t) || t <= 0) {
      stderr.write(`wfa: INVALID_ARGUMENT: Invalid --timeout: ${options.timeout}\n`);
      return { code: 2 };
    }
    timeoutSec = t;
  }

  const ensureFn = deps.ensureBroker || ensureBroker;
  let record;
  try {
    record = await ensureFn({
      home,
      spawnBroker: () => spawnDetachedBroker({ home, mode: mode || "background", deps, stdout }),
    });
  } catch (err) {
    stderr.write(`wfa: ${err?.code || "BROKER_TIMEOUT"}: ${err?.message || String(err)}\n`);
    return { code: 1 };
  }

  const createTurnFn = deps.createTurn || createTurn;
  let turnRes;
  try {
    turnRes = await createTurnFn(record, {
      provider,
      prompt,
      requestId,
      ...(mode ? { mode } : {}),
    });
  } catch (err) {
    stderr.write(`wfa: ${err?.code || "BROKER_UNREACHABLE"}: ${err?.message || String(err)}\n`);
    return { code: 1 };
  }

  const created = turnRes?.json;

  if (turnRes?.status >= 400) {
    if (options.json) {
      stdout.write(`${JSON.stringify({
        error: created?.error || created?.code || "BROKER_ERROR",
        status: turnRes.status,
        ...(created?.orphan ? { orphan: created.orphan } : {}),
        ...(created?.hint ? { hint: created.hint } : {}),
        ...(created?.requestId ? { requestId: created.requestId } : {}),
        ...(created?.turnId ? { turnId: created.turnId } : {}),
      }, null, 2)}\n`);
    } else {
      const code = String(created?.error || created?.code || "BROKER_ERROR").toUpperCase();
      const hint = typeof created?.hint === "string" ? created.hint.trim() : "";
      const detail = [`HTTP ${turnRes.status}`, hint].filter(Boolean).join("; ");
      stderr.write(`wfa: ${code}: ${detail}\n`);
    }
    return { code: 1, error: created };
  }

  const turnId = created?.id;
  if (!turnId) {
    stderr.write("wfa: BROKER_ERROR: Failed to create turn\n");
    return { code: 1 };
  }

  if (!options.wait) {
    if (options.json) {
      stdout.write(`${JSON.stringify({ id: turnId, state: created?.state || "accepted" }, null, 2)}\n`);
    } else {
      stdout.write(`turn ${turnId}\n`);
    }
    return { code: 0, turn: created };
  }

  return await waitForTurn({
    record,
    turnId,
    home,
    timeoutSec,
    json: Boolean(options.json),
    stdout,
    stderr,
    deps,
  });
}

async function handleClearOrphan(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const home = deps.home || getHomeDir();
  const { positional, options } = parseArgs(argv);

  const turnId = positional[0];
  if (!turnId) {
    stderr.write("wfa: INVALID_ARGUMENT: Missing <turnId> for clear-orphan\n");
    return { code: 1 };
  }

  const journal = deps.journal || defaultJournal;
  const orphans = await journal.listOrphans(home).catch(() => []);
  const orphan = orphans.find((o) => o.turnId === turnId);
  if (!orphan) {
    stderr.write(`wfa: NOT_FOUND: Orphan turn "${turnId}" not found\n`);
    return { code: 1 };
  }

  await journal.clearCommit(home, turnId);
  if (options.json) {
    stdout.write(`${JSON.stringify({ cleared: true, orphan }, null, 2)}\n`);
  } else {
    stdout.write(`cleared orphan ${orphan.turnId} (${orphan.provider}, submittedAt: ${orphan.submittedAt})\n`);
  }
  return { code: 0, cleared: true, orphan };
}

export async function runBrokerCommand(argv = [], deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  // EPIPE guard (see installPipeGuard): piping to `head` must exit
  // cleanly instead of crashing the command.
  installPipeGuard({ stdout, stderr, ...(deps.pipeGuardExit ? { exit: deps.pipeGuardExit } : {}) });

  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printBrokerHelp(stdout);
    return { code: 0 };
  }

  const subcmd = argv[0];
  if (!subcmd || !["start", "status", "turns", "stop", "wait", "ask", "clear-orphan"].includes(subcmd)) {
    stderr.write(`wfa: UNKNOWN_COMMAND: Unknown or missing broker subcommand "${subcmd || ""}". Usage: wfa broker <start|status|turns|stop|wait|ask|clear-orphan>\n`);
    return { code: 2 };
  }

  try {
    if (subcmd === "start") return await handleStart(argv.slice(1), deps);
    if (subcmd === "status") return await handleStatus(argv.slice(1), deps);
    if (subcmd === "turns") return await handleTurns(argv.slice(1), deps);
    if (subcmd === "stop") return await handleStop(argv.slice(1), deps);
    if (subcmd === "wait") return await handleWait(argv.slice(1), deps);
    if (subcmd === "ask") return await handleBrokerAsk(argv.slice(1), deps);
    if (subcmd === "clear-orphan") return await handleClearOrphan(argv.slice(1), deps);
  } catch (error) {
    if (error instanceof WfaError) {
      stderr.write(`wfa: ${error.code}: ${error.message}\n`);
      const code = (subcmd === "ask" && (error.code === "INVALID_ARGUMENT" || error.code === "ARGUMENT_ERROR")) ? 2 : 1;
      return { code, error };
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`wfa: ${message}\n`);
    return { code: 1, error };
  }
}
