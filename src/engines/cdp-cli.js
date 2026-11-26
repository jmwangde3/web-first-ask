import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "../paths.js";
import { isDebugEnabled, appendDebugIssue } from "../debug-log.js";
import { pace as defaultPace } from "../browser/pacer.js";
import { WfaError } from "../errors.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import * as claudeAdapter from "../browser/adapters/claude.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { archiveRepository } from "../repository-archive.js";

const execFileAsync = promisify(execFileCb);
export const CODE_TASK_VERIFY_DIRECTIVE =
  "\n\n[Verification requirement] Use the attached repository bundle to verify your patch: run `git apply --check` and full `npm test`, and report the exact pass/fail results before returning the final patch.";
import { sleep as defaultSleep } from "../util.js";
import { readBrokerRecord, isInstanceAlive } from "../broker/lifecycle.js";
import { ensureBroker, createTurn, waitForTurn, waitForSubmission } from "../broker/client.js";
import { spawnDetachedBroker } from "../broker/cli.js";
import { stageCdpResponse as defaultStageCdpResponse, extractFileBlocksToDir } from "./cdp-stage.js";
import * as defaultResultStore from "../broker/result-store.js";
import * as defaultTurnStore from "../broker/turn-store.js";
import { expandAttachmentInputs } from "../attachments.js";
import { readConversation as defaultReadConversation } from "./cdp-read.js";

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
  claude: claudeAdapter,
};

const VALUE_FLAGS = new Set([
  "provider",
  "providers",
  "artifact-dir",
  "download-dir",
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
  "input",
  "out-dir",
  "repro",
  "command",
  "limit",
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
  wfa cdp ask    [--provider <chatgpt|gemini|claude> | --providers chatgpt,gemini] (--prompt <text> | --prompt-file <path> | stdin)
                 [--mode background|visible|headless] [--gemini-mode task|chat] [--conversation-id <id>] [--request-id <id>] [--json]
                 [--timeout <s>] [--settle <ms>] [--min-interval <ms>]
                 [--code-task] [--file <path|glob|dir>] [--download-dir <dir>] [--cleanup | --no-cleanup] [--fallback-bundle]
                 [--no-stage] [--no-wait] [--workspace <dir>]
  wfa cdp read   (--url <conversation-url> | --task-id <id>)
                 [--provider <chatgpt|gemini>] [--mode background|visible|headless]
                 [--timeout <s>] [--wait <s>] [--no-reopen] [--json] [--out <path>]
  wfa cdp extract (--input <file> | --task-id <id>) --out-dir <dir> [--overwrite] [--json]
  wfa cdp cleanup (--task-id <id> | --url <url> --provider <chatgpt|gemini|claude> | --all | --keep-unfinished [--keep-named]) [--mode background|visible|headless] [--json]
  wfa cdp log-issue --repro "<steps>" [--command "<cmd>"] [--provider <p>] [--task-id <id>] [--json]
  wfa cdp status [--json]
  wfa cdp login  [--provider <chatgpt|gemini|claude>] [--mode visible|background]
                 [--timeout <seconds>] [--json]

Options:
  --provider <name>          chatgpt or gemini
  --prompt <text>            Prompt string
  --prompt-file <path>       Path to prompt file
  --code-task                Auto-attach repo git bundle (or zip fallback) and append git apply --check + npm test directive
  --providers <list>         Comma-separated providers to run concurrently (default: chatgpt,gemini when --provider omitted)
  --artifact-dir <dir>       Output directory for multi-provider artifacts
  --download-dir <dir>       Directory to capture provider-generated downloads with SHA-256 verification
  --cleanup / --no-cleanup   Auto-delete newly created one-shot conversations (default on for one-shot, off for named)
  --fallback-bundle          Auto-bundle repo and resubmit once if provider returns terminal REPO_UNREADABLE
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
  --recover-off-origin       Opt-in for wfa cdp login to navigate back after 45s off-origin (disabled by default)
  --no-debug                 Disable automatic debug issue logging (debug mode is ON by default; or set WFA_DEBUG=0)
  --limit <N>                Maximum conversations to delete in one bulk cleanup run
  --include-unknown          Allow cleanup of legacy records with unknown createdByWfa (still refuses createdByWfa=false)
  --dry-run                  Preview bulk cleanup candidates without opening Chrome or deleting
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
  if (!["chatgpt", "gemini", "claude"].includes(provider)) {
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
    const adapter = adapters[provider] || (provider === "gemini" ? geminiAdapter : (provider === "claude" ? claudeAdapter : chatgptAdapter));
    const targetUrl = adapter.url || (provider === "gemini" ? "https://gemini.google.com/app" : (provider === "claude" ? "https://claude.ai/new" : "https://chatgpt.com/"));

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
    const recoverOffOrigin = Boolean(options["recover-off-origin"]);
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

            if (recoverOffOrigin) {
              if (offOriginSince === null) {
                offOriginSince = nowFn();
              } else if (nowFn() - offOriginSince >= offOriginThresholdMs && redirectAttempts < 2) {
                redirectAttempts++;
                offOriginSince = nowFn();
                try {
                  await cdp.send("Page.navigate", { url: targetUrl }, sessionId);
                } catch {}
              }
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
        stdout.write("[cdp] session persisted in browser profile\n");
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
  if (provider !== undefined && !["chatgpt", "gemini", "claude"].includes(provider)) {
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

async function runMultiProviderAsk(argv, options, deps) {
  const stdout = deps.stdout || process.stdout;
  const home = deps.home || getHomeDir();
  const rawList = String(options.providers || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const providers = [...new Set(rawList)];
  if (providers.length === 0) {
    throw new WfaError("INVALID_ARGUMENT", "Option --providers requires a comma-separated list of providers.");
  }
  const batchId = `batch-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const artifactDir = options["artifact-dir"]
    ? path.resolve(String(options["artifact-dir"]))
    : path.join(home, "artifacts", batchId);
  await mkdir(artifactDir, { recursive: true });

  // Strip --providers and --artifact-dir when delegating to single-provider handleAsk
  const baseArgs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--providers" || tok === "--artifact-dir" || tok === "--provider") {
      i += 1;
      continue;
    }
    if (tok === "--json") continue;
    baseArgs.push(tok);
  }

  const settled = await Promise.all(providers.map(async (prov) => {
    const subOut = { buf: "", write(s) { this.buf += String(s); } };
    const subErr = { buf: "", write(s) { this.buf += String(s); } };
    try {
      const res = await handleAsk([...baseArgs, "--provider", prov, "--json"], {
        ...deps,
        stdout: subOut,
        stderr: subErr,
      });
      const jsonPath = path.join(artifactDir, `${prov}.json`);
      const mdPath = path.join(artifactDir, `${prov}.md`);
      let payload = res.result || null;
      if (!payload && subOut.buf.trim()) {
        try { payload = JSON.parse(subOut.buf); } catch {}
      }
      await writeFile(jsonPath, `${JSON.stringify({ provider: prov, code: res.code, result: payload, stderr: subErr.buf.trim() || null }, null, 2)}
`, "utf8");
      if (typeof payload?.text === "string" && payload.text) {
        await writeFile(mdPath, payload.text, "utf8");
      }
      const ok = res.code === 0 && (payload?.status === "completed" || payload?.state === "completed" || payload?.state === "running");
      return [prov, {
        ok,
        code: res.code,
        status: payload?.status || payload?.state || (ok ? "completed" : "failed"),
        taskId: payload?.id || payload?.taskId || null,
        artifactJson: jsonPath,
        artifactMd: typeof payload?.text === "string" && payload.text ? mdPath : null,
        ...(ok ? {} : { retryCommand: `wfa cdp ask --provider ${prov} ${baseArgs.join(" ")}`.trim() }),
      }];
    } catch (error) {
      const jsonPath = path.join(artifactDir, `${prov}.json`);
      await writeFile(jsonPath, `${JSON.stringify({ provider: prov, code: 1, error: error?.code || "ERROR", message: error?.message || String(error) }, null, 2)}
`, "utf8");
      return [prov, {
        ok: false,
        code: 1,
        status: "failed",
        error: error?.code || "ERROR",
        message: error?.message || String(error),
        artifactJson: jsonPath,
        artifactMd: null,
        retryCommand: `wfa cdp ask --provider ${prov} ${baseArgs.join(" ")}`.trim(),
      }];
    }
  }));

  const summary = {
    batchId,
    artifactDir,
    providers: Object.fromEntries(settled),
  };
  const allOk = settled.every(([, info]) => info.ok);
  if (options.json) {
    stdout.write(`${JSON.stringify(summary, null, 2)}
`);
  } else {
    stdout.write(`[cdp] batch ${batchId} artifacts: ${artifactDir}
`);
    for (const [prov, info] of settled) {
      stdout.write(`  - ${prov}: ${info.status}${info.retryCommand ? ` (retry: ${info.retryCommand})` : ""}
`);
    }
  }
  return { code: allOk ? 0 : 1, result: summary };
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

  if (options.providers !== undefined) {
    if (options.provider !== undefined) {
      throw new WfaError("INVALID_ARGUMENT", "Specify either --provider or --providers, not both.");
    }
    return await runMultiProviderAsk(argv, options, deps);
  }

  if (!options.provider) {
    throw new WfaError("INVALID_ARGUMENT", "Option --provider is required. Must be chatgpt or gemini.");
  }
  const provider = String(options.provider).toLowerCase();
  if (!["chatgpt", "gemini", "claude"].includes(provider)) {
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
  if (options["code-task"]) {
    const workspaceRoot = options.workspace ? path.resolve(String(options.workspace)) : (deps.cwd || process.cwd());
    const bundleDir = path.join(home, "code-task-bundles");
    await mkdir(bundleDir, { recursive: true });
    let bundlePath = null;
    if (typeof deps.createCodeTaskBundle === "function") {
      bundlePath = await deps.createCodeTaskBundle({ workspaceRoot, bundleDir });
    } else {
      const gitBundlePath = path.join(bundleDir, `repo-${Date.now()}-${randomUUID().slice(0, 8)}.bundle`);
      try {
        await execFileAsync("git", ["bundle", "create", gitBundlePath, "HEAD"], { cwd: workspaceRoot, timeout: 15000 });
        bundlePath = gitBundlePath;
      } catch {
        const arc = await (deps.archiveRepository || archiveRepository)({ cwd: workspaceRoot, outDir: bundleDir });
        bundlePath = arc?.archivePath || arc?.path || null;
      }
    }
    if (bundlePath && !attachedFiles.includes(bundlePath)) {
      attachedFiles.push(bundlePath);
    }
    if (!prompt.includes("git apply --check") || !prompt.includes("npm test")) {
      prompt = `${prompt}${CODE_TASK_VERIFY_DIRECTIVE}`;
    }
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

  let downloadDir = null;
  if (options["download-dir"] !== undefined) {
    downloadDir = path.resolve(String(options["download-dir"]).trim());
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
    ...(downloadDir !== null ? { downloadDir } : {}),
    ...(options.cleanup ? { cleanupCreated: true } : {}),
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
  let result = {
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

  if (options["fallback-bundle"] && result.status === "completed" && isRepoUnreadableResponse(result.text)) {
    const fb = await runWithRepoFallback({
      initialResult: result,
      workspaceRoot: options.workspace ? path.resolve(String(options.workspace)) : (deps.cwd || process.cwd()),
      archiveDir: path.join(home, "fallback-archives"),
      createArchiveFn: deps.archiveRepository || archiveRepository,
      submitFallbackFn: async ({ archivePath }) => {
        const fbReqId = randomUUID();
        const fbTurnRes = await createTurnFn(record, {
          provider,
          prompt,
          mode,
          requestId: fbReqId,
          settleMs,
          stallTimeoutMs,
          hardTimeoutMs,
          files: [archivePath],
          ...(geminiMode !== null ? { geminiMode } : {}),
          ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
          ...(options["chrome-path"] ? { chromePath: options["chrome-path"] } : {}),
        });
        if (fbTurnRes?.status >= 400) {
          throw new WfaError(
            fbTurnRes?.json?.code || "FALLBACK_TURN_FAILED",
            fbTurnRes?.json?.message || fbTurnRes?.json?.error || "Fallback turn submission failed",
          );
        }
        const fbTurnId = fbTurnRes.json.id;
        const fbDone = await (deps.waitForTurn || waitForTurn)({
          record,
          turnId: fbTurnId,
          home,
          timeoutMs: hardTimeoutMs + 60000,
          deps,
        });
        return {
          ...fbDone,
          status: fbDone.state || fbDone.status,
        };
      },
    });
    if (fb.triggered) {
      result = {
        ...fb.result,
        fallbackTriggered: true,
        fallbackFromTaskId: turnId,
        fallbackArchivePath: fb.archivePath,
      };
    }
  }

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

async function handleExtract(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const home = deps.home || getHomeDir();
  const { options } = parseArgs(argv);
  if (options.help) {
    printCdpHelp(stdout);
    return { code: 0 };
  }
  const hasInput = typeof options.input === "string" && options.input.trim().length > 0;
  const hasTaskId = typeof options["task-id"] === "string" && options["task-id"].trim().length > 0;
  if (hasInput === hasTaskId) {
    throw new WfaError("INVALID_ARGUMENT", "Specify exactly one of --input <file> or --task-id <id>.");
  }
  if (!options["out-dir"] || !String(options["out-dir"]).trim()) {
    throw new WfaError("INVALID_ARGUMENT", "Option --out-dir <dir> is required.");
  }

  let markdown;
  if (hasInput) {
    markdown = await readFile(path.resolve(String(options.input)), "utf8");
  } else {
    const readResultFn = deps.resultStore?.readResult || deps.readResult || defaultResultStore.readResult;
    const rec = await readResultFn(home, String(options["task-id"]).trim());
    if (!rec || typeof rec.text !== "string" || !rec.text.trim()) {
      throw new WfaError("TURN_NOT_FOUND", `No persisted answer text found for task ${options["task-id"]}`);
    }
    markdown = rec.text;
  }

  const out = await extractFileBlocksToDir({
    markdown,
    outputDir: path.resolve(String(options["out-dir"])),
    allowOverwrite: Boolean(options.overwrite),
  });
  if (options.json) {
    stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    stdout.write(`[extract] wrote ${out.files.length} file(s) to ${out.outputDir}\n`);
    for (const f of out.files) {
      stdout.write(`  - ${f.filePath} (${f.bytes} B)\n`);
    }
  }
  return { code: 0, result: out };
}

function normalizeUrlKey(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
  try {
    const u = new URL(rawUrl.trim());
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return rawUrl.trim().replace(/\/+$/, "");
  }
}

function isUnfinishedRecordState(record) {
  const state = String(record?.state || record?.status || "").toLowerCase();
  if (["queued", "running", "stalled", "needs_human", "takeover", "needs_user"].includes(state)) return true;
  if (state === "failed" && record?.sendCommittedAt != null) return true;
  return false;
}

export function parseDeleteEvalResult(evalRes) {
  const val = evalRes?.result?.value;
  if (val && (val.success === true || val.deleted === true)) {
    return { status: "deleted", verified: val.verified ?? true };
  }
  if (val && val.success === false) {
    return { status: "failed", reason: val.reason || "delete_failed" };
  }
  return { status: "attempted" };
}

export async function waitForNavigationReady(cdp, sessionId, targetUrl, {
  timeoutMs = 15000,
  pollMs = 200,
  settleMs = 300,
  sleepFn = defaultSleep,
} = {}) {
  let expectedPath = "";
  try {
    expectedPath = new URL(targetUrl).pathname.replace(/\/+$/, "");
  } catch {
    return { ready: false, reason: "invalid_target_url" };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await cdp.send("Runtime.evaluate", {
        expression: "({ readyState: document.readyState, pathname: location.pathname })",
        returnByValue: true,
      }, sessionId);
      const val = res?.result?.value;
      if (!val || typeof val.pathname !== "string") {
        // Synthetic unit-test mock without DOM evaluation
        await sleepFn(settleMs);
        return { ready: true, synthetic: true };
      }
      const actualPath = val.pathname.replace(/\/+$/, "");
      if ((actualPath === expectedPath || actualPath.startsWith(`${expectedPath}/`)) && val.readyState !== "loading") {
        await sleepFn(settleMs);
        return { ready: true, pathname: val.pathname, readyState: val.readyState };
      }
    } catch {
      // Page context may be transiently destroyed during navigation; keep polling.
    }
    await sleepFn(pollMs);
  }
  return { ready: false, reason: "navigation_timeout" };
}

async function readConversationStoreCandidates(home) {
  const out = [];
  for (const prov of ["chatgpt", "gemini", "claude"]) {
    const dir = path.join(home, "conversations", prov);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(path.join(dir, file), "utf8"));
        if (rec?.conversationUrl) {
          out.push({
            turnId: null,
            provider: prov,
            conversationId: rec.conversationId || null,
            conversationUrl: rec.conversationUrl,
            createdByWfa: true,
            state: "completed",
            source: "conversation-store",
          });
        }
        if (Array.isArray(rec?.retired)) {
          for (const item of rec.retired) {
            if (item?.conversationUrl && item.cleanupStatus !== "deleted") {
              out.push({
                turnId: null,
                provider: prov,
                conversationId: rec.conversationId || null,
                conversationUrl: item.conversationUrl,
                createdByWfa: true,
                state: "completed",
                source: "conversation-store:retired",
              });
            }
          }
        }
      } catch {}
    }
  }
  return out;
}

async function readLegacySessionsCandidates(home) {
  const out = [];
  try {
    const raw = JSON.parse(await readFile(path.join(home, "sessions.json"), "utf8"));
    const workspaces = raw?.workspaces;
    if (workspaces && typeof workspaces === "object") {
      for (const [ws, providers] of Object.entries(workspaces)) {
        if (!providers || typeof providers !== "object") continue;
        for (const [prov, url] of Object.entries(providers)) {
          if (typeof url === "string" && url.trim()) {
            out.push({
              turnId: null,
              provider: String(prov).toLowerCase(),
              conversationId: ws,
              conversationUrl: url.trim(),
              createdByWfa: null,
              state: "completed",
              source: "sessions.json",
            });
          }
        }
      }
    }
  } catch {}
  return out;
}

export async function collectCleanupCandidates(home, deps = {}) {
  const readResultsFn = deps.resultStore?.readResults || deps.readResults || defaultResultStore.readResults;
  const readTurnsFn = deps.turnStore?.readTurns || deps.readTurns || defaultTurnStore.readTurns;
  const results = await readResultsFn(home).catch(() => []);
  const turns = deps.resultStore?.readResults || deps.readResults
    ? (deps.turnStore?.readTurns || deps.readTurns ? await readTurnsFn(home).catch(() => []) : [])
    : await readTurnsFn(home).catch(() => []);
  const convSessions = deps.resultStore?.readResults || deps.readResults
    ? (deps.readConversationCandidates ? await deps.readConversationCandidates(home) : [])
    : await readConversationStoreCandidates(home);
  const legacySessions = deps.resultStore?.readResults || deps.readResults
    ? (deps.readLegacySessions ? await deps.readLegacySessions(home) : [])
    : await readLegacySessionsCandidates(home);

  const allRaw = [
    ...(Array.isArray(results) ? results.map((r) => ({ ...r, source: r.source || "turns/results" })) : []),
    ...(Array.isArray(turns) ? turns.map((r) => ({ ...r, source: r.source || "turns/records" })) : []),
    ...(Array.isArray(convSessions) ? convSessions : []),
    ...(Array.isArray(legacySessions) ? legacySessions : []),
  ];

  // Deduplicate by normalized conversationUrl; keep records without URL separate so they are reported as skipped.
  const byUrl = new Map();
  const withoutUrl = [];
  for (const rec of allRaw) {
    const key = normalizeUrlKey(rec?.conversationUrl);
    if (!key) {
      withoutUrl.push(rec);
      continue;
    }
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { ...rec });
      continue;
    }
    // Conservative merge:
    // - createdByWfa: false always wins; else true wins over null/undefined.
    let mergedCreated = existing.createdByWfa;
    if (existing.createdByWfa === false || rec.createdByWfa === false) mergedCreated = false;
    else if (existing.createdByWfa === true || rec.createdByWfa === true) mergedCreated = true;

    // - state: any unfinished state wins over completed so --keep-unfinished never deletes active/stalled sessions.
    let mergedState = existing.state || existing.status;
    let mergedSendCommittedAt = existing.sendCommittedAt ?? rec.sendCommittedAt ?? null;
    if (isUnfinishedRecordState(rec) && !isUnfinishedRecordState(existing)) {
      mergedState = rec.state || rec.status;
      mergedSendCommittedAt = rec.sendCommittedAt ?? mergedSendCommittedAt;
    }

    byUrl.set(key, {
      ...existing,
      turnId: existing.turnId || existing.id || rec.turnId || rec.id || null,
      provider: existing.provider || rec.provider || null,
      conversationId: existing.conversationId || rec.conversationId || null,
      createdByWfa: mergedCreated,
      state: mergedState,
      sendCommittedAt: mergedSendCommittedAt,
    });
  }

  return [...byUrl.values(), ...withoutUrl];
}

export function classifyCleanupCandidate(record, {
  all = false,
  keepUnfinished = false,
  keepNamed = false,
  force = false,
  includeUnknown = false,
} = {}) {
  if (!record || typeof record !== "object") return { eligible: false, reason: "invalid_record" };
  if (record.createdByWfa === false) return { eligible: false, reason: "preexisting_conversation" };
  if (record.createdByWfa !== true && !includeUnknown) {
    return { eligible: false, reason: "created_by_wfa_unknown" };
  }
  if (!record.conversationUrl) return { eligible: false, reason: "missing_url" };

  const state = String(record.state || record.status || "").toLowerCase();
  const isActive = state === "queued" || state === "running";
  if (isActive && !force) return { eligible: false, reason: "active_turn" };

  if (keepNamed && record.conversationId) {
    return { eligible: false, reason: "named_conversation_preserved" };
  }

  if (all) return { eligible: true, reason: "all" };

  if (keepUnfinished) {
    const isFinished = state === "completed" || (state === "failed" && record.sendCommittedAt == null);
    return isFinished
      ? { eligible: true, reason: "finished" }
      : { eligible: false, reason: `unfinished:${state || "unknown"}` };
  }
  return { eligible: true, reason: "explicit" };
}

async function handleCleanup(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const home = deps.home || getHomeDir();
  const { options } = parseArgs(argv);
  if (options.help) {
    printCdpHelp(stdout);
    return { code: 0 };
  }

  const bulkAll = Boolean(options.all);
  const bulkKeepUnfinished = Boolean(options["keep-unfinished"]);
  const includeUnknown = Boolean(options["include-unknown"]);
  if (bulkAll || bulkKeepUnfinished) {
    const records = await collectCleanupCandidates(home, deps);
    const keepNamed = Boolean(options["keep-named"]);
    const force = Boolean(options.force);
    const dryRun = Boolean(options["dry-run"]);
    let limit = null;
    if (options.limit !== undefined) {
      const parsedLimit = Number(options.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        throw new WfaError("INVALID_ARGUMENT", "Option --limit must be a positive integer.");
      }
      limit = parsedLimit;
    }

    const selected = [];
    const skipped = [];
    for (const rec of records) {
      const decision = classifyCleanupCandidate(rec, {
        all: bulkAll,
        keepUnfinished: bulkKeepUnfinished,
        keepNamed,
        force,
        includeUnknown,
      });
      if (decision.eligible) selected.push(rec);
      else skipped.push({ turnId: rec?.turnId || rec?.id || null, url: rec?.conversationUrl || null, source: rec?.source || null, reason: decision.reason });
    }

    const batchSlice = limit != null ? selected.slice(0, limit) : selected;
    if (limit != null && selected.length > limit) {
      for (const rec of selected.slice(limit)) {
        skipped.push({ turnId: rec?.turnId || rec?.id || null, url: rec?.conversationUrl || null, source: rec?.source || null, reason: "limit_exceeded" });
      }
    }

    if (dryRun) {
      const preview = {
        mode: bulkAll ? "all" : "keep-unfinished",
        dryRun: true,
        totalCandidates: records.length,
        eligibleCount: batchSlice.length,
        skippedCount: skipped.length,
        eligible: batchSlice.map((r) => ({
          turnId: r.turnId || r.id || null,
          provider: r.provider || null,
          url: r.conversationUrl,
          createdByWfa: r.createdByWfa ?? null,
          source: r.source || null,
        })),
        skipped,
      };
      if (options.json) stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      else stdout.write(`[cleanup] dry-run mode=${preview.mode} eligible=${preview.eligibleCount} skipped=${preview.skippedCount}\n`);
      return { code: 0, result: preview };
    }

    const cleaned = [];
    const actionable = [];
    for (const rec of batchSlice) {
      const prov = rec.provider ? String(rec.provider).toLowerCase() : null;
      const adapter = prov ? ((deps.adapters && deps.adapters[prov]) || DEFAULT_ADAPTERS[prov]) : null;
      if (!adapter || typeof adapter.buildDeleteConversationJs !== "function") {
        cleaned.push({
          turnId: rec.turnId || rec.id || null,
          status: "skipped",
          reason: "adapter_delete_not_supported",
          provider: prov,
          url: rec.conversationUrl,
        });
      } else {
        actionable.push({ rec, prov, adapter });
      }
    }

    if (actionable.length > 0) {
      const recoverFn = deps.recoverBrowser || recoverBrowser;
      const connectFn = deps.connectCdp || connectCdp;
      const driver = deps.driver || defaultDriver;
      const paceFn = deps.pace || defaultPace;
      const sleepFn = deps.sleep || defaultSleep;
      const waitNavFn = deps.waitForNavigationReady || waitForNavigationReady;
      const mode = options.mode ? String(options.mode).toLowerCase() : "background";
      const browserRec = await recoverFn({ home, mode, probes: deps.probes });
      if (!browserRec?.chrome?.port) {
        throw new WfaError("BROWSER_UNAVAILABLE", "Chrome is not available for conversation cleanup.");
      }

      let cdp = null;
      let tab = null;
      try {
        cdp = await connectFn(browserRec.chrome.port);
        // Open ONE single tab for the entire cleanup batch and navigate sequentially within it.
        tab = await driver.openTab(cdp, actionable[0].rec.conversationUrl, { timeoutMs: 15000 });
        for (let i = 0; i < actionable.length; i += 1) {
          const { rec, prov, adapter } = actionable[i];
          if (i > 0) {
            // Batch pacing: 4-6s random between bulk deletions (requirement #23 / D11)
            await paceFn("batch");
            await cdp.send("Page.navigate", { url: rec.conversationUrl }, tab.sessionId);
            const nav = await waitNavFn(cdp, tab.sessionId, rec.conversationUrl, { timeoutMs: 15000, sleepFn });
            if (!nav?.ready) {
              cleaned.push({
                turnId: rec.turnId || rec.id || null,
                status: "failed",
                reason: nav?.reason || "navigation_timeout",
                provider: prov,
                url: rec.conversationUrl,
              });
              continue;
            }
          }
          try {
            const expr = adapter.buildDeleteConversationJs(rec.conversationUrl);
            const evalRes = await cdp.send("Runtime.evaluate", {
              expression: expr,
              awaitPromise: true,
              returnByValue: true,
            }, tab.sessionId);
            const parsed = parseDeleteEvalResult(evalRes);
            cleaned.push({
              turnId: rec.turnId || rec.id || null,
              ...parsed,
              provider: prov,
              url: rec.conversationUrl,
            });
          } catch (err) {
            cleaned.push({
              turnId: rec.turnId || rec.id || null,
              status: "failed",
              reason: err?.message || String(err),
              provider: prov,
              url: rec.conversationUrl,
            });
          }
        }
      } finally {
        if (cdp && tab?.targetId && typeof driver.closeTab === "function") {
          try { await driver.closeTab(cdp, tab.targetId); } catch {}
        }
        if (cdp && typeof cdp.close === "function") {
          try { cdp.close(); } catch {}
        }
      }
    }

    const deletedCount = cleaned.filter((c) => c.status === "deleted").length;
    const failedCount = cleaned.filter((c) => c.status === "failed").length;
    const attemptedCount = cleaned.filter((c) => c.status === "attempted").length;
    const summary = {
      mode: bulkAll ? "all" : "keep-unfinished",
      totalCandidates: records.length,
      cleanedCount: deletedCount,
      deletedCount,
      failedCount,
      attemptedCount,
      skippedCount: skipped.length,
      cleaned,
      skipped,
    };
    if (options.json) stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else stdout.write(`[cleanup] mode=${summary.mode} deleted=${deletedCount} failed=${failedCount} attempted=${attemptedCount} skipped=${summary.skippedCount}\n`);
    return { code: 0, result: summary };
  }

  const hasTaskId = typeof options["task-id"] === "string" && options["task-id"].trim().length > 0;
  const hasUrl = typeof options.url === "string" && options.url.trim().length > 0;
  if (hasTaskId === hasUrl) {
    throw new WfaError("INVALID_ARGUMENT", "Specify --task-id <id>, --url <url>, --all, or --keep-unfinished.");
  }

  let provider = options.provider ? String(options.provider).trim().toLowerCase() : null;
  let targetUrl = hasUrl ? String(options.url).trim() : null;

  if (hasTaskId) {
    const readResultFn = deps.resultStore?.readResult || deps.readResult || defaultResultStore.readResult;
    const rec = await readResultFn(home, String(options["task-id"]).trim());
    if (!rec) {
      throw new WfaError("TURN_NOT_FOUND", `No persisted record found for task ${options["task-id"]}`);
    }
    if (rec.createdByWfa === false) {
      throw new WfaError("REFUSE_PREEXISTING_CONVERSATION", "Refusing to delete a pre-existing conversation not created by wfa.");
    }
    if (rec.createdByWfa !== true && !includeUnknown) {
      throw new WfaError("REFUSE_UNKNOWN_ORIGIN", "Conversation createdByWfa is unknown; pass --include-unknown to delete.");
    }
    provider = provider || (rec.provider ? String(rec.provider).toLowerCase() : null);
    targetUrl = rec.conversationUrl || null;
  }

  if (!provider || !DEFAULT_ADAPTERS[provider]) {
    throw new WfaError("INVALID_ARGUMENT", "Option --provider must be chatgpt, gemini, or claude.");
  }
  if (!targetUrl) {
    throw new WfaError("INVALID_ARGUMENT", "Conversation URL is missing for cleanup.");
  }

  const adapter = (deps.adapters && deps.adapters[provider]) || DEFAULT_ADAPTERS[provider];
  if (typeof adapter.buildDeleteConversationJs !== "function") {
    const skipped = { status: "skipped", reason: "adapter_delete_not_supported", provider, url: targetUrl };
    if (options.json) stdout.write(`${JSON.stringify(skipped, null, 2)}\n`);
    else stdout.write(`[cleanup] skipped (${skipped.reason}): ${targetUrl}\n`);
    return { code: 0, result: skipped };
  }

  const recoverFn = deps.recoverBrowser || recoverBrowser;
  const connectFn = deps.connectCdp || connectCdp;
  const driver = deps.driver || defaultDriver;
  const mode = options.mode ? String(options.mode).toLowerCase() : "background";
  const rec = await recoverFn({ home, mode, probes: deps.probes });
  if (!rec?.chrome?.port) {
    throw new WfaError("BROWSER_UNAVAILABLE", "Chrome is not available for conversation cleanup.");
  }

  let cdp = null;
  let tab = null;
  try {
    cdp = await connectFn(rec.chrome.port);
    tab = await driver.openTab(cdp, targetUrl, { timeoutMs: 15000 });
    const expr = adapter.buildDeleteConversationJs(targetUrl);
    const evalRes = await cdp.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    }, tab.sessionId);
    const parsed = parseDeleteEvalResult(evalRes);
    const out = { ...parsed, provider, url: targetUrl };
    if (options.json) stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else stdout.write(`[cleanup] ${out.status}: ${targetUrl}\n`);
    return { code: 0, result: out };
  } finally {
    if (cdp && tab?.targetId && typeof driver.closeTab === "function") {
      try { await driver.closeTab(cdp, tab.targetId); } catch {}
    }
    if (cdp && typeof cdp.close === "function") {
      try { cdp.close(); } catch {}
    }
  }
}

async function handleLogIssue(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const home = deps.home || getHomeDir();
  const { options } = parseArgs(argv);
  if (options.help) {
    printCdpHelp(stdout);
    return { code: 0 };
  }
  const repro = typeof options.repro === "string" ? options.repro.trim() : "";
  if (!repro) {
    throw new WfaError("INVALID_ARGUMENT", "Option --repro <steps> is required.");
  }
  const entry = await appendDebugIssue({
    home,
    command: typeof options.command === "string" ? options.command.trim() : "",
    provider: typeof options.provider === "string" ? options.provider.trim().toLowerCase() : "",
    taskId: typeof options["task-id"] === "string" ? options["task-id"].trim() : "",
    conversationUrl: typeof options.url === "string" ? options.url.trim() : "",
    status: "agent_reported",
    repro,
  });
  if (options.json) {
    stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  } else {
    stdout.write(`[debug] issue logged to ${entry.path}\n`);
  }
  return { code: 0, result: entry };
}

export function isRepoUnreadableResponse(text) {
  return typeof text === "string" && /\bREPO_UNREADABLE\b/.test(text);
}

export async function runWithRepoFallback({
  initialResult,
  workspaceRoot = process.cwd(),
  archiveDir,
  createArchiveFn = archiveRepository,
  submitFallbackFn,
} = {}) {
  if (!initialResult || initialResult.status !== "completed" || !isRepoUnreadableResponse(initialResult.text)) {
    return { triggered: false, result: initialResult };
  }
  if (typeof submitFallbackFn !== "function") {
    throw new WfaError("INVALID_ARGUMENT", "submitFallbackFn is required for REPO_UNREADABLE fallback.");
  }
  const archive = await createArchiveFn({
    cwd: workspaceRoot,
    outDir: archiveDir,
  });
  const archivePath = archive?.archivePath || archive?.path || archive;
  const fallbackResult = await submitFallbackFn({
    archivePath,
    originalResult: initialResult,
  });
  return {
    triggered: true,
    archivePath,
    result: fallbackResult,
  };
}

export async function runCdpCommand(argv = [], deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printCdpHelp(stdout);
    return { code: 0 };
  }

  const subcmd = argv[0];
  if (!subcmd || !["ask", "read", "extract", "cleanup", "log-issue", "status", "login"].includes(subcmd)) {
    stderr.write(`wfa: UNKNOWN_COMMAND: Unknown or missing cdp subcommand "${subcmd || ""}". Usage: wfa cdp <ask|read|extract|cleanup|log-issue|status|login>\n`);
    return { code: 2 };
  }

  const debugOpts = {
    "no-debug": argv.includes("--no-debug"),
    debug: argv.includes("--debug") ? true : undefined,
  };
  const debugOn = deps.debugLog !== false && isDebugEnabled(debugOpts);
  const debugHome = deps.home || getHomeDir();
  const safeCommand = `wfa cdp ${argv.join(" ")}`.slice(0, 300);

  const maybeLogFailure = async ({ status = "", errorCode = "", message = "", result = null, details = null } = {}) => {
    if (!debugOn || subcmd === "log-issue") return;
    const logged = await appendDebugIssue({
      home: debugHome,
      command: safeCommand,
      status: status || result?.status || result?.state || "",
      errorCode: errorCode || result?.reason || "",
      message,
      provider: result?.provider || "",
      taskId: result?.id || result?.taskId || "",
      conversationUrl: result?.conversationUrl || "",
      details,
    });
    if (logged.logged) {
      stderr.write(`[debug] issue logged to ${logged.path}\n`);
    }
  };

  try {
    let outcome;
    if (subcmd === "status") {
      const { options } = parseArgs(argv.slice(1));
      if (options.help) {
        printCdpHelp(stdout);
        return { code: 0 };
      }
      outcome = await handleStatus(options, deps);
    } else if (subcmd === "login") {
      const loginFn = deps.runCdpLogin || handleLogin;
      outcome = await loginFn(argv.slice(1), deps);
    } else if (subcmd === "read") {
      outcome = await handleRead(argv.slice(1), deps);
    } else if (subcmd === "extract") {
      outcome = await handleExtract(argv.slice(1), deps);
    } else if (subcmd === "cleanup") {
      outcome = await handleCleanup(argv.slice(1), deps);
    } else if (subcmd === "log-issue") {
      outcome = await handleLogIssue(argv.slice(1), deps);
    } else {
      outcome = await handleAsk(argv.slice(1), deps);
    }
    if (outcome && outcome.code !== 0) {
      await maybeLogFailure({
        status: outcome.result?.status || outcome.result?.state || "nonzero_exit",
        errorCode: outcome.error?.code || outcome.result?.reason || "",
        message: outcome.error?.message || "",
        result: outcome.result || null,
        details: outcome.error?.details || outcome.result?.evidence || null,
      });
    }
    return outcome;
  } catch (error) {
    if (error instanceof WfaError) {
      stderr.write(`wfa: ${error.code}: ${error.message}\n`);
      await maybeLogFailure({ errorCode: error.code, message: error.message, details: error.details || null });
      return { code: 1, error };
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`wfa: ${message}\n`);
    await maybeLogFailure({ errorCode: error?.code || "UNEXPECTED_ERROR", message });
    return { code: 1, error };
  }
}
