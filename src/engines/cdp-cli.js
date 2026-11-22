import { readFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "../paths.js";
import { WfaError } from "../errors.js";
import { runCdpTurn } from "./cdp-engine.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import { sleep as defaultSleep } from "../util.js";

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
};

const VALUE_FLAGS = new Set([
  "provider",
  "prompt",
  "prompt-file",
  "mode",
  "timeout",
  "settle",
  "chrome-path",
]);

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

function readStdin(firstByteTimeoutMs = 400) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch {}
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    };
    const timer = setTimeout(() => { if (!chunks.length) finish(); }, firstByteTimeoutMs);
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    try { process.stdin.resume(); } catch {}
  });
}

function printCdpHelp(stdout = process.stdout) {
  stdout.write(`web-first-ask (wfa) — CDP Browser Kernel Engine

Commands:
  wfa cdp ask    --provider <chatgpt|gemini> (--prompt <text> | --prompt-file <path> | stdin)
                 [--mode background|visible|headless] [--json] [--timeout <s>] [--settle <ms>]
  wfa cdp status [--json]
  wfa cdp login  [--provider <chatgpt|gemini>] [--mode visible|background]
                 [--timeout <seconds>] [--json]

Options:
  --provider <name>       chatgpt or gemini
  --prompt <text>         Prompt string
  --prompt-file <path>    Path to prompt file
  --mode <mode>           background (default for ask, visible for login), visible, or headless
  --json                  Output machine-readable JSON
  --timeout <seconds>     Overall / stall timeout in seconds
  --settle <ms>           Answer stabilization window in milliseconds (default: 4000)
  --help, -h              Show this help message
`);
}

async function handleStatus(options, deps) {
  const stdout = deps.stdout || process.stdout;
  const home = deps.home || getHomeDir();

  let record = null;
  if (typeof deps.readBrokerRecord === "function") {
    try {
      record = await deps.readBrokerRecord(home);
    } catch {}
  } else {
    try {
      const brokerPath = path.join(home, "broker.json");
      const content = await readFile(brokerPath, "utf8");
      record = JSON.parse(content);
    } catch {}
  }

  if (record && typeof record === "object") {
    if (options.json) {
      stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      stdout.write(`instanceId: ${record.instanceId ?? ""}\npid: ${record.pid ?? ""}\nport: ${record.port ?? ""}\nmode: ${record.mode ?? ""}\nstartedAt: ${record.startedAt ?? ""}\n`);
    }
  } else {
    if (options.json) {
      stdout.write(`${JSON.stringify({ running: false, message: "broker: not running" }, null, 2)}\n`);
    } else {
      stdout.write("broker: not running\n");
    }
  }

  return { code: 0 };
}

async function handleLogin(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const { options } = parseArgs(argv);

  if (options.help) {
    printCdpHelp(stdout);
    return { code: 0 };
  }

  const provider = options.provider ? String(options.provider).toLowerCase() : "chatgpt";
  if (provider !== "chatgpt" && provider !== "gemini") {
    throw new WfaError("INVALID_ARGUMENT", `Invalid provider "${options.provider}". Must be chatgpt or gemini.`);
  }

  let mode = "visible";
  if (options.mode) {
    mode = String(options.mode).toLowerCase();
    if (!["visible", "background", "headless"].includes(mode)) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid mode: ${options.mode}. Must be visible or background.`);
    }
  }

  let timeoutSec = 900;
  if (options.timeout !== undefined) {
    const t = Number(options.timeout);
    if (!Number.isFinite(t) || t <= 0) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --timeout: ${options.timeout}`);
    }
    timeoutSec = t;
  }

  const recover = deps.recoverBrowser || recoverBrowser;
  const connect = deps.connectCdp || connectCdp;
  const driver = deps.driver || defaultDriver;
  const sleepFn = deps.sleep || defaultSleep;
  const nowFn = deps.now || (() => Date.now());
  const home = deps.home || getHomeDir();

  const recovery = await recover({
    home,
    mode,
    chromePath: options["chrome-path"],
    probes: deps.probes,
  });

  if (!recovery.chrome?.port) {
    throw new WfaError("CHROME_START_FAILED", "Chrome port is missing from recovery");
  }

  let cdp = null;
  let targetId = null;
  let sessionId = null;

  try {
    cdp = await connect(recovery.chrome.port);
    const adapters = deps.adapters || DEFAULT_ADAPTERS;
    const adapter = adapters[provider] || (provider === "gemini" ? geminiAdapter : chatgptAdapter);
    const targetUrl = adapter.url || (provider === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/");

    const tab = await driver.openTab(cdp, targetUrl, { timeoutMs: timeoutSec * 1000 });
    targetId = tab.targetId;
    sessionId = tab.sessionId;

    if (!options.json) {
      stdout.write("[cdp] a visible Chrome window is open. Log in, then leave it running; this command polls until the logged-in composer appears.\n");
    }

    const pollIntervalMs = deps.pollIntervalMs || 2000;
    const startTime = nowFn();
    const deadline = startTime + timeoutSec * 1000;

    let loggedIn = false;
    let finalTitle = "";

    const checkExpr = provider === "chatgpt"
      ? `(() => {
          const hasLoggedInEditor = Boolean(document.querySelector('div.ProseMirror[contenteditable="true"]')) && !document.querySelector('textarea#mobile-composer-prompt');
          const title = document.title || "";
          return { loggedIn: hasLoggedInEditor, title };
        })()`
      : `(() => {
          const hasUserQuery = document.querySelectorAll("user-query").length > 0;
          const hasAccountBtn = Boolean(document.querySelector('button[aria-label*="Google 账号"], img[aria-label*="个人资料"]'));
          const title = document.title || "";
          return { loggedIn: (hasUserQuery || hasAccountBtn), title };
        })()`;

    const challengePattern = adapter.challengeTitlePattern || /请稍候|just a moment|verifying|security check|cloudflare|人机验证/i;

    while (nowFn() < deadline) {
      try {
        const evalRes = await cdp.send("Runtime.evaluate", {
          expression: checkExpr,
          returnByValue: true,
        }, sessionId);

        const val = evalRes?.result?.value;
        if (val) {
          finalTitle = val.title || "";
          const isChallenged = challengePattern.test(finalTitle);
          if (val.loggedIn && !isChallenged) {
            loggedIn = true;
            break;
          }
        }
      } catch (err) {
        if (err?.code === "CDP_CLOSED") throw err;
      }

      await sleepFn(pollIntervalMs);
    }

    if (loggedIn) {
      if (options.json) {
        stdout.write(`${JSON.stringify({ status: "completed", provider, title: finalTitle }, null, 2)}\n`);
      } else {
        stdout.write(`[cdp] logged in as ${finalTitle}\n`);
      }
      return { code: 0, result: { status: "completed", provider, title: finalTitle } };
    }

    if (options.json) {
      stdout.write(`${JSON.stringify({ status: "timeout", provider, timeout: timeoutSec }, null, 2)}\n`);
    } else {
      stdout.write(`[cdp] login not detected within ${timeoutSec}s; the profile is unchanged\n`);
    }
    return { code: 1, result: { status: "timeout", provider, timeout: timeoutSec } };
  } finally {
    if (cdp) {
      try {
        cdp.close();
      } catch {}
    }
  }
}

async function handleAsk(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  const { positional, options } = parseArgs(argv);

  if (options.help) {
    printCdpHelp(stdout);
    return { code: 0 };
  }

  if (!options.provider) {
    throw new WfaError("INVALID_ARGUMENT", "Option --provider is required. Must be chatgpt or gemini.");
  }
  const provider = String(options.provider).toLowerCase();
  if (provider !== "chatgpt" && provider !== "gemini") {
    throw new WfaError("INVALID_ARGUMENT", `Invalid provider "${options.provider}". Must be chatgpt or gemini.`);
  }

  let prompt = "";
  if (options["prompt-file"]) {
    try {
      prompt = (await readFile(path.resolve(options["prompt-file"]), "utf8")).trim();
    } catch (err) {
      throw new WfaError("FILE_ERROR", `Failed to read prompt file: ${err.message}`);
    }
  } else if (options.prompt) {
    prompt = String(options.prompt).trim();
  } else if (positional.length) {
    prompt = positional.join(" ").trim();
  } else if (deps.stdin !== undefined) {
    prompt = String(deps.stdin).trim();
  } else if (!process.stdin.isTTY) {
    prompt = await readStdin();
  }

  if (!prompt) {
    throw new WfaError("EMPTY_PROMPT", "Provide --prompt, --prompt-file, or pipe prompt text through stdin.");
  }

  let mode = "background";
  if (options.mode) {
    mode = String(options.mode).toLowerCase();
    if (!["background", "visible", "headless"].includes(mode)) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid mode: ${options.mode}. Must be background, visible, or headless.`);
    }
  }

  let hardTimeoutMs = 900000;
  let stallTimeoutMs = 180000;
  if (options.timeout !== undefined) {
    const timeoutSec = Number(options.timeout);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --timeout: ${options.timeout}`);
    }
    hardTimeoutMs = timeoutSec * 1000;
    stallTimeoutMs = Math.min(hardTimeoutMs, 180000);
  }

  let settleMs = 4000;
  if (options.settle !== undefined) {
    settleMs = Number(options.settle);
    if (!Number.isFinite(settleMs) || settleMs < 0) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --settle: ${options.settle}`);
    }
  }

  const turnFn = deps.runCdpTurn || runCdpTurn;
  const result = await turnFn({
    provider,
    prompt,
    home: deps.home,
    mode,
    chromePath: options["chrome-path"],
    settleMs,
    stallTimeoutMs,
    hardTimeoutMs,
    keepBrowser: Boolean(options["keep-browser"]),
    deps,
  });

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const elapsedSec = ((result.elapsedMs ?? 0) / 1000).toFixed(1);
    stdout.write(`[cdp] provider=${provider} status=${result.status} elapsed=${elapsedSec}s\n`);
    if (result.status === "completed" && result.text) {
      stdout.write(`${result.text}${result.text.endsWith("\n") ? "" : "\n"}`);
    } else if (result.status !== "completed" && result.reason) {
      stderr.write(`[cdp] reason: ${result.reason}\n`);
    }
  }

  return { code: result.status === "completed" ? 0 : 1, result };
}

export async function runCdpCommand(argv = [], deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printCdpHelp(stdout);
    return { code: 0 };
  }

  const subcmd = argv[0];
  if (!subcmd || !["ask", "status", "login"].includes(subcmd)) {
    stderr.write(`wfa: UNKNOWN_COMMAND: Unknown or missing cdp subcommand "${subcmd || ""}". Usage: wfa cdp <ask|status|login>\n`);
    return { code: 2 };
  }

  try {
    if (subcmd === "status") {
      const { options } = parseArgs(argv.slice(1));
      if (options.help) {
        printCdpHelp(stdout);
        return { code: 0 };
      }
      return await handleStatus(options, deps);
    }
    if (subcmd === "login") {
      const loginFn = deps.runCdpLogin || handleLogin;
      return await loginFn(argv.slice(1), deps);
    }
    return await handleAsk(argv.slice(1), deps);
  } catch (error) {
    if (error instanceof WfaError) {
      stderr.write(`wfa: ${error.code}: ${error.message}\n`);
      return { code: 1, error };
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`wfa: ${message}\n`);
    return { code: 1, error };
  }
}
