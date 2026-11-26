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
import * as claudeAdapter from "../browser/adapters/claude.js";
import { sleep as defaultSleep } from "../util.js";
import { readBrokerRecord, isInstanceAlive } from "../broker/lifecycle.js";
import { ensureBroker, createTurn, waitForTurn, waitForSubmission } from "../broker/client.js";
import { spawnDetachedBroker } from "../broker/cli.js";
import { stageCdpResponse as defaultStageCdpResponse } from "./cdp-stage.js";
import { expandAttachmentInputs } from "../attachments.js";
import { readConversation as defaultReadConversation } from "./cdp-read.js";
import { runCdpFanout as defaultRunCdpFanout, retryFanoutProvider as defaultRetryFanoutProvider, normalizeGeminiMode } from "./cdp-engine.js";
import { runCdpCleanup as defaultRunCdpCleanup } from "./cdp-cleanup.js";
import { maybeRepoFallback as defaultMaybeRepoFallback } from "./cdp-repo-fallback.js";
import { extractFileBlocksToDisk as defaultExtractFileBlocks } from "../stage.js";

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
  // F5: Claude adapter registered here (login + ask validation). The
  // broker turn validation and conversation store still only accept
  // chatgpt/gemini — see the F5 note in cdp-engine.js.
  claude: claudeAdapter,
};

const VALUE_FLAGS = new Set([
  "provider",
  "providers",
  "retry-provider",
  "run-dir",
  "out-dir",
  "download-dir",
  "input",
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
  "run-id",
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
  wfa cdp ask    --provider <chatgpt|gemini|claude> (--prompt <text> | --prompt-file <path> | stdin)
                 [--mode background|visible|headless] [--gemini-mode chat|task] [--conversation-id <id>] [--request-id <id>] [--json]
                 [--timeout <s>] [--settle <ms>] [--min-interval <ms>]
                 [--file <path|glob|dir>] [--download-dir <dir>] [--no-stage] [--no-wait] [--workspace <dir>]
  wfa cdp ask    --providers <chatgpt,gemini> (--prompt <text> | --prompt-file <path> | stdin)
                 [--mode background|visible|headless] [--serial] [--out-dir <dir>] [--json]
                 [--timeout <s>] [--settle <ms>] [--min-interval <ms>]
                 [--file <path|glob|dir>] [--no-stage] [--no-wait] [--workspace <dir>]
                 Fan-out (F2): same brief to each provider in parallel (one
                 in-flight turn per provider, at most two across providers),
                 each answer to <runDir>/<provider>/response.md, run record
                 <runDir>/fanout.json. --serial forces global serial execution.
  wfa cdp ask    --retry-provider <chatgpt|gemini> --run-dir <dir>
                 (--prompt <text> | --prompt-file <path> | stdin) [--json]
                 Retry exactly one failed provider of a recorded fan-out run.
                 The prompt must hash to the recorded brief, and only a
                 definite pre-submit failure may be retried.
  wfa cdp read   (--url <conversation-url> | --task-id <id>)
                 [--provider <chatgpt|gemini|claude>] [--mode background|visible|headless]
                 [--timeout <s>] [--wait <s>] [--no-reopen] [--json] [--out <path>]
  wfa cdp status [--json]
  wfa cdp login  [--provider <chatgpt|gemini|claude>] [--mode visible|background]
                 [--timeout <seconds>] [--json]
  wfa cdp extract --input <answer.md> --out-dir <dir> [--json]
                 Extract FILE: blocks from a provider answer to disk (F3),
                 with an integrity self-check; a truncated answer is
                 refused, nothing is written. Never writes into a repo.
  wfa cdp cleanup [--provider <chatgpt|gemini|claude>] [--conversation-id <id>]
                 [--run-id <id>] [--dry-run] [--json]
                 Delete only the conversations this tool created (F7);
                 pre-existing conversations are never touched, and a
                 second run deletes nothing. --dry-run lists what would
                 be deleted without opening a browser. No automatic
                 cleanup exists: this explicit command is the only trigger.

Options:
  --provider <name>          chatgpt, gemini, or claude
  --download-dir <dir>       F4: after a completed turn, capture provider-produced
                             downloads into this directory (size + SHA-256 verified);
                             recorded on the turn as downloads[]
  --providers <a,b>          Fan-out (F2): comma-separated providers for one brief
  --serial                   Fan-out (F2): run providers one after another
  --out-dir <dir>            Fan-out (F2): run directory for per-provider files (default: <home>/runs/<runId>)
  --retry-provider <name>    Fan-out retry (F2): retry one provider of a recorded run; requires --run-dir
  --run-dir <dir>            Fan-out retry (F2): run directory holding fanout.json
  --prompt <text>            Prompt string
  --prompt-file <path>       Path to prompt file
  --file <path|glob|dir>     Repeatable attachment; native CDP uploads via DOM.setFileInputFiles
  --mode <mode>              background (default for ask, visible for login), visible, or headless
  --gemini-mode <chat|task>   F1, Gemini only: Chat (default) or Task mode (sandboxed code runs).
                             --mode stays the window mode; --gemini-mode task is rejected for
                             non-Gemini providers and for fan-out runs.
  --conversation-id <id>     Optional conversation ID to serialize same-session turns
  --run-id <id>            F7: with wfa cdp cleanup, delete only conversations
                             created by this run (createdRunId); omit to clean
                             up every conversation this tool created
  --dry-run                  F7: with wfa cdp cleanup, list what would be deleted
                             without opening a browser or deleting anything
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

  // Side finding (2026-11-26 branch acceptance): this used to print the
  // broker.json record verbatim, so a dead broker's pid/port looked live
  // while `wfa broker status` (which verifies via discoverBroker) said
  // not running. Verify liveness first — same isInstanceAlive check the
  // login path already uses — and report a stale record as not running
  // instead of presenting it as the current state. Status stays
  // read-only: the stale file itself is cleared on the next broker start
  // (ensureBroker / spawnDetachedBroker), not by this command.
  if (record && typeof record === "object") {
    const checkInstanceAlive = deps.isInstanceAlive || isInstanceAlive;
    let alive = false;
    try {
      alive = await checkInstanceAlive(record);
    } catch {
      alive = false;
    }
    if (!alive) {
      if (options.json) {
        stdout.write(`${JSON.stringify({ running: false, alive: false, message: "broker: not running" }, null, 2)}\n`);
      } else {
        stdout.write("broker: not running\n");
      }
      return { code: 0 };
    }
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
  if (provider !== "chatgpt" && provider !== "gemini" && provider !== "claude") {
    throw new WfaError("INVALID_ARGUMENT", `Invalid provider "${options.provider}". Must be chatgpt, gemini, or claude.`);
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
  if (provider !== undefined && !["chatgpt", "gemini", "claude"].includes(provider)) {
    throw new WfaError("INVALID_ARGUMENT", `Invalid provider "${options.provider}". Must be chatgpt, gemini, or claude.`);
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

// F2 — one provider turn through the broker, shaped like a runCdpTurn
// result so the engine fan-out can drive it. The broker record is ensured
// once by the caller and shared across providers; the engine's
// 1-per-provider / 2-total cap is the phase-one rule and the broker's own
// scheduler is the backstop. Per-provider request ids come from the engine
// (`<base>:<provider>`, `<base>:<provider>:retry:<n>`), so broker
// idempotency is preserved per attempt.
function makeBrokerRunTurn({ home, deps, ensureRecord, noWait = false }) {
  const createTurnFn = deps.createTurn || createTurn;
  const waitFn = deps.waitForTurn || waitForTurn;
  const waitSubmissionFn = deps.waitForSubmission || waitForSubmission;
  return async (turnArgs) => {
    const startTime = Date.now();
    const { provider, prompt, mode, requestId, conversationId, files,
      settleMs, stallTimeoutMs, hardTimeoutMs, minIntervalMs, geminiMode, downloadDir } = turnArgs;
    const record = await ensureRecord();
    const created = await createTurnFn(record, {
      provider, prompt, mode, requestId, settleMs, stallTimeoutMs, hardTimeoutMs,
      ...(conversationId != null ? { conversationId } : {}),
      ...(Array.isArray(files) && files.length ? { files } : {}),
      ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
      // F1/F4 (coordinator wiring): forwarded now that the broker accepts them.
      ...(geminiMode === "chat" || geminiMode === "task" ? { geminiMode } : {}),
      ...(typeof downloadDir === "string" && downloadDir.trim() ? { downloadDir } : {}),
    });
    const createdJson = created?.json;
    const failed = (reason) => ({
      id: createdJson?.turnId ?? null, status: "failed",
      reason: String(reason).toLowerCase(), text: "", conversationUrl: "",
      sendCommittedAt: null, elapsedMs: Date.now() - startTime,
    });
    if (created?.status !== undefined && ![200, 202].includes(created.status)) {
      return failed(createdJson?.error || createdJson?.code || "broker_error");
    }
    const turnId = createdJson?.id;
    if (!turnId) return failed("broker_error");
    if (noWait) {
      let submitted = createdJson;
      if (submitted?.sendCommittedAt == null) {
        try {
          submitted = await waitSubmissionFn({
            record, turnId, home, timeoutMs: deps.submissionTimeoutMs ?? 60000, deps,
          });
        } catch (error) {
          return failed(error?.code || "submission_not_confirmed");
        }
      }
      if (submitted?.sendCommittedAt == null) return failed("submission_not_confirmed");
      return {
        id: turnId, status: submitted?.state ?? "running",
        reason: submitted?.reason ?? null, text: "",
        conversationUrl: submitted?.conversationUrl ?? "",
        sendCommittedAt: submitted.sendCommittedAt,
        elapsedMs: Date.now() - startTime,
      };
    }
    const turn = await waitFn({ record, turnId, home, timeoutMs: hardTimeoutMs, deps });
    const startedAtMs = Date.parse(turn.startedAt || turn.createdAt || "");
    const finishedAtMs = Date.parse(turn.finishedAt || "");
    return {
      id: turn.id ?? turnId, status: turn.state, reason: turn.reason ?? null,
      text: turn.text ?? "", conversationUrl: turn.conversationUrl ?? "",
      sendCommittedAt: turn.sendCommittedAt ?? null,
      elapsedMs: Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
        ? Math.max(0, finishedAtMs - startedAtMs) : Math.max(0, Date.now() - startTime),
    };
  };
}

function makeEnsureRecord({ home, deps, mode, stdout }) {
  const ensureFn = deps.ensureBroker || ensureBroker;
  const spawnFn = deps.spawnBroker || (() => spawnDetachedBroker({ home, mode, deps, stdout }));
  let cached = null;
  return () => {
    if (!cached) cached = ensureFn({ home, spawnBroker: spawnFn });
    return cached;
  };
}

function fanoutResultSummary(result) {
  const { text = "", ...rest } = result;
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) || "";
  return {
    ...rest,
    summary: firstLine.length > 200 ? `${firstLine.slice(0, 200)}...` : firstLine,
    textBytes: Buffer.byteLength(text, "utf8"),
  };
}

async function stageFanoutResults({ fanout, options, home, deps, stderr }) {
  if (options["no-stage"]) return;
  const stageFn = deps.stageCdpResponse || defaultStageCdpResponse;
  const workspaceRoot = options.workspace ? path.resolve(String(options.workspace)) : process.cwd();
  for (const result of fanout.results) {
    // A retry result carries no text: the answer lives in its artifact file.
    let text = result.text;
    if (!text && result.status === "completed" && result.resultPath) {
      text = await readFile(result.resultPath, "utf8").catch(() => "");
    }
    if (result.status !== "completed" || !text || !result.turnId) continue;
    try {
      result.staged = await stageFn({
        home, runId: result.turnId, provider: result.provider, text, workspaceRoot,
      });
    } catch (error) {
      stderr.write(`[cdp] stage skipped for ${result.provider}: ${error?.code || error?.message || String(error)}\n`);
    }
  }
}

function printFanout({ fanout, options, stdout }) {
  if (options.json) {
    stdout.write(`${JSON.stringify({
      runId: fanout.runId, runDir: fanout.runDir, state: fanout.state,
      promptSha256: fanout.promptSha256,
      results: fanout.results.map((result) => fanoutResultSummary(result)),
    }, null, 2)}\n`);
    return;
  }
  stdout.write(`[cdp] fanout ${fanout.runId} state=${fanout.state} providers=${fanout.results.map((r) => r.provider).join(",")}\n`);
  for (const result of fanout.results) {
    stdout.write(`[cdp] ${result.provider}: ${result.status}${result.reason ? ` (${result.reason})` : ""}${result.resultPath ? ` -> ${result.resultPath}` : ""}\n`);
    if (result.staged) stdout.write(`[cdp] ${result.provider} stageRoot: ${result.staged.stageRoot}\n`);
    if (result.status !== "completed") {
      stdout.write(`[cdp] retry ${result.provider} with: wfa cdp ask --retry-provider ${result.provider} --run-dir ${fanout.runDir} --prompt-file <brief>\n`);
    }
  }
  stdout.write(`[cdp] run record: ${path.join(fanout.runDir, "fanout.json")}\n`);
}

async function handleFanout({ options, prompt, attachedFiles, mode, hardTimeoutMs, stallTimeoutMs, settleMs, minIntervalMs, conversationId, requestId, home, deps, stdout, stderr }) {
  if (options.provider !== undefined) {
    throw new WfaError("INVALID_ARGUMENT", "Use exactly one of --provider or --providers.");
  }
  const fanoutFn = deps.runCdpFanout || defaultRunCdpFanout;
  const ensureRecord = makeEnsureRecord({ home, deps, mode, stdout });
  const runTurn = makeBrokerRunTurn({ home, deps, ensureRecord, noWait: Boolean(options["no-wait"]) });
  const outDir = options["out-dir"] ? path.resolve(String(options["out-dir"])) : null;
  const fanout = await fanoutFn({
    providers: String(options.providers).split(","),
    prompt, home, baseRequestId: requestId,
    ...(outDir ? { outDir } : {}),
    serial: Boolean(options.serial), mode,
    ...(conversationId !== null ? { conversationId } : {}),
    files: attachedFiles, settleMs, stallTimeoutMs, hardTimeoutMs,
    ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
    runTurn,
  });
  await stageFanoutResults({ fanout, options, home, deps, stderr });
  printFanout({ fanout, options, stdout });
  return { code: fanout.state === "completed" ? 0 : 1, result: fanout };
}

async function handleFanoutRetry({ options, prompt, home, deps, stdout, stderr }) {
  if (!options["run-dir"]) {
    throw new WfaError("INVALID_ARGUMENT", "--retry-provider requires --run-dir <dir> holding fanout.json.");
  }
  const retryFn = deps.retryFanoutProvider || defaultRetryFanoutProvider;
  const ensureRecord = makeEnsureRecord({ home, deps, mode: "background", stdout });
  const runTurn = makeBrokerRunTurn({ home, deps, ensureRecord, noWait: false });
  const { record, result, runDir } = await retryFn({
    runDir: path.resolve(String(options["run-dir"])),
    provider: String(options["retry-provider"]),
    prompt, home, runTurn,
  });
  const fanout = { runId: record.runId, runDir, state: record.state, promptSha256: record.promptSha256, results: [result] };
  await stageFanoutResults({ fanout, options, home, deps, stderr });
  printFanout({ fanout, options, stdout });
  return { code: result.status === "completed" ? 0 : 1, result };
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

  // F1: --mode is the window mode; the Gemini Chat/Task switch is the
  // separate --gemini-mode flag. Rejected for fan-out (that path does not
  // forward it yet) and for task mode on a non-Gemini provider. The
  // value is forwarded in the broker turn payload for the broker to
  // pass to runCdpTurn.
  let geminiMode = "chat";
  if (options["gemini-mode"] !== undefined) {
    geminiMode = normalizeGeminiMode(options["gemini-mode"]);
    if (geminiMode === null) {
      throw new WfaError("INVALID_ARGUMENT", `Invalid --gemini-mode: ${options["gemini-mode"]}. Must be chat or task.`);
    }
    if (geminiMode === "task" && (options.providers !== undefined || options["retry-provider"] !== undefined)) {
      throw new WfaError("INVALID_ARGUMENT", "--gemini-mode task is not supported for fan-out runs yet.");
    }
    if (geminiMode === "task" && options.provider !== undefined && String(options.provider).toLowerCase() !== "gemini") {
      throw new WfaError("INVALID_ARGUMENT", "--gemini-mode task only applies to --provider gemini.");
    }
  }

  // F4: directory for provider-produced downloads; forwarded in the
  // broker turn payload, single-provider runs only for now.
  let downloadDir = null;
  if (options["download-dir"] !== undefined) {
    const raw = String(options["download-dir"]).trim();
    if (!raw) {
      throw new WfaError("INVALID_ARGUMENT", "Option --download-dir must be a non-empty path.");
    }
    if (options.providers !== undefined || options["retry-provider"] !== undefined) {
      throw new WfaError("INVALID_ARGUMENT", "--download-dir is not supported for fan-out runs yet.");
    }
    downloadDir = path.resolve(raw);
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

  let requestId;
  if (options["request-id"] !== undefined) {
    requestId = String(options["request-id"]).trim();
    if (!requestId) {
      throw new WfaError("INVALID_ARGUMENT", "Option --request-id must be a non-empty string.");
    }
  } else {
    requestId = deps.requestId || randomUUID();
  }

  // F2 — fan-out and single-provider retry branch off here; they share the
  // prompt, files, mode and timeout parsing above. The single-provider
  // --provider requirement moves below, so --providers/--retry-provider do
  // not have to name a single provider.
  if (options["retry-provider"] !== undefined) {
    return await handleFanoutRetry({ options, prompt, home, deps, stdout, stderr });
  }
  if (options.providers !== undefined) {
    return await handleFanout({
      options, prompt, attachedFiles, mode, hardTimeoutMs, stallTimeoutMs, settleMs,
      minIntervalMs, conversationId, requestId, home, deps, stdout, stderr,
    });
  }

  if (!options.provider) {
    throw new WfaError("INVALID_ARGUMENT", "Option --provider is required. Must be chatgpt, gemini, or claude.");
  }
  const provider = String(options.provider).toLowerCase();
  if (provider !== "chatgpt" && provider !== "gemini" && provider !== "claude") {
    throw new WfaError("INVALID_ARGUMENT", `Invalid provider "${options.provider}". Must be chatgpt, gemini, or claude.`);
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
    ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
    ...(options["chrome-path"] ? { chromePath: options["chrome-path"] } : {}),
    // F1: forwarded for the broker to pass to runCdpTurn (broker accepts
    // geminiMode since the coordinator wiring; previously dropped).
    ...(geminiMode !== "chat" ? { geminiMode } : {}),
    // F4: download directory for provider-produced attachments.
    ...(typeof downloadDir === "string" && downloadDir.trim() ? { downloadDir } : {}),
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
  let turn = await waitFn({
    record,
    turnId,
    home,
    timeoutMs: hardTimeoutMs,
    onProgress,
    deps,
  });

  // F8 — REPO_UNREADABLE sentinel: at most one automatic bundled fallback
  // turn (same conversation, new request id, bundled input, never the
  // original prompt). The fallback turn's result replaces the parent's; a
  // planning/submission failure never loses the parent answer.
  let repoFallback = null;
  try {
    const fallbackFn = deps.maybeRepoFallback || defaultMaybeRepoFallback;
    const outcome = await fallbackFn({
      turn,
      provider,
      prompt,
      parentRequestId: requestId,
      conversationId: turn.conversationId ?? conversationId,
      workspace: options.workspace ? path.resolve(String(options.workspace)) : process.cwd(),
      mode,
      settleMs,
      stallTimeoutMs,
      hardTimeoutMs,
      ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
      record,
      home,
      createTurn: createTurnFn,
      waitForTurn: waitFn,
      onProgress,
      deps,
    });
    if (outcome.attempted) {
      repoFallback = {
        action: "retry-with-bundle",
        transport: outcome.decision.transport,
        newRequestId: outcome.decision.newRequestId,
        parentTurnId: turn.id ?? turnId,
        ...(outcome.fallbackTurn
          ? { fallbackTurnId: outcome.fallbackTurn.id ?? null, fallbackStatus: outcome.fallbackTurn.state ?? null }
          : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
      if (outcome.fallbackTurn) {
        stderr.write(`[cdp] repo fallback: REPO_UNREADABLE on turn ${turn.id ?? turnId}; submitted follow-up turn ${outcome.fallbackTurn.id ?? ""} (${outcome.decision.transport}, new request ${outcome.decision.newRequestId})\n`);
        turn = outcome.fallbackTurn;
      } else {
        stderr.write(`[cdp] repo fallback: REPO_UNREADABLE on turn ${turn.id ?? turnId}; follow-up turn could not be submitted\n`);
      }
    } else if (outcome.detected) {
      repoFallback = { action: "none", reason: outcome.decision.reason };
      stderr.write(`[cdp] repo fallback: REPO_UNREADABLE on turn ${turn.id ?? turnId}; no fallback (${outcome.decision.reason})\n`);
    }
  } catch (error) {
    stderr.write(`[cdp] repo fallback skipped: ${error?.code || error?.message || String(error)}\n`);
  }

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
    ...(repoFallback ? { repoFallback } : {}),
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

// F3: extract FILE: blocks from a saved provider answer to disk, with
// the integrity self-check from stage.js. A truncated answer is refused
// and nothing is written. Never writes into a repository: the extractor
// itself refuses an output dir inside repositoryRoot.
async function handleExtract(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const { options } = parseArgs(argv);
  if (options.help) {
    printCdpHelp(stdout);
    return { code: 0 };
  }
  const input = options.input !== undefined ? String(options.input).trim() : "";
  const outDir = options["out-dir"] !== undefined ? String(options["out-dir"]).trim() : "";
  if (!input) {
    throw new WfaError("INVALID_ARGUMENT", "Option --input is required for wfa cdp extract.");
  }
  if (!outDir) {
    throw new WfaError("INVALID_ARGUMENT", "Option --out-dir is required for wfa cdp extract.");
  }
  const text = await readFile(path.resolve(input), "utf8");
  const extractFn = deps.extractFileBlocksToDisk || defaultExtractFileBlocks;
  const result = await extractFn(text, {
    outputDir: path.resolve(outDir),
    ...(options.workspace ? { repositoryRoot: path.resolve(String(options.workspace)) } : {}),
  });
  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`[cdp] extracted ${result.blockCount} blocks to ${result.outputDir}\n`);
    for (const file of result.files || []) {
      stdout.write(`  - ${file.path} (${file.bytes} bytes, sha256:${(file.sha256 || "").slice(0, 12)})\n`);
    }
    stdout.write(`[cdp] manifest: ${result.manifestPath}\n`);
  }
  return { code: 0, ...result };
}

// F7 — the ONLY cleanup trigger: an explicit user-invoked command. No
// automatic post-run deletion is wired anywhere. Deletes only
// conversations flagged createdByRun/createdRunId (see cdp-cleanup.js);
// pre-existing conversations are never targets, and the run is idempotent.
async function handleCleanup(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const home = deps.home || getHomeDir();
  const { positional, options } = parseArgs(argv);
  if (options.help) {
    printCdpHelp(stdout);
    return { code: 0 };
  }
  if (positional.length) {
    throw new WfaError("INVALID_ARGUMENT", "wfa cdp cleanup does not accept positional arguments.");
  }
  const provider = options.provider === undefined ? undefined : String(options.provider).toLowerCase();
  if (provider !== undefined && !["chatgpt", "gemini", "claude"].includes(provider)) {
    throw new WfaError("INVALID_ARGUMENT", `Invalid provider "${options.provider}". Must be chatgpt, gemini, or claude.`);
  }
  const conversationId = options["conversation-id"] === undefined
    ? undefined
    : String(options["conversation-id"]).trim();
  if (conversationId !== undefined && !conversationId) {
    throw new WfaError("INVALID_ARGUMENT", "Option --conversation-id must be a non-empty string.");
  }
  const runId = options["run-id"] === undefined ? undefined : String(options["run-id"]).trim();
  if (runId !== undefined && !runId) {
    throw new WfaError("INVALID_ARGUMENT", "Option --run-id must be a non-empty string.");
  }

  const cleanupFn = deps.runCdpCleanup || defaultRunCdpCleanup;
  const result = await cleanupFn({
    home,
    ...(provider !== undefined ? { provider } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    dryRun: Boolean(options["dry-run"]),
    ...(options["chrome-path"] ? { chromePath: String(options["chrome-path"]) } : {}),
    ...(deps.recoverBrowser ? { recover: deps.recoverBrowser } : {}),
    ...(deps.connectCdp ? { connect: deps.connectCdp } : {}),
    ...(deps.driver ? { driver: deps.driver } : {}),
    ...(deps.adapters ? { adapters: deps.adapters } : {}),
    ...(deps.conversationStore ? { conversationStore: deps.conversationStore } : {}),
  });

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.dryRun) {
    if (!result.wouldDelete.length) {
      stdout.write("[cdp] cleanup (dry run): nothing created by this tool to delete\n");
    } else {
      stdout.write(`[cdp] cleanup (dry run): would delete ${result.wouldDelete.length} conversation(s) created by this tool:\n`);
      for (const url of result.wouldDelete) stdout.write(`  - ${url}\n`);
      stdout.write("[cdp] pre-existing conversations are never deleted; re-run without --dry-run to delete these\n");
    }
  } else if (!result.deleted.length && !result.failed.length) {
    stdout.write("[cdp] cleanup: nothing created by this tool to delete\n");
  } else {
    for (const url of result.deleted) stdout.write(`[cdp] cleanup: deleted ${url}\n`);
    for (const failure of result.failed) {
      stderr.write(`[cdp] cleanup: failed to delete ${failure.conversationUrl}: ${failure.reason}\n`);
    }
    stdout.write(`[cdp] cleanup: deleted ${result.deleted.length}, failed ${result.failed.length}\n`);
  }

  return { code: result.status === "partial" ? 1 : 0, result };
}

export async function runCdpCommand(argv = [], deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printCdpHelp(stdout);
    return { code: 0 };
  }

  const subcmd = argv[0];
  if (!subcmd || !["ask", "read", "status", "login", "extract", "cleanup"].includes(subcmd)) {
    stderr.write(`wfa: UNKNOWN_COMMAND: Unknown or missing cdp subcommand "${subcmd || ""}". Usage: wfa cdp <ask|read|status|login|extract|cleanup>\n`);
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
    if (subcmd === "extract") return await handleExtract(argv.slice(1), deps);
    if (subcmd === "cleanup") return await handleCleanup(argv.slice(1), deps);
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
