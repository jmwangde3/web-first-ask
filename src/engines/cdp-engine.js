import { getHomeDir } from "../paths.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import { classifyRunError } from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import { WfaError } from "../errors.js";
import { sleep as defaultSleep } from "../util.js";
import { DEFAULT_MIN_INTERVAL_MS, enforceCooldown, recordLastTurn } from "../browser/cooldown.js";

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
};

export async function runCdpTurn({
  provider,
  prompt,
  home,
  mode = "background",
  chromePath,
  settleMs = 4000,
  stallTimeoutMs = 180000,
  hardTimeoutMs = 900000,
  minIntervalMs,
  onWait,
  keepBrowser = false,
  signal,
  deps = {},
} = {}) {
  const startTime = Date.now();

  if (!provider || typeof provider !== "string") {
    throw new WfaError("INVALID_ARGUMENT", "Option --provider is required. Must be chatgpt or gemini.");
  }

  const normalizedProvider = provider.toLowerCase();
  const adapters = deps.adapters || DEFAULT_ADAPTERS;
  const adapter = adapters[normalizedProvider];
  if (!adapter) {
    throw new WfaError("INVALID_ARGUMENT", `Unsupported provider "${provider}". Must be chatgpt or gemini.`);
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new WfaError("EMPTY_PROMPT", "Prompt text is empty or missing.");
  }

  const effectiveHome = home || getHomeDir();
  const sleepFn = deps.sleep || defaultSleep;
  const enforce = deps.enforceCooldown || enforceCooldown;
  await enforce(effectiveHome, normalizedProvider, {
    minIntervalMs,
    now: deps.now || Date.now,
    sleep: sleepFn,
    onWait,
  });

  if (signal?.aborted) {
    return {
      status: "failed",
      text: "",
      reason: "cancelled",
      evidence: null,
      conversationUrl: "",
      browser: null,
      elapsedMs: Date.now() - startTime,
    };
  }

  let recoveryMode;
  if (mode === "background" || mode === "visible" || mode === "headless") {
    // launchChrome now understands all three modes, so pass them through
    // instead of collapsing background and visible into the same window state.
    recoveryMode = mode;
  } else {
    throw new WfaError("INVALID_ARGUMENT", `Invalid mode: ${mode}. Must be background, visible, or headless.`);
  }

  const recover = deps.recoverBrowser || recoverBrowser;
  const connect = deps.connectCdp || connectCdp;
  const driver = deps.driver || defaultDriver;

  let terminalStatus = "failed";
  let submitted = false;
  let submittedAt = null;
  let typeRes = null;

  const withTerminalStatus = (result) => {
    if (result && typeof result.status === "string") {
      terminalStatus = result.status;
    }
    return result;
  };

  try {
    const recovery = await recover({
      home: effectiveHome,
      mode: recoveryMode,
      chromePath,
      probes: deps.probes,
    });

    if (signal?.aborted) {
      return withTerminalStatus({
        status: "failed",
        text: "",
        reason: "cancelled",
        evidence: null,
        conversationUrl: "",
        browser: null,
        elapsedMs: Date.now() - startTime,
      });
    }

    if (recovery.action === "RECOVERY_REQUIRED") {
      return withTerminalStatus({
        status: "needs_human",
        text: "",
        reason: recovery.reason,
        evidence: recovery.evidence,
        conversationUrl: "",
        browser: null,
        elapsedMs: Date.now() - startTime,
      });
    }

    if (!recovery.chrome?.port) {
      return withTerminalStatus({
        status: "failed",
        text: "",
        reason: String(recovery.reason || "chrome_port_missing").toLowerCase(),
        evidence: recovery.evidence || null,
        conversationUrl: "",
        browser: null,
        elapsedMs: Date.now() - startTime,
      });
    }

    let cdp = null;
    let targetId = null;
    let sessionId = null;
    let conversationUrl = adapter.url || "";

    const tryCancelActiveGeneration = async () => {
      if (submitted && cdp && sessionId) {
        try {
          await Promise.race([
            (async () => {
              await cdp.send("Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                windowsVirtualKeyCode: 27,
                key: "Escape",
                code: "Escape",
              }, sessionId);
              await cdp.send("Input.dispatchKeyEvent", {
                type: "keyUp",
                windowsVirtualKeyCode: 27,
                key: "Escape",
                code: "Escape",
              }, sessionId);
            })(),
            new Promise((r) => setTimeout(r, 450)),
          ]);
        } catch {}
      }
    };

    try {
      cdp = await connect(recovery.chrome.port);
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      const tab = await driver.openTab(cdp, adapter.url, { timeoutMs: hardTimeoutMs });
      targetId = tab.targetId;
      sessionId = tab.sessionId;
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      await driver.waitForEditor(cdp, sessionId, adapter, {
        timeoutMs: hardTimeoutMs,
        sleep: sleepFn,
        signal,
      });
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      const initialState = await driver.readTurnState(cdp, sessionId, adapter);
      if (initialState?.loggedOut) {
        return withTerminalStatus({
          status: "needs_human",
          text: "",
          reason: "login_required",
          evidence: { title: initialState.title || "", adapter: adapter.id, loggedOut: true },
          conversationUrl,
          browser: {
            pid: recovery.chrome?.pid ?? null,
            port: recovery.chrome?.port ?? null,
            mode,
            reused: recovery.action === "ADOPT",
          },
          elapsedMs: Date.now() - startTime,
        });
      }

      const baselineUserTurns = initialState?.userTurns ?? 0;
      const baselineAnswerTurns = initialState?.answerTurns ?? 0;

      if (typeof deps.onSendIntent === "function") {
        const intentTime = Date.now();
        try {
          await deps.onSendIntent({ provider: normalizedProvider, prompt, submittedAt: intentTime });
          submittedAt = intentTime;
        } catch (intentErr) {
          return withTerminalStatus({
            status: "needs_human",
            text: "",
            reason: "journal_unwritable",
            evidence: { message: intentErr?.message || String(intentErr) },
            conversationUrl,
            browser: {
              pid: recovery.chrome?.pid ?? null,
              port: recovery.chrome?.port ?? null,
              mode,
              reused: recovery.action === "ADOPT",
            },
            elapsedMs: Date.now() - startTime,
          });
        }
      }

      typeRes = await driver.typePrompt(cdp, sessionId, adapter, prompt);
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      if (!submittedAt) {
        submittedAt = Date.now();
      }
      try {
        await driver.submitTurn(cdp, sessionId, adapter);
      } catch (submitErr) {
        if (submitErr?.code !== "SEND_UNCONFIRMED") {
          if (typeof deps.onSendAborted === "function") {
            await deps.onSendAborted({ provider: normalizedProvider }).catch(() => {});
          }
        }
        throw submitErr;
      }
      submitted = true;
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        err.sendCommittedAt = submittedAt;
        throw err;
      }

      const completion = await driver.waitForCompletion(cdp, sessionId, adapter, {
        baselineUserTurns,
        baselineAnswerTurns,
        settleMs,
        stallTimeoutMs,
        hardTimeoutMs,
        sleep: sleepFn,
        signal,
      });
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        err.sendCommittedAt = submittedAt;
        throw err;
      }

      try {
        const urlRes = await cdp.send("Runtime.evaluate", {
          expression: "window.location.href",
          returnByValue: true,
        }, sessionId);
        if (urlRes?.result?.value && typeof urlRes.result.value === "string") {
          conversationUrl = urlRes.result.value;
        }
      } catch {}

      return withTerminalStatus({
        status: completion.status,
        text: completion.text || "",
        reason: completion.reason ? String(completion.reason).toLowerCase() : "",
        evidence: {
          ...(completion.evidence || {}),
          replacedChars: typeRes?.replacedChars ?? 0,
        },
        conversationUrl,
        ...(submittedAt != null ? { sendCommittedAt: submittedAt } : {}),
        browser: {
          pid: recovery.chrome?.pid ?? null,
          port: recovery.chrome?.port ?? null,
          mode,
          reused: recovery.action === "ADOPT",
        },
        elapsedMs: Date.now() - startTime,
      });
    } catch (error) {
      if (signal?.aborted || error?.code === "CANCELLED") {
        await tryCancelActiveGeneration();
        const committedAt = submittedAt != null ? submittedAt : (error?.sendCommittedAt != null ? error.sendCommittedAt : null);
        return withTerminalStatus({
          status: "failed",
          text: "",
          reason: "cancelled",
          evidence: typeRes
            ? {
                typedChars: typeRes.typedChars,
                replacedChars: typeRes.replacedChars,
              }
            : null,
          conversationUrl,
          ...(committedAt != null ? { sendCommittedAt: committedAt } : {}),
          browser: {
            pid: recovery?.chrome?.pid ?? null,
            port: recovery?.chrome?.port ?? null,
            mode,
            reused: recovery?.action === "ADOPT",
          },
          elapsedMs: Date.now() - startTime,
        });
      }

      if (error?.code === "SEND_UNCONFIRMED") {
        return withTerminalStatus({
          status: "needs_human",
          reason: "send_unconfirmed",
          text: "",
          elapsedMs: Date.now() - startTime,
          evidence: {
            sendOutcome: "unknown",
            method: "click",
            ...(typeRes ? { typedChars: typeRes.typedChars, replacedChars: typeRes.replacedChars } : {}),
          },
          conversationUrl,
          browser: {
            pid: recovery?.chrome?.pid ?? null,
            port: recovery?.chrome?.port ?? null,
            mode,
            reused: recovery?.action === "ADOPT",
          },
          ...(submittedAt != null ? { sendCommittedAt: submittedAt } : {}),
        });
      }

      const classifier = driver.classifyRunError || classifyRunError;
      const classified = typeof classifier === "function"
        ? classifier(error)
        : { state: "failed", code: error?.code || "UNKNOWN_ERROR", detail: error?.message || String(error) };

      const committedAt = submittedAt != null ? submittedAt : (error?.sendCommittedAt != null ? error.sendCommittedAt : null);
      const reasonCode = error?.code || classified.code || "unknown_error";
      const baseEvidence = (error?.details && typeof error.details === "object")
        ? error.details
        : { message: error?.message || String(error) };
      const evidence = {
        ...baseEvidence,
        ...(typeRes ? { typedChars: typeRes.typedChars, replacedChars: typeRes.replacedChars } : {}),
      };

      return withTerminalStatus({
        status: classified.state,
        text: "",
        reason: String(reasonCode).toLowerCase(),
        evidence,
        conversationUrl,
        ...(committedAt != null ? { sendCommittedAt: committedAt } : {}),
        browser: {
          pid: recovery?.chrome?.pid ?? null,
          port: recovery?.chrome?.port ?? null,
          mode,
          reused: recovery?.action === "ADOPT",
        },
        elapsedMs: Date.now() - startTime,
      });
    } finally {
      if (cdp && targetId) {
        try {
          await cdp.send("Target.closeTarget", { targetId });
        } catch {}
      }
      if (cdp) {
        try {
          cdp.close();
        } catch {}
      }
    }
  } finally {
    try {
      const recorder = deps.recordLastTurn || recordLastTurn;
      await recorder(effectiveHome, normalizedProvider, {
        finishedAt: Date.now(),
        status: terminalStatus,
        countsForCooldown: Boolean(submitted || submittedAt != null),
      });
    } catch {}
  }
}
