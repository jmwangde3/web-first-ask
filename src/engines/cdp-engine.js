import { getHomeDir } from "../paths.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import { classifyRunError } from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import { WfaError } from "../errors.js";
import { sleep as defaultSleep } from "../util.js";

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
  keepBrowser = false,
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
  const sleepFn = deps.sleep || defaultSleep;

  const recovery = await recover({
    home: home || getHomeDir(),
    mode: recoveryMode,
    chromePath,
    probes: deps.probes,
  });

  if (recovery.action === "RECOVERY_REQUIRED") {
    return {
      status: "needs_human",
      text: "",
      reason: recovery.reason,
      evidence: recovery.evidence,
      conversationUrl: "",
      browser: null,
      elapsedMs: Date.now() - startTime,
    };
  }

  if (!recovery.chrome?.port) {
    return {
      status: "failed",
      text: "",
      reason: recovery.reason || "CHROME_PORT_MISSING",
      evidence: recovery.evidence || null,
      conversationUrl: "",
      browser: null,
      elapsedMs: Date.now() - startTime,
    };
  }

  let cdp = null;
  let targetId = null;
  let sessionId = null;
  let conversationUrl = adapter.url || "";

  try {
    cdp = await connect(recovery.chrome.port);

    const tab = await driver.openTab(cdp, adapter.url, { timeoutMs: hardTimeoutMs });
    targetId = tab.targetId;
    sessionId = tab.sessionId;

    if (mode === "background") {
      try {
        const windowInfo = await cdp.send("Browser.getWindowForTarget", { targetId }).catch(() => null);
        if (windowInfo && typeof windowInfo.windowId !== "undefined") {
          await cdp.send("Browser.setWindowBounds", {
            windowId: windowInfo.windowId,
            bounds: { left: -2000, top: -2000, windowState: "normal" },
          }).catch(() => {});
        }
      } catch {}
    } else if (mode === "visible") {
      try {
        const windowInfo = await cdp.send("Browser.getWindowForTarget", { targetId }).catch(() => null);
        if (windowInfo && typeof windowInfo.windowId !== "undefined") {
          await cdp.send("Browser.setWindowBounds", {
            windowId: windowInfo.windowId,
            bounds: { left: 100, top: 100, windowState: "normal" },
          }).catch(() => {});
        }
      } catch {}
    }

    await driver.waitForEditor(cdp, sessionId, adapter, {
      timeoutMs: hardTimeoutMs,
      sleep: sleepFn,
    });

    const initialState = await driver.readTurnState(cdp, sessionId, adapter);
    const baselineUserTurns = initialState?.userTurns ?? 0;
    const baselineAnswerTurns = initialState?.answerTurns ?? 0;

    await driver.typePrompt(cdp, sessionId, adapter, prompt);
    await driver.submitTurn(cdp, sessionId, adapter);

    const completion = await driver.waitForCompletion(cdp, sessionId, adapter, {
      baselineUserTurns,
      baselineAnswerTurns,
      settleMs,
      stallTimeoutMs,
      hardTimeoutMs,
      sleep: sleepFn,
    });

    try {
      const urlRes = await cdp.send("Runtime.evaluate", {
        expression: "window.location.href",
        returnByValue: true,
      }, sessionId);
      if (urlRes?.result?.value && typeof urlRes.result.value === "string") {
        conversationUrl = urlRes.result.value;
      }
    } catch {}

    return {
      status: completion.status,
      text: completion.text || "",
      reason: completion.reason || "",
      evidence: completion.evidence || null,
      conversationUrl,
      browser: {
        pid: recovery.chrome?.pid ?? null,
        port: recovery.chrome?.port ?? null,
        mode,
        reused: recovery.action === "ADOPT",
      },
      elapsedMs: Date.now() - startTime,
    };
  } catch (error) {
    const classifier = driver.classifyRunError || classifyRunError;
    const classified = typeof classifier === "function"
      ? classifier(error)
      : { state: "failed", code: error?.code || "UNKNOWN_ERROR", detail: error?.message || String(error) };

    return {
      status: classified.state,
      text: "",
      reason: error?.code || classified.code || "UNKNOWN_ERROR",
      evidence: error?.details || { message: error?.message || String(error) },
      conversationUrl,
      browser: {
        pid: recovery?.chrome?.pid ?? null,
        port: recovery?.chrome?.port ?? null,
        mode,
        reused: recovery?.action === "ADOPT",
      },
      elapsedMs: Date.now() - startTime,
    };
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
}
