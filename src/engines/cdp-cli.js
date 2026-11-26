import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "../paths.js";
import { WfaError } from "../errors.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import { sleep as defaultSleep } from "../util.js";
import { readBrokerRecord, isInstanceAlive } from "../broker/lifecycle.js";
import { ensureBroker, createTurn, waitForTurn, waitForSubmission } from "../broker/client.js";
import { spawnDetachedBroker } from "../broker/cli.js";
import { stageCdpResponse as defaultStageCdpResponse } from "./cdp-stage.js";
import { expandAttachmentInputs } from "../attachments.js";
import { readConversation as defaultReadConversation } from "./cdp-read.js";

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
};

const VALUE_FLAGS = new Set([
  "provider",
  "prompt",
  "prompt-file",
  "mode",
  "gemini-mode",
  "timeout",
  "settle",
  "chrome-path",
  "min-interval",
  "conversation-id",
  "request-id",
  "workspace",
  "file",
  "url",
  "task-id",
  "wait",
  "out",
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
    // --file 可重复：累积为数组，不覆盖
    if (name === "file") {
      if (!options.file) options.file = [value];
      else if (Array.isArray(options.file)) options.file.push(value);
      else options.file = [options.file, value];
    } else {
      options[name] = value;
    }
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
                 [--mode background|visible|headless] [--conversation-id <id>] [--request-id <id>] [--json]
                 [--timeout <s>] [--settle <ms>] [--min-interval <ms>]
                 [--file <path|glob|dir>] [--no-stage] [--no-wait] [--workspace <dir>]
  wfa cdp read   (--url <conversation-url> | --task-id <id>)
                 [--provider <chatgpt|gemini>] [--mode background|visible|headless]
                 [--timeout <s>] [--wait <s>] [--no-reopen] [--json] [--out <path>]
  wfa cdp status [--json]
  wfa cdp login  [--provider <chatgpt|gemini>] [--mode visible|background]
                 [--timeout <seconds>] [--json]

Options:
  --provider <name>          chatgpt or gemini
  --prompt <text>            Prompt string
  --prompt-file <path>       Path to prompt file
  --file <path|glob|dir>     Repeatable attachment; native CDP uploads via DOM.setFileInputFiles
  --mode <mode>              background (default for ask, visible for login), visible, or headless
  --gemini-mode <chat|task>  Optional Gemini web UI mode (chat or task)
  --conversation-id <id>     Optional conversation ID to serialize same-session turns
  --request-id <id>          Optional idempotency key (auto-generated UUID if omitted)
  --json                     Output machine-readable JSON
  --timeout <seconds>        Overall / stall timeout in seconds
  --settle <ms>              Answer stabilization window in milliseconds (default: 4000)
  --min-interval <ms>        Minimum interval between provider turns in milliseconds
  --no-stage                 Disable automatic file staging for code responses
  --no-wait                  Return the turn handle immediately after submission is confirmed; poll with wfa read
  --url <url>                Conversation URL for wfa cdp read
  --task-id <id>             Broker turn ID for wfa cdp read
  --wait <seconds>           Read-only observation window (default: 0)
  --no-reopen                Do not open a missing conversation tab
  --out <path>               Write captured answer text to a file
  --workspace <dir>          Target workspace root for staging (default: current directory)
  --help, -h                 Show this help message
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
  const stderr = deps.stderr || process.stderr;
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
    if (recovery.action === "RECOVERY_REQUIRED") {
      throw new WfaError(
        "RECOVERY_REQUIRED",
        `browser.lock needs a human decision: ${recovery.reason} (run \`wfa cdp status\` for evidence)`,
        { details: recovery.evidence }
      );
    }
    throw new WfaError(
      "CHROME_START_FAILED",
      `Chrome port is missing from recovery: ${recovery.reason || "unknown"}`,
      { details: recovery.evidence }
    );
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

    if (mode !== "headless") {
      try {
        const info = await cdp.send("Browser.getWindowForTarget", { targetId }).catch(() => null);
        if (info && typeof info.windowId !== "undefined") {
          await cdp.send("Browser.setWindowBounds", {
            windowId: info.windowId,
            bounds: { left: 100, top: 100, windowState: "normal" },
          }).catch(() => {});
        }
      } catch {}
      if (!options.json) {
        stdout.write("[cdp] window moved to 100,100\n");
      }
    }

    if (!options.json) {
      stdout.write("[cdp] a visible Chrome window is open. Log in, then leave it running; this command polls until the logged-in composer appears.\n");
    }

    const pollIntervalMs = deps.pollIntervalMs || 2000;
    const offOriginThresholdMs = deps.offOriginThresholdMs ?? deps.stallMs ?? 45000;
    const startTime = nowFn();
    const deadline = startTime + timeoutSec * 1000;

    let loggedIn = false;
    let finalTitle = "";
    let finalUser = null;
    let offOriginSince = null;
    let redirectAttempts = 0;
    let offOriginWarned = false;

    const checkExpr = typeof adapter.buildLoginProbeJs === "function"
      ? adapter.buildLoginProbeJs()
      : provider === "chatgpt"
        ? `(() => (async () => {
  const host = location.hostname;
  const onProduct = host === "chatgpt.com" || host === "www.chatgpt.com";
  if (!onProduct) {
    return { loggedIn: false, user: null, title: document.title || "", origin: location.origin, offOrigin: true };
  }
  const title = document.title || "";
  let user = null, apiError = null;
  try {
    const res = await fetch("/api/auth/session", { credentials: "include" });
    const body = await res.json();
    user = body && body.user ? (body.user.email || body.user.id || "user") : null;
  } catch (error) { apiError = String(error); }
  const editor = Boolean(document.querySelector('div.ProseMirror[contenteditable="true"]'))
    && !document.querySelector('textarea#mobile-composer-prompt');
  return { loggedIn: Boolean(user), user, title, origin: location.origin, editor, apiError };
})())()`
        : `(() => {
  const host = location.hostname;
  const onProduct = host === "gemini.google.com";
  if (!onProduct) {
    return { loggedIn: false, user: null, title: document.title || "", origin: location.origin, offOrigin: true };
  }
  const title = document.title || "";
  const signedInSelectors = [
    'button[aria-label*="Google 账号"]',
    'img[aria-label*="个人资料"]',
    'a[href*="accounts.google.com/SignOutOptions"]'
  ];
  const signedOutSelectors = [
    'a[href*="accounts.google.com/ServiceLogin"]',
    'a[href*="accounts.google.com/AccountChooser"]'
  ];
  const matchedSignedIn = signedInSelectors.filter(s => Boolean(document.querySelector(s)));
  const matchedSignedOut = signedOutSelectors.filter(s => Boolean(document.querySelector(s)));
  const signedIn = matchedSignedIn.length > 0;
  const signedOut = matchedSignedOut.length > 0;
  const loggedIn = signedIn && !signedOut;
  return {
    loggedIn,
    user: null,
    title,
    origin: location.origin,
    signedIn,
    signedOut,
    matchedSignedIn,
    matchedSignedOut
  };
})()`;

    const challengePattern = adapter.challengeTitlePattern || /请稍候|just a moment|verifying|security check|cloudflare|人机验证/i;

    while (nowFn() < deadline) {
      try {
        const evalRes = await cdp.send("Runtime.evaluate", {
          expression: checkExpr,
          awaitPromise: true,
          returnByValue: true,
        }, sessionId);

        const val = evalRes?.result?.value;
        if (val) {
          finalTitle = val.title || "";
          const isChallenged = challengePattern.test(finalTitle);

          if (val.offOrigin) {
            if (!offOriginWarned) {
              offOriginWarned = true;
              if (!options.json) {
                let offOriginHost = "identity provider";
                try {
                  offOriginHost = val.origin ? new URL(val.origin).host : "identity provider";
                } catch {}
                stdout.write(`[cdp] waiting for the redirect to finish (on ${offOriginHost})\n`);
              }
            }

            if (offOriginSince === null) {
              offOriginSince = nowFn();
            } else if (nowFn() - offOriginSince >= offOriginThresholdMs && redirectAttempts < 2) {
              redirectAttempts++;
              offOriginSince = nowFn();
              try {
                await cdp.send("Page.navigate", { url: targetUrl }, sessionId);
              } catch {}
            }
          } else {
            offOriginSince = null;
            if (val.loggedIn && !isChallenged) {
              loggedIn = true;
              finalUser = val.user ?? null;
              break;
            }
          }
        }
      } catch (err) {
        if (err?.code === "CDP_CLOSED") throw err;
      }

      await sleepFn(pollIntervalMs);
    }

    if (loggedIn) {
      await sleepFn(1500);

      const readRecord = deps.readBrokerRecord || readBrokerRecord;
      const checkInstanceAlive = deps.isInstanceAlive || isInstanceAlive;
      let skipClose = false;
      try {
        const record = await readRecord(home);
        if (record && await checkInstanceAlive(record)) {
          stderr.write("[cdp] a broker is running; leaving the browser open. Run `wfa broker stop` to release it.\n");
          skipClose = true;
        }
      } catch {}

      if (!skipClose) {
        await Promise.race([
          cdp.send("Browser.close").catch(() => {}),
          sleepFn(5000),
        ]);
      }

      if (options.json) {
        stdout.write(`${JSON.stringify({ status: "completed", provider, title: finalTitle, user: finalUser ?? null }, null, 2)}\n`);
      } else {
        if (finalUser) {
          stdout.write(`[cdp] logged in as ${finalUser}\n`);
        } else {
          stdout.write(`[cdp] logged in (${provider})\n`);
        }
        stdout.write("[cdp] session persisted; later runs restore it with --restore-last-session\n");
      }
      return { code: 0, result: { status: "completed", provider, title: finalTitle, user: finalUser ?? null } };
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

async function handleRead(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const { positional, options } = parseArgs(argv);

  if (options.help) {
    printCdpHelp(stdout);
    return { code: 0 };
  }
  if (positional.length) {
    throw new WfaError("INVALID_ARGUMENT", "wfa cdp read does not accept positional arguments.");
  }
  const hasUrl = options.url !== undefined;
  const hasTaskId = options["task-id"] !== undefined;
  if (hasUrl === hasTaskId) {
    throw new WfaError("INVALID_ARGUMENT", "Specify exactly one of --url or --task-id.");
  }

  const provider = options.provider === undefined ? undefined : String(options.provider).toLowerCase();
  if (provider !== undefined && !["chatgpt", "gemini"].includes(provider)) {
    throw new WfaError("INVALID_ARGUMENT", `Invalid provider "${options.provider}". Must be chatgpt or gemini.`);
  }

  const mode = options.mode === undefined ? "background" : String(options.mode).toLowerCase();
  if (!["background", "visible", "headless"].includes(mode)) {
    throw new WfaError("INVALID_ARGUMENT", `Invalid mode: ${options.mode}. Must be background, visible, or headless.`);
  }

  const timeoutSeconds = options.timeout === undefined ? 15 : Number(options.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) {
    throw new WfaError("INVALID_ARGUMENT", "--timeout must be greater than 0 and at most 300 seconds.");
  }

  const waitSeconds = options.wait === undefined ? 0 : Number(options.wait);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 7200) {
    throw new WfaError("INVALID_ARGUMENT", "--wait must be between 0 and 7200 seconds.");
  }

  const readFn = deps.readConversation || defaultReadConversation;
  const result = await readFn({
    home: deps.home || getHomeDir(),
    ...(hasUrl ? { url: String(options.url) } : { taskId: String(options["task-id"]) }),
    ...(provider ? { provider } : {}),
    mode,
    timeoutMs: timeoutSeconds * 1000,
    wait: waitSeconds * 1000,
    noReopen: Boolean(options["no-reopen"]),
    signal: deps.signal,
    deps: deps.readDeps || deps,
  });

  if (options.out !== undefined) {
    if (typeof result?.text === "string" && result.text.length > 0) {
      await writeFile(path.resolve(String(options.out)), result.text, "utf8");
      result.out = path.resolve(String(options.out));
    }
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`[read] status=${result.status} provider=${result.provider || provider || "unknown"}\n`);
    if (result.reason) stdout.write(`[read] reason: ${result.reason}\n`);
    if (result.out) stdout.write(`[read] out: ${result.out}\n`);
    if (result.text) stdout.write(`${result.text}${result.text.endsWith("\n") ? "" : "\n"}`);
  }

  return { code: 0, result };
}

async function handleAsk(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const home = deps.home || getHomeDir();

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

  let attachedFiles = [];
  if (options.file) {
    const rawFiles = Array.isArray(options.file) ? options.file : [options.file];
    const expanded = await expandAttachmentInputs({ files: rawFiles, cwd: process.cwd() });
    attachedFiles = expanded.files || [];
  }

  let mode = "background";
  if (options.mode) {
    mode = String(options.mode).toLowerCase();
    if (!["background", "visible", "headless"].includes(mode)) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid mode: ${options.mode}. Must be background, visible, or headless.`);
    }
  }

  let hardTimeoutMs = 900000;
  let stallTimeoutMs = 420000;
  if (options.timeout !== undefined) {
    const timeoutSec = Number(options.timeout);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --timeout: ${options.timeout}`);
    }
    hardTimeoutMs = timeoutSec * 1000;
    stallTimeoutMs = Math.min(hardTimeoutMs, 420000);
  }

  let settleMs = 4000;
  if (options.settle !== undefined) {
    settleMs = Number(options.settle);
    if (!Number.isFinite(settleMs) || settleMs < 0) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --settle: ${options.settle}`);
    }
  }

  let minIntervalMs;
  if (options["min-interval"] !== undefined) {
    const raw = String(options["min-interval"]).trim();
    if (!/^\d+$/.test(raw)) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --min-interval: ${options["min-interval"]}. Must be a non-negative integer in milliseconds.`);
    }
    minIntervalMs = Number(raw);
    if (!Number.isSafeInteger(minIntervalMs)) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --min-interval: ${options["min-interval"]}. Value exceeds the safe integer range.`);
    }
  }

  let conversationId = deps.conversationId ?? null;
  if (options["conversation-id"] !== undefined) {
    conversationId = String(options["conversation-id"]).trim();
    if (!conversationId) {
      throw new WfaError("INVALID_ARGUMENT", "Option --conversation-id must be a non-empty string.");
    }
  }

  let geminiMode = null;
  if (options["gemini-mode"] !== undefined) {
    geminiMode = String(options["gemini-mode"]).trim().toLowerCase();
    if (!["chat", "task"].includes(geminiMode)) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --gemini-mode: ${options["gemini-mode"]}. Must be chat or task.`);
    }
  }

  let requestId;
  if (options["request-id"] !== undefined) {
    requestId = String(options["request-id"]).trim();
    if (!requestId) {
      throw new WfaError("INVALID_ARGUMENT", "Option --request-id must be a non-empty string.");
    }
  } else {
    requestId = deps.requestId || randomUUID();
  }

  const startTime = Date.now();
  const ensureFn = deps.ensureBroker || ensureBroker;
  const spawnFn = deps.spawnBroker || (() => spawnDetachedBroker({ home, mode, deps, stdout }));
  const record = await ensureFn({ home, spawnBroker: spawnFn });

  const createTurnFn = deps.createTurn || createTurn;
  const turnRes = await createTurnFn(record, {
    provider,
    prompt,
    mode,
    requestId,
    settleMs,
    stallTimeoutMs,
    hardTimeoutMs,
    ...(conversationId !== null ? { conversationId } : {}),
    ...(attachedFiles.length > 0 ? { files: attachedFiles } : {}),
    ...(geminiMode !== null ? { geminiMode } : {}),
    ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
    ...(options["chrome-path"] ? { chromePath: options["chrome-path"] } : {}),
  });

  const created = turnRes?.json;
  if (turnRes?.status !== undefined && ![200, 202].includes(turnRes.status)) {
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

  if (options["no-wait"]) {
    let submittedTurn = created;

    if (submittedTurn?.sendCommittedAt == null) {
      const waitSubmissionFn = deps.waitForSubmission || waitForSubmission;

      try {
        submittedTurn = await waitSubmissionFn({
          record,
          turnId,
          home,
          timeoutMs: deps.submissionTimeoutMs ?? 60000,
          deps,
        });
      } catch (error) {
        const code = error?.code || "SUBMISSION_NOT_CONFIRMED";
        const message = error?.message || String(error);
        stderr.write(
          `wfa: ${code}: ${message}; inspect with wfa read --task-id ${turnId} before retrying\n`
        );
        return { code: 1, error };
      }
    }

    if (submittedTurn?.sendCommittedAt == null) {
      const error = new WfaError(
        "SUBMISSION_NOT_CONFIRMED",
        `Turn ${turnId} did not expose sendCommittedAt`
      );
      stderr.write(
        `wfa: ${error.code}: ${error.message}; inspect with wfa read --task-id ${turnId} before retrying\n`
      );
      return { code: 1, error };
    }

    const handle = {
      id: turnId,
      requestId: created?.requestId ?? submittedTurn?.requestId ?? requestId,
      state: submittedTurn?.state ?? created?.state ?? "queued",
      poll: `wfa read --task-id ${turnId}`,
      provider,
    };
    if (options.json) {
      stdout.write(`${JSON.stringify(handle, null, 2)}\n`);
    } else {
      stdout.write(`Submitted ${handle.id} (${handle.state})\nPoll: ${handle.poll}\n`);
    }
    return { code: 0, result: handle };
  }

  const waitFn = deps.waitForTurn || waitForTurn;
  let lastCooldownKey = null;
  const onProgress = (polledTurn) => {
    const remainingMs = polledTurn?.cooldownWaitMs;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;
    const key = `${remainingMs}:${polledTurn.cooldownWaitAt ?? ""}`;
    if (key === lastCooldownKey) return;
    lastCooldownKey = key;
    stderr.write(`[cdp] waiting ${(remainingMs / 1000).toFixed(1)}s for the provider interval\n`);
  };
  const turn = await waitFn({
    record,
    turnId,
    home,
    timeoutMs: hardTimeoutMs,
    onProgress,
    deps,
  });

  const startedAtMs = Date.parse(turn.startedAt || turn.createdAt || "");
  const finishedAtMs = Date.parse(turn.finishedAt || "");
  const elapsedMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : Math.max(0, Date.now() - startTime);

  const rawText = turn.text ?? "";
  const result = {
    id: turn.id ?? turnId,
    provider: turn.provider ?? provider,
    conversationId: turn.conversationId ?? conversationId,
    mode: turn.mode ?? mode,
    status: turn.state,
    text: rawText,
    reason: turn.reason ?? null,
    evidence: turn.evidence ?? null,
    ...(turn.sendCommittedAt != null ? { sendCommittedAt: turn.sendCommittedAt } : {}),
    elapsedMs,
  };

  let stagedResult = null;
  const shouldStage = result.status === "completed" && Boolean(rawText) && !options["no-stage"];
  if (shouldStage) {
    const stageFn = deps.stageCdpResponse || defaultStageCdpResponse;
    const workspaceRoot = options.workspace ? path.resolve(String(options.workspace)) : process.cwd();
    try {
      stagedResult = await stageFn({
        home,
        runId: result.id,
        provider: result.provider,
        text: rawText,
        workspaceRoot,
      });
    } catch (error) {
      // staging 是优化，不能因为补丁格式不完整就丢掉本轮答案。
      const code = error?.code || error?.message || String(error);
      stderr.write(`[cdp] stage skipped: ${code}\n`);
      stagedResult = null;
    }
  }

  if (stagedResult) {
    const firstNonEmptyLine = rawText.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || "";
    const summary = firstNonEmptyLine.length > 200 ? `${firstNonEmptyLine.slice(0, 200)}...` : firstNonEmptyLine;
    const textBytes = Buffer.byteLength(rawText, "utf8");

    if (options.json) {
      const { text: _omittedText, ...restResult } = result;
      const jsonOutput = {
        ...restResult,
        summary,
        textBytes,
        staged: stagedResult,
      };
      stdout.write(`${JSON.stringify(jsonOutput, null, 2)}\n`);
    } else {
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      stdout.write(`[cdp] provider=${provider} status=${result.status} elapsed=${elapsedSec}s\n`);
      stdout.write(`[cdp] stageRoot: ${stagedResult.stageRoot}\n`);
      stdout.write(`[cdp] manifestPath: ${stagedResult.manifestPath}\n`);
      stdout.write("[cdp] staged files:\n");
      for (const f of stagedResult.files) {
        const shortHash = (f.stagedSha256 || "").slice(0, 12);
        stdout.write(`  - ${f.path} (${f.bytes} bytes, sha256:${shortHash})\n`);
      }
    }
  } else if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    stdout.write(`[cdp] provider=${provider} status=${result.status} elapsed=${elapsedSec}s\n`);
    if (result.status === "completed" && result.text) {
      stdout.write(`${result.text}${result.text.endsWith("\n") ? "" : "\n"}`);
    } else if (result.status !== "completed" && result.reason) {
      stderr.write(`[cdp] reason: ${result.reason}\n`);
    }
  }

  if (result.evidence?.conversationWarning === "CONVERSATION_40_TURNS") {
    const turns = Number.isSafeInteger(result.evidence.conversationTurns)
      ? result.evidence.conversationTurns
      : 40;
    stderr.write(`[cdp] warning: conversation reached ${turns} turns (CONVERSATION_40_TURNS); consider starting a new conversation\n`);
  }
  if (result.status !== "completed" && result.sendCommittedAt != null) {
    stderr.write("[cdp] warning: prompt was already sent; do not resend\n");
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
  if (!subcmd || !["ask", "read", "status", "login"].includes(subcmd)) {
    stderr.write(`wfa: UNKNOWN_COMMAND: Unknown or missing cdp subcommand "${subcmd || ""}". Usage: wfa cdp <ask|read|status|login>\n`);
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
    if (subcmd === "read") return await handleRead(argv.slice(1), deps);
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
