import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDir, getPaths } from "../paths.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import { classifyRunError } from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import * as claudeAdapter from "../browser/adapters/claude.js";
import { WfaError } from "../errors.js";
import { sha256, sleep as defaultSleep, uuid } from "../util.js";
import * as defaultConversationStore from "../browser/conversation-store.js";
import { DEFAULT_MIN_INTERVAL_MS, enforceCooldown, recordLastTurn } from "../browser/cooldown.js";
import { acquireTurnLock } from "../broker/turn-lock.js";
import { pace as defaultPace } from "../browser/pacer.js";
import { withSendSlot as defaultWithSendSlot } from "../browser/stagger.js";
import { downloadFromProvider as defaultDownloadFromProvider } from "../browser/downloads.js";
import { createPauseTracker, summarizePauses, appendPauseEvents } from "../stall-measurement.js";
import { captureComposerState, appendComposerCapture } from "../browser/composer-capture.js";

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
  // F5: Claude adapter registered here; the broker turn validation,
  // conversation store, turn store and read path accept claude since the
  // coordinator wiring (backlog/d1-f9). Selectors remain UNVERIFIED
  // against the live Claude DOM — see adapters/claude.js.
  claude: claudeAdapter,
};

// ---------------------------------------------------------------------------
// F1 — Gemini Chat/Task mode selection (registry-level only).
// --mode is the window mode (background/visible/headless); the Gemini
// Chat/Task switch is a separate page-state mode, carried as `geminiMode`.
// ---------------------------------------------------------------------------
export const GEMINI_MODES = Object.freeze(["chat", "task"]);

// "chat" when omitted/blank; the validated mode otherwise. Returns null
// for anything else so callers can reject it instead of guessing.
export function normalizeGeminiMode(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "chat";
  const normalized = String(value).trim().toLowerCase();
  return GEMINI_MODES.includes(normalized) ? normalized : null;
}

export function resolveGeminiMode(provider, value) {
  const mode = normalizeGeminiMode(value);
  if (mode === null) {
    throw new WfaError("INVALID_ARGUMENT", `Invalid --gemini-mode: ${value}. Must be chat or task.`);
  }
  if (mode === "task" && provider !== "gemini") {
    throw new WfaError("INVALID_ARGUMENT", "--gemini-mode task only applies to --provider gemini.");
  }
  return mode;
}

// F1: press the Task switch (or confirm it is already pressed) via the
// adapter's page JS, then read the mode back so the turn records what it
// actually ran in. Throws GEMINI_MODE_FAILED on any non-success so the
// turn fails closed before typing — a turn must never claim Task mode it
// did not confirm. `chat` is a no-op confirmation, not a click, when the
// page is already on Chat.
export async function applyGeminiMode(cdp, sessionId, adapter, mode) {
  if (mode !== "task" && mode !== "chat") {
    throw new WfaError("INVALID_ARGUMENT", `Invalid gemini mode: ${mode}. Must be chat or task.`);
  }
  if (!cdp || typeof cdp.send !== "function" || typeof sessionId !== "string" || !sessionId) {
    throw new WfaError("GEMINI_MODE_FAILED", "A CDP client and session are required to select the Gemini mode");
  }
  if (typeof adapter?.buildTaskModeJs !== "function") {
    return { applied: false, mode, step: "unsupported", reason: "adapter_mode_not_supported" };
  }
  const toggleRes = await cdp.send("Runtime.evaluate", {
    expression: adapter.buildTaskModeJs(mode),
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  const toggle = toggleRes?.result?.value;
  if (!toggle || toggle.success !== true) {
    throw new WfaError(
      "GEMINI_MODE_FAILED",
      `Gemini ${mode} mode could not be selected: ${toggle?.reason || "unknown"}`
    );
  }
  let confirmedMode = toggle.mode || mode;
  if (typeof adapter.buildGeminiModeStateJs === "function") {
    try {
      const stateRes = await cdp.send("Runtime.evaluate", {
        expression: adapter.buildGeminiModeStateJs(),
        returnByValue: true,
      }, sessionId);
      const state = stateRes?.result?.value;
      if (state && typeof state.mode === "string" && state.mode !== "unknown") {
        confirmedMode = state.mode;
      }
    } catch {}
  }
  if (confirmedMode !== mode) {
    throw new WfaError(
      "GEMINI_MODE_FAILED",
      `Gemini mode mismatch after toggle: requested ${mode}, page reports ${confirmedMode}`
    );
  }
  return {
    applied: toggle.step === "clicked",
    already: toggle.step === "already",
    mode: confirmedMode,
    step: toggle.step || null,
    typedBeforeClick: Number.isInteger(toggle.typedBeforeClick) ? toggle.typedBeforeClick : null,
  };
}

function isConversationInvalidated(classifier, reason, message) {
  if (String(reason || "").toLowerCase() === "conversation_invalidated") {
    return true;
  }
  const detail = [reason, message]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
  if (!detail) {
    return false;
  }
  try {
    return classifier(new Error(detail))?.code === "CONVERSATION_INVALIDATED";
  } catch {
    return false;
  }
}

async function readCurrentUrl(cdp, sessionId) {
  if (!cdp || !sessionId) return "";
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    }, sessionId);
    return typeof result?.result?.value === "string" ? result.result.value : "";
  } catch {
    return "";
  }
}

export function isSameProviderConversationUrl(adapterUrl, targetUrl) {
  try {
    const provider = new URL(adapterUrl);
    const target = new URL(targetUrl);
    return provider.protocol === "https:" && target.protocol === "https:" && provider.hostname === target.hostname;
  } catch {
    return false;
  }
}

async function performSessionCleanup({
  driver,
  cdp,
  adapter,
  cleanupTargetUrl,
  home,
  provider,
  conversationId,
  conversationStore,
  reportError,
  signal,
}) {
  if (!cleanupTargetUrl || signal?.aborted) {
    return { status: "skipped", reason: signal?.aborted ? "aborted" : "no_target", url: cleanupTargetUrl || null };
  }

  if (!isSameProviderConversationUrl(adapter?.url, cleanupTargetUrl)) {
    return { status: "skipped", reason: "target_url_rejected", url: cleanupTargetUrl };
  }

  let cleanupTab = null;
  try {
    cleanupTab = await driver.openTab(cdp, cleanupTargetUrl, { timeoutMs: 15000 });
    if (signal?.aborted) {
      return { status: "skipped", reason: "aborted", url: cleanupTargetUrl };
    }

    const script = typeof adapter.buildDeleteConversationJs === "function"
      ? adapter.buildDeleteConversationJs(cleanupTargetUrl)
      : null;

    if (!script) {
      return { status: "skipped", reason: "adapter_delete_not_supported", url: cleanupTargetUrl };
    }

    const evalResult = await cdp.send("Runtime.evaluate", {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    }, cleanupTab.sessionId);

    const res = evalResult?.result?.value;
    if (res && res.success) {
      try {
        if (typeof conversationStore.markDeleted === "function") {
          await conversationStore.markDeleted(home, provider, conversationId, cleanupTargetUrl, "deleted");
        }
      } catch (err) {
        await reportError("markDeleted", err);
      }
      return { status: "deleted", url: cleanupTargetUrl };
    }

    try {
      if (typeof conversationStore.markDeleted === "function") {
        await conversationStore.markDeleted(home, provider, conversationId, cleanupTargetUrl, "failed");
      }
    } catch (err) {
      await reportError("markDeleted", err);
    }

    return {
      status: "failed",
      reason: res?.reason || "delete_eval_failed",
      url: cleanupTargetUrl,
    };
  } catch (error) {
    try {
      if (typeof conversationStore.markDeleted === "function") {
        await conversationStore.markDeleted(home, provider, conversationId, cleanupTargetUrl, "failed");
      }
    } catch (err) {
      await reportError("markDeleted", err);
    }
    await reportError("sessionCleanup", error);
    return {
      status: "failed",
      reason: error?.message || String(error),
      url: cleanupTargetUrl,
    };
  } finally {
    if (cleanupTab && cleanupTab.targetId) {
      try {
        await cdp.send("Target.closeTarget", { targetId: cleanupTab.targetId });
      } catch {}
    }
  }
}

function isSameConversationUrl(provider, actualUrl, expectedUrl) {
  if (
    !defaultConversationStore.isValidConversationUrl(provider, actualUrl) ||
    !defaultConversationStore.isValidConversationUrl(provider, expectedUrl)
  ) {
    return false;
  }
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return actual.hostname === expected.hostname &&
      actual.pathname.replace(/\/+$/, "") === expected.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

export async function runCdpTurn({
  provider,
  prompt,
  home,
  files = [],
  conversationId = null,
  mode = "background",
  // F1: Gemini Chat/Task page mode. "chat" is the default; "task" is only
  // valid with --provider gemini (see resolveGeminiMode). This is NOT the
  // window mode — that is `mode` above.
  geminiMode = "chat",
  chromePath,
  settleMs = 4000,
  stallTimeoutMs = 420000,
  hardTimeoutMs = 900000,
  minIntervalMs,
  // Coordinator wiring: requestId identifies this run for pause logs,
  // composer captures and F7 created-by-run provenance; downloadDir
  // (F4) captures provider-produced attachments after completion.
  requestId = null,
  downloadDir = null,
  onWait,
  onProgress,
  keepBrowser = false,
  signal,
  deps = {},
} = {}) {
  const startTime = Date.now();

  if (!provider || typeof provider !== "string") {
    throw new WfaError("INVALID_ARGUMENT", "Option --provider is required. Must be chatgpt, gemini, or claude.");
  }

  const normalizedProvider = provider.toLowerCase();
  const adapters = deps.adapters || DEFAULT_ADAPTERS;
  const adapter = adapters[normalizedProvider];
  if (!adapter) {
    throw new WfaError("INVALID_ARGUMENT", `Unsupported provider "${provider}". Must be chatgpt, gemini, or claude.`);
  }
  // F1: validated here, next to adapter selection; the toggle itself runs
  // after waitForEditor, before typing (see the F1 block below).
  const resolvedGeminiMode = resolveGeminiMode(normalizedProvider, geminiMode);

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new WfaError("EMPTY_PROMPT", "Prompt text is empty or missing.");
  }

  const effectiveHome = home || getHomeDir();
  const normalizedConversationId = typeof conversationId === "string" && conversationId.trim()
    ? conversationId
    : null;
  const conversationStore = deps.conversationStore || defaultConversationStore;
  const reportConversationStoreError = async (operation, error) => {
    if (typeof deps.onConversationStoreError === "function") {
      try {
        await deps.onConversationStoreError(operation, error);
      } catch {}
      return;
    }
    try {
      console.warn(`[cdp] conversation store ${operation} failed: ${error?.message || String(error)}`);
    } catch {}
  };
  const markConversationInvalid = async (reason) => {
    if (!normalizedConversationId || typeof conversationStore.markInvalid !== "function") return;
    try {
      await conversationStore.markInvalid(
        effectiveHome,
        normalizedProvider,
        normalizedConversationId,
        reason
      );
    } catch (error) {
      await reportConversationStoreError("markInvalid", error);
    }
  };
  const sleepFn = deps.sleep || defaultSleep;
  const enforce = deps.enforceCooldown || enforceCooldown;
  const withSendSlot = deps.withSendSlot || defaultWithSendSlot;
  await enforce(effectiveHome, normalizedProvider, {
    minIntervalMs,
    now: deps.now || Date.now,
    sleep: sleepFn,
    onWait,
    // F6: per-provider cooldown from config (deps.config, loaded by the
    // broker starter); defaults apply when no config is supplied.
    ...(deps.config?.cooldown !== undefined ? { config: deps.config.cooldown } : {}),
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
  const classifyError = driver.classifyRunError || classifyRunError;

  let terminalStatus = "failed";
  let terminalHasAnswer = false;
  let targetId = null;
  let anchorTargetId = null;
  let conversationUrl = "";
  let submitted = false;
  let submittedAt = null;
  let typeRes = null;
  let turnLock = null;
  // F1: outcome of the Gemini mode toggle/state read for this turn (null
  // unless provider is gemini and a mode was selected or observed).
  let geminiModeResult = null;

  const withTerminalStatus = (result) => {
    if (!result || typeof result !== "object") return result;
    if (typeof result.status === "string") {
      terminalStatus = result.status;
      terminalHasAnswer = result.status === "completed" &&
        typeof result.text === "string" && result.text.trim().length > 0;
    }
    return {
      ...result,
      ...(targetId ? { targetId } : {}),
      ...(result.conversationUrl || conversationUrl
        ? { conversationUrl: result.conversationUrl || conversationUrl }
        : {}),
    };
  };

  try {
    // 三方裁决 2026-11-24：turn 级互斥，防止多进程共用同一 Chrome profile 时互相导航。
    // 冲突时排队，超时抛 CONCURRENT_TURN_BUSY（绝不静默抢占/重发）。
    if (!deps.skipTurnLock) {
      const acquireFn = deps.acquireTurnLock || acquireTurnLock;
      turnLock = await acquireFn(effectiveHome, normalizedProvider, {
        turnId: normalizedConversationId,
        conversationId: normalizedConversationId,
        sleep: sleepFn,
        signal,
        now: deps.lockNow || deps.now,
      });
    }

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
    let sessionId = null;
    conversationUrl = adapter.url || "";
    let storedSession = null;
    let restoreUrl = null;
    let cleanupTargetUrl = null;

    if (normalizedConversationId && typeof conversationStore.loadSession === "function") {
      try {
        storedSession = await conversationStore.loadSession(
          effectiveHome,
          normalizedProvider,
          normalizedConversationId
        );
      } catch (error) {
        await reportConversationStoreError("loadSession", error);
      }
      if (
        storedSession &&
        !storedSession.invalidated &&
        defaultConversationStore.isValidConversationUrl(normalizedProvider, storedSession.conversationUrl)
      ) {
        restoreUrl = storedSession.conversationUrl;
      } else if (
        storedSession &&
        storedSession.invalidated &&
        defaultConversationStore.isValidConversationUrl(normalizedProvider, storedSession.conversationUrl)
      ) {
        const alreadyDeleted = Array.isArray(storedSession.retired) && storedSession.retired.some(
          (r) => r.conversationUrl === storedSession.conversationUrl && r.deletedAt != null
        );
        if (!alreadyDeleted) {
          cleanupTargetUrl = storedSession.conversationUrl;
        }
      }
    }

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
      const ensureAnchor = typeof driver.ensureAnchorTab === "function"
        ? driver.ensureAnchorTab
        : (deps.driver ? null : defaultDriver.ensureAnchorTab);
      if (typeof ensureAnchor === "function") {
        const anchor = await ensureAnchor(cdp);
        anchorTargetId = anchor?.targetId || null;
      }
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      const targetUrl = restoreUrl || adapter.url;
      conversationUrl = targetUrl || "";
      const tab = await driver.openTab(cdp, targetUrl, { timeoutMs: hardTimeoutMs });
      targetId = tab.targetId;
      sessionId = tab.sessionId;
      if (typeof onProgress === "function") {
        onProgress({ conversationUrl, targetId });
      }
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

      if (restoreUrl) {
        const actualUrl = await readCurrentUrl(cdp, sessionId);

        if (!isSameConversationUrl(normalizedProvider, actualUrl, restoreUrl)) {
          await markConversationInvalid("conversation_restore_failed");
          return withTerminalStatus({
            status: "needs_human",
            text: "",
            reason: "conversation_restore_failed",
            evidence: {
              expectedConversationUrl: restoreUrl,
              actualConversationUrl: actualUrl || null,
            },
            conversationUrl: actualUrl || restoreUrl,
            browser: {
              pid: recovery.chrome?.pid ?? null,
              port: recovery.chrome?.port ?? null,
              mode,
              reused: recovery.action === "ADOPT",
            },
            elapsedMs: Date.now() - startTime,
          });
        }
        conversationUrl = actualUrl;
      }

      let initialState = await driver.readTurnState(cdp, sessionId, adapter);
      // 续聊时 SPA 历史消息可能晚于编辑器挂载；baseline 读成 0 会把旧消息误当本轮新答案。
      // 短轮询等历史稳定：连续两次采样一致即放行，上限 3s（不阻塞正常发送）。
      if (restoreUrl && (initialState?.userTurns ?? 0) === 0 && (initialState?.answerTurns ?? 0) === 0) {
        const historyDeadline = Date.now() + 3000;
        let previous = initialState;
        while (Date.now() < historyDeadline) {
          await sleepFn(400);
          const probe = await driver.readTurnState(cdp, sessionId, adapter);
          const probeTurns = (probe?.userTurns ?? 0) + (probe?.answerTurns ?? 0);
          const prevTurns = (previous?.userTurns ?? 0) + (previous?.answerTurns ?? 0);
          if (probeTurns > 0 && probeTurns === prevTurns) {
            initialState = probe;
            break;
          }
          previous = probe;
        }
      }
      if (isConversationInvalidated(
        classifyError,
        initialState?.pageError?.reason,
        initialState?.pageError?.message
      )) {
        await markConversationInvalid("conversation_invalidated");
        return withTerminalStatus({
          status: "failed",
          text: "",
          reason: "conversation_invalidated",
          evidence: {
            message: initialState?.pageError?.message || "Conversation is no longer available",
          },
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
      const baselineAnswerText = initialState?.answerText || "";

      // F1: Gemini Task mode. Runs after the editor is ready and before
      // any typing (mode is page state; a reload resets to Chat, and the
      // old gemini-mode notes record that switching preserves composer
      // content). A failed toggle throws GEMINI_MODE_FAILED and the turn
      // fails closed before the prompt is typed — never auto-resent.
      // For chat mode there is nothing to press; record the observed
      // page mode only when the adapter can report it.
      if (normalizedProvider === "gemini") {
        if (resolvedGeminiMode === "task") {
          geminiModeResult = await applyGeminiMode(cdp, sessionId, adapter, "task");
        } else if (typeof adapter.buildGeminiModeStateJs === "function") {
          try {
            const stateRes = await cdp.send("Runtime.evaluate", {
              expression: adapter.buildGeminiModeStateJs(),
              returnByValue: true,
            }, sessionId);
            const observed = stateRes?.result?.value;
            if (observed && typeof observed.mode === "string" && observed.mode !== "unknown") {
              geminiModeResult = { applied: false, already: observed.mode === "chat", mode: observed.mode, step: "observed", typedBeforeClick: null };
            }
          } catch {}
        }
      }

      // 批次 D：在 typePrompt 之前附加文件；失败即终止，绝不带着未上传的附件发 prompt。
      if (Array.isArray(files) && files.length > 0) {
        const attachFn = driver.attachFiles || defaultDriver.attachFiles;
        try {
          await attachFn(cdp, sessionId, adapter, files, { signal, sleep: sleepFn });
          // 多附件批量操作后注入 4-6s 批量节奏（三方裁决 2026-11-24），再进入输入。
          await (deps.pace || defaultPace)("batch", {
            sleep: sleepFn, signal,
            // F6: pacing ranges from config (deps.config?.pace).
            ...(deps.config?.pace !== undefined ? { config: deps.config.pace } : {}),
          });
        } catch (attachErr) {
          if (signal?.aborted || attachErr?.code === "CANCELLED") {
            const err = new Error("Operation cancelled");
            err.code = "CANCELLED";
            throw err;
          }
          return withTerminalStatus({
            status: "failed",
            text: "",
            reason: "ATTACH_UPLOAD_FAILED",
            evidence: { message: attachErr?.message || String(attachErr) },
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

      // 三方裁决 2026-11-24：人类操作节奏（日常 1-2s），经 deps 注入便于测试旁路。
      const paceFn = deps.pace || defaultPace;
      const paceConfig = deps.config?.pace;
      await paceFn("casual", {
        sleep: sleepFn, signal,
        // F6: pacing ranges from config.
        ...(paceConfig !== undefined ? { config: paceConfig } : {}),
      });

      // D6 (coordinator wiring): capture the stop-control DOM when the
      // composer gate rejects a continuation, so a real occurrence can be
      // diagnosed. Best-effort only — a failed capture never masks the
      // rejection, and the gate itself is unchanged (no guessed fix).
      const captureComposerOnce = async (trigger) => {
        if (!cdp || !sessionId) return null;
        try {
          const evaluate = (expression) => cdp.send("Runtime.evaluate", {
            expression, awaitPromise: true, returnByValue: true,
          }, sessionId);
          const capture = await (deps.captureComposerState || captureComposerState)(
            evaluate, adapter, { now: deps.now || Date.now }
          );
          const filePath = path.join(
            effectiveHome, "composer-captures", `${requestId || "run"}.jsonl`
          );
          await (deps.appendComposerCapture || appendComposerCapture)(filePath, {
            ...capture, trigger, provider: normalizedProvider,
            at: new Date().toISOString(),
          });
          return { file: filePath, trigger };
        } catch {
          return null;
        }
      };

      if (typeof driver.waitForComposerReady === "function") {
        const composerReady = await driver.waitForComposerReady(cdp, sessionId, adapter, {
          timeoutMs: Math.min(15000, hardTimeoutMs),
          sleep: sleepFn,
          signal,
        });
        if (!composerReady?.ok) {
          const composerCapture = (composerReady?.reason || "").includes("stop_state")
            ? await captureComposerOnce("composer_stop_state")
            : null;
          return withTerminalStatus({
            status: composerReady?.status || "needs_human",
            text: "",
            reason: composerReady?.reason || "composer_not_ready_stop_state",
            evidence: {
              message: "Composer did not become ready before typing. It must be editable and visible, with no active stop control.",
              ...(composerReady && typeof composerReady === "object" ? composerReady : {}),
              ...(composerCapture ? { composerCapture } : {}),
            },
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

      try {
        typeRes = await driver.typePrompt(cdp, sessionId, adapter, prompt);
      } catch (typeErr) {
        // D6: same capture on a PROMPT_NOT_TYPED rejection, then rethrow
        // unchanged — the capture is evidence, not a retry.
        if (typeErr?.code === "PROMPT_NOT_TYPED") {
          const composerCapture = await captureComposerOnce("prompt_not_typed");
          if (composerCapture) typeErr.composerCapture = composerCapture;
        }
        throw typeErr;
      }
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      // 输入完成到提交之间再注入一次日常节奏，杜绝 0 间隔击发。
      await paceFn("casual", {
        sleep: sleepFn, signal,
        // F6: pacing ranges from config.
        ...(paceConfig !== undefined ? { config: paceConfig } : {}),
      });

      // A caller-supplied conversationId is a local key, not proof that a
      // cloud conversation exists. First use and invalidated replacements
      // both open a new conversation and must use the send gate.
      const submission = await withSendSlot(normalizedProvider, async () => {
        if (signal?.aborted) {
          const err = new Error("Operation cancelled");
          err.code = "CANCELLED";
          throw err;
        }
        if (typeof deps.onSendIntent === "function") {
          const intentTime = Date.now();
          try {
            await deps.onSendIntent({ provider: normalizedProvider, prompt, submittedAt: intentTime });
            submittedAt = intentTime;
          } catch (intentErr) {
            return { intentError: intentErr, journalFailed: true };
          }
        }
        if (signal?.aborted) {
          if (typeof deps.onSendAborted === "function") {
            await deps.onSendAborted({ provider: normalizedProvider }).catch(() => {});
          }
          submittedAt = null;
          const err = new Error("Operation cancelled");
          err.code = "CANCELLED";
          throw err;
        }
        if (!submittedAt) submittedAt = Date.now();
        try {
          await driver.submitTurn(cdp, sessionId, adapter);
        } catch (submitErr) {
          if (["SEND_BUTTON_MISSING", "SEND_BUTTON_DISABLED", "SEND_BUTTON_AMBIGUOUS"].includes(submitErr?.code)) {
            if (typeof deps.onSendAborted === "function") {
              await deps.onSendAborted({ provider: normalizedProvider }).catch(() => {});
            }
            // These driver errors explicitly prove no click was performed.
            submittedAt = null;
            throw submitErr;
          }
          if (submitErr?.code === "SEND_UNCONFIRMED") throw submitErr;
          // An unexpected error after entering submit is not evidence of
          // non-submission. Keep the journal and require reconciliation.
          throw Object.assign(new Error("Submit outcome unknown; automatic retry forbidden"), {
            code: "SEND_UNCONFIRMED", cause: submitErr,
          });
        }
        return { journalFailed: false };
      }, {
        isNewConversation: !restoreUrl,
        signal,
        now: deps.staggerNow,
        sleep: deps.staggerSleep,
        random: deps.random || Math.random,
        // F6: stagger ranges from config.
        ...(deps.config?.stagger !== undefined ? { config: deps.config.stagger } : {}),
      });
      if (submission.journalFailed) {
        return withTerminalStatus({
          status: "needs_human",
          text: "",
          reason: "journal_unwritable",
          evidence: { message: submission.intentError?.message || String(submission.intentError) },
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
      submitted = true;

      // Publish the submission signal immediately after submitTurn succeeds.
      // The broker awaits this callback, so the durable turn record contains
      // sendCommittedAt before answer generation starts.
      if (typeof onProgress === "function") {
        await onProgress({ conversationUrl, targetId, sendCommittedAt: submittedAt });
      }

      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        err.sendCommittedAt = submittedAt;
        throw err;
      }

      // D5 (coordinator wiring): pause measurement. Opt-in via
      // deps.pauseEventsDir or WFA_PAUSE_EVENTS_DIR; off by default so
      // existing runs pay nothing. The tracker samples each completion
      // poll (driver.waitForCompletion pauseTracker option); events are
      // appended to <dir>/<requestId>.jsonl and summarised in evidence.
      const pauseEventsDir = deps.pauseEventsDir || process.env.WFA_PAUSE_EVENTS_DIR || null;
      const pauseTracker = pauseEventsDir
        ? (deps.createPauseTracker || createPauseTracker)({
            provider: normalizedProvider, mode, taskId: requestId,
            now: deps.now || Date.now,
          })
        : null;

      const completion = await driver.waitForCompletion(cdp, sessionId, adapter, {
        baselineUserTurns,
        baselineAnswerTurns,
        baselineAnswerText,
        settleMs,
        stallTimeoutMs,
        hardTimeoutMs,
        sleep: sleepFn,
        signal,
        ...(pauseTracker ? { pauseTracker } : {}),
      });
      let pauseSummary = null;
      if (pauseTracker) {
        try {
          pauseTracker.finish({ status: completion?.status || "unknown" });
          const pauseEvents = pauseTracker.events();
          pauseSummary = summarizePauses(pauseEvents);
          await (deps.appendPauseEvents || appendPauseEvents)(
            path.join(pauseEventsDir, `${requestId || "run"}.jsonl`), pauseEvents
          );
        } catch {}
      }
      const completionInvalidated = isConversationInvalidated(
        classifyError,
        completion?.reason,
        completion?.evidence?.pageError?.message
      );
      if (completionInvalidated) {
        await markConversationInvalid("conversation_invalidated");
      }
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        err.sendCommittedAt = submittedAt;
        throw err;
      }

      const finalUrl = await readCurrentUrl(cdp, sessionId);
      if (finalUrl) {
        conversationUrl = finalUrl;
      }
      if (typeof onProgress === "function") {
        onProgress({ conversationUrl, targetId });
      }

      const finalStatus = completionInvalidated ? "failed" : completion.status;
      const finalReason = completionInvalidated
        ? "conversation_invalidated"
        : (completion.reason ? String(completion.reason).toLowerCase() : "");

      let conversationTurns = null;
      if (
        normalizedConversationId &&
        finalStatus === "completed" &&
        submitted &&
        submittedAt != null &&
        defaultConversationStore.isValidConversationUrl(normalizedProvider, conversationUrl)
      ) {
        const previousTurnCount = Number.isSafeInteger(storedSession?.turnCount)
          ? storedSession.turnCount
          : 0;
        conversationTurns = previousTurnCount + 1;
        try {
          await conversationStore.saveSession(effectiveHome, normalizedProvider, normalizedConversationId, {
            conversationUrl,
            turnCount: conversationTurns,
            invalidated: false,
            invalidatedReason: null,
            // F7 (coordinator wiring): this run opened a new conversation
            // (no stored session was restored), so it is this run's to
            // clean up — never a pre-existing conversation. A run that
            // opens a conversation but does not complete records nothing
            // here; its URL stays on the turn record instead.
            ...(!restoreUrl ? { createdByRun: true, createdRunId: requestId ?? null } : {}),
          });
        } catch (error) {
          await reportConversationStoreError("saveSession", error);
        }
      }

      let sessionCleanupEvidence = null;
      if (
        cleanupTargetUrl &&
        !restoreUrl &&
        !signal?.aborted &&
        cdp
      ) {
        try {
          sessionCleanupEvidence = await performSessionCleanup({
            driver,
            cdp,
            adapter,
            cleanupTargetUrl,
            home: effectiveHome,
            provider: normalizedProvider,
            conversationId: normalizedConversationId,
            conversationStore,
            reportError: reportConversationStoreError,
            signal,
          });
        } catch (cleanupErr) {
          sessionCleanupEvidence = {
            status: "failed",
            reason: cleanupErr?.message || String(cleanupErr),
            url: cleanupTargetUrl,
          };
        }
      }

      // F4 (coordinator wiring): capture provider-produced downloads
      // after a completed turn. A missing control is recorded, never
      // fatal — the turn already completed; downloads are additive.
      let downloads = null;
      let downloadError = null;
      if (downloadDir && finalStatus === "completed" && cdp && sessionId) {
        try {
          const downloadFn = deps.downloadFromProvider || defaultDownloadFromProvider;
          const record = await downloadFn(cdp, sessionId, adapter, {
            downloadDir, sleep: sleepFn, signal,
          });
          downloads = [record];
        } catch (error) {
          downloadError = {
            code: error?.code || "DOWNLOAD_CAPTURE_FAILED",
            message: error?.message || String(error),
          };
        }
      }

      return withTerminalStatus({
        status: finalStatus,
        text: completion.text || "",
        reason: finalReason,
        // F1: which Gemini page mode the turn ran in (chat by default;
        // the toggle/state outcome when one was recorded).
        geminiMode: resolvedGeminiMode,
        // F4: captured provider downloads (null when --download-dir was
        // not given); the broker copies this into the turn record.
        ...(downloads ? { downloads } : {}),
        evidence: {
          ...(completion.evidence || {}),
          replacedChars: typeRes?.replacedChars ?? 0,
          ...(geminiModeResult ? { geminiMode: geminiModeResult } : {}),
          ...(sessionCleanupEvidence ? { sessionCleanup: sessionCleanupEvidence } : {}),
          ...(pauseSummary ? { pauseSummary } : {}),
          ...(downloadError ? { downloadError } : {}),
          ...(conversationTurns !== null && conversationTurns >= 40
            ? {
                conversationTurns,
                conversationWarning: "CONVERSATION_40_TURNS",
              }
            : {}),
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
      if (
        restoreUrl &&
        cdp &&
        sessionId &&
        !submitted &&
        submittedAt == null &&
        !signal?.aborted &&
        error?.code !== "CANCELLED"
      ) {
        const actualUrl = await readCurrentUrl(cdp, sessionId);
        if (!isSameConversationUrl(normalizedProvider, actualUrl, restoreUrl)) {
          await markConversationInvalid("conversation_restore_failed");
          return withTerminalStatus({
            status: "needs_human",
            text: "",
            reason: "conversation_restore_failed",
            evidence: {
              expectedConversationUrl: restoreUrl,
              actualConversationUrl: actualUrl || null,
              editorWaitError: error?.message || String(error),
            },
            conversationUrl: actualUrl || restoreUrl,
            browser: {
              pid: recovery?.chrome?.pid ?? null,
              port: recovery?.chrome?.port ?? null,
              mode,
              reused: recovery?.action === "ADOPT",
            },
            elapsedMs: Date.now() - startTime,
          });
        }
      }

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

      const classified = typeof classifyError === "function"
        ? classifyError(error)
        : { state: "failed", code: error?.code || "UNKNOWN_ERROR", detail: error?.message || String(error) };
      const conversationInvalidated = isConversationInvalidated(
        classifyError,
        error?.code,
        error?.message
      ) || classified?.code === "CONVERSATION_INVALIDATED";
      if (conversationInvalidated) {
        await markConversationInvalid("conversation_invalidated");
      }

      const committedAt = submittedAt != null ? submittedAt : (error?.sendCommittedAt != null ? error.sendCommittedAt : null);
      const reasonCode = conversationInvalidated
        ? "CONVERSATION_INVALIDATED"
        : (error?.code || classified.code || "unknown_error");
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
      const mayCloseWorkTab =
        terminalStatus === "completed" &&
        terminalHasAnswer &&
        !normalizedConversationId &&
        keepBrowser === false &&
        targetId &&
        targetId !== anchorTargetId;
      if (cdp && mayCloseWorkTab) {
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
    if (turnLock) {
      try {
        await turnLock.release();
      } catch {}
    }
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

// ---------------------------------------------------------------------------
// F2 — concurrent multi-provider fan-out with per-provider artifacts.
// Delimited section: fan-out orchestration, per-provider result files, the
// run record, and single-provider retry only. F6/F7 engine threading and F8
// fallback wiring live elsewhere; do not extend this section with them.
//
// Rules enforced here (AGENTS.md concurrency rule, phase one):
// - different conversations may run in parallel; the same conversation is
//   strictly serial (runCdpTurn's turn lock owns that per provider+key);
// - at most ONE in-flight generation per provider and at most TWO across
//   providers; `--serial` (serial: true) forces global serial execution.
// - a retry is only for a provider whose turn ended in a definite
//   pre-submit failure (see FANOUT_RETRYABLE_REASONS). timed_out,
//   recoverable, interrupted_unknown, stalled, send_unconfirmed and any
//   turn with sendCommittedAt set are never auto-resent.
// - the run record stores a prompt SHA-256, never the prompt text.
// ---------------------------------------------------------------------------

export const FANOUT_MAX_TOTAL = 2;
export const FANOUT_MAX_PER_PROVIDER = 1;
export const FANOUT_SUPPORTED_PROVIDERS = Object.freeze(["chatgpt", "gemini"]);

// Definite pre-submit failures: the prompt provably never reached a provider
// page, so a retry cannot double-send. Every reason here is produced before
// typePrompt/submitTurn in runCdpTurn, or by a gate that runs before typing.
// Anything that can follow a submission is deliberately absent.
export const FANOUT_RETRYABLE_REASONS = Object.freeze(new Set([
  "login_required",
  "send_button_missing",
  "send_button_disabled",
  "send_button_ambiguous",
  "editor_not_found",
  "prompt_not_typed",
  "composer_not_ready_stop_state",
  "journal_unwritable",
  "conversation_restore_failed",
  "conversation_invalidated",
  "attach_upload_failed",
  "chrome_port_missing",
]));

export function normalizeFanoutProviders(values) {
  const supplied = (values ?? []).flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim().toLowerCase()).filter(Boolean);
  const providers = [...new Set(supplied)];
  if (!providers.length) {
    throw new WfaError("INVALID_ARGUMENT", "At least one provider is required for a fan-out run.");
  }
  for (const provider of providers) {
    if (!FANOUT_SUPPORTED_PROVIDERS.includes(provider)) {
      throw new WfaError("INVALID_ARGUMENT",
        `Unsupported provider "${provider}" for fan-out. Supported: ${FANOUT_SUPPORTED_PROVIDERS.join(", ")}.`);
    }
  }
  return providers;
}

export function fanoutPromptSha256(prompt) {
  return sha256(prompt);
}

// The retry gate. A provider may be retried only when its turn ended in a
// definite failure state AND nothing was submitted: sendCommittedAt must be
// absent. needs_human counts only for the pre-submit reasons in the set
// (e.g. login_required); send_unconfirmed is needs_human too and is excluded.
export function isRetryableFanoutFailure(entry) {
  if (!entry || (entry.status !== "failed" && entry.status !== "needs_human")) return false;
  if (entry.sendCommittedAt != null) return false;
  return FANOUT_RETRYABLE_REASONS.has(String(entry.reason ?? "").toLowerCase());
}

export function fanoutRunState(results) {
  if (!results.length) return "failed";
  if (results.every((result) => result.status === "completed")) return "completed";
  if (results.some((result) => result.status === "completed")) return "partial";
  return "failed";
}

function fanoutEnvelope({ provider, requestId, conversationId, result, error = null }) {
  if (error) {
    return {
      provider, requestId, conversationId: conversationId ?? null, turnId: null,
      status: "failed",
      reason: String(error?.code ?? "fanout_provider_error").toLowerCase(),
      error: error?.message ?? String(error),
      text: "", conversationUrl: "", sendCommittedAt: null, elapsedMs: null, resultPath: null,
      attempts: [],
    };
  }
  return {
    provider, requestId, conversationId: conversationId ?? null,
    turnId: result?.id ?? result?.turnId ?? null,
    status: result?.status ?? "failed",
    reason: result?.reason != null ? String(result.reason).toLowerCase() : null,
    error: result?.error ?? null,
    // Text is kept in the envelope for the caller; the run record on disk
    // stores only the artifact path, never the answer text.
    text: typeof result?.text === "string" ? result.text : "",
    conversationUrl: result?.conversationUrl ?? "",
    sendCommittedAt: result?.sendCommittedAt ?? null,
    elapsedMs: result?.elapsedMs ?? null,
    resultPath: null,
    attempts: [],
  };
}

function fanoutRecordEnvelope(envelope) {
  const { text, ...record } = envelope;
  return record;
}

async function writeFanoutArtifacts({ runDir, record }) {
  await mkdir(runDir, { recursive: true });
  for (const entry of record.results) {
    if (entry.status === "completed" && typeof entry._text === "string" && entry._text.length > 0) {
      const providerDir = path.join(runDir, entry.provider);
      await mkdir(providerDir, { recursive: true });
      const resultPath = path.join(providerDir, "response.md");
      await writeFile(resultPath, entry._text, { encoding: "utf8", mode: 0o600 });
      entry.resultPath = resultPath;
    }
    delete entry._text;
  }
  const recordPath = path.join(runDir, "fanout.json");
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...record, recordPath };
}

export async function loadFanoutRecord(runDir) {
  if (!runDir) throw new WfaError("INVALID_ARGUMENT", "A fan-out run directory is required.");
  let raw;
  try {
    raw = await readFile(path.join(path.resolve(runDir), "fanout.json"), "utf8");
  } catch {
    throw new WfaError("FANOUT_RECORD_NOT_FOUND", `No fan-out run record found in ${path.resolve(runDir)}.`);
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new WfaError("FANOUT_RECORD_INVALID", `Fan-out run record in ${path.resolve(runDir)} is not valid JSON.`);
  }
  if (!record || record.kind !== "fanout" || !Array.isArray(record.results)) {
    throw new WfaError("FANOUT_RECORD_INVALID", `Fan-out run record in ${path.resolve(runDir)} is not a fan-out record.`);
  }
  return record;
}

// Fan the same brief out to several providers in parallel, one in-flight
// generation per provider and at most FANOUT_MAX_TOTAL across providers.
// Each provider runs through runTurn (default: runCdpTurn); a provider that
// throws or fails never aborts the others, and its failure is recorded
// per-provider in the run record. Per-provider answers are written to
// <runDir>/<provider>/response.md — the compare naming convention
// (<provider>/response.md, one result file per provider) — and the run
// record <runDir>/fanout.json carries per-provider status, never prompt text.
export async function runCdpFanout({
  providers,
  prompt,
  home,
  runId = uuid(),
  baseRequestId = null,
  outDir = null,
  serial = false,
  mode = "background",
  conversationId = null,
  files = [],
  settleMs,
  stallTimeoutMs,
  hardTimeoutMs,
  minIntervalMs,
  runTurn = null,
  deps = {},
  onProgress,
} = {}) {
  const normalizedProviders = normalizeFanoutProviders(providers);
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new WfaError("EMPTY_PROMPT", "Provide a prompt for the fan-out run.");
  }
  const effectiveHome = home || getHomeDir();
  const runDir = outDir ? path.resolve(outDir) : path.join(getPaths(effectiveHome).runs, String(runId));
  const requestBase = baseRequestId ? String(baseRequestId).trim() : uuid();
  if (!requestBase) throw new WfaError("INVALID_ARGUMENT", "Option --request-id must be a non-empty string.");
  const concurrency = serial ? 1 : Math.min(FANOUT_MAX_TOTAL, normalizedProviders.length);
  const turnFn = typeof runTurn === "function"
    ? runTurn
    : (args) => runCdpTurn({ ...args, deps: args.deps ?? deps });
  const promptSha256 = fanoutPromptSha256(prompt);
  const createdAt = new Date().toISOString();

  const results = new Array(normalizedProviders.length).fill(null);
  let next = 0;
  const runOneProvider = async (index) => {
    const provider = normalizedProviders[index];
    const providerRequestId = `${requestBase}:${provider}`;
    const providerConversationId = conversationId ? `${conversationId}:${provider}` : null;
    let envelope;
    try {
      const result = await turnFn({
        provider, prompt, home: effectiveHome, files,
        conversationId: providerConversationId, mode,
        requestId: providerRequestId, settleMs, stallTimeoutMs, hardTimeoutMs, minIntervalMs,
        deps,
      });
      envelope = fanoutEnvelope({ provider, requestId: providerRequestId, conversationId: providerConversationId, result });
    } catch (error) {
      envelope = fanoutEnvelope({ provider, requestId: providerRequestId, conversationId: providerConversationId, error });
    }
    envelope._text = envelope.text;
    results[index] = envelope;
    if (typeof onProgress === "function") {
      try { await onProgress({ ...envelope, text: envelope.text }); } catch {}
    }
  };
  // Bounded worker pool: at most `concurrency` providers in flight, one per
  // provider by construction (providers are deduplicated above). A worker
  // takes the next provider only when its previous turn has settled.
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < normalizedProviders.length) {
      const index = next;
      next += 1;
      await runOneProvider(index);
    }
  });
  await Promise.all(workers);

  const record = {
    version: 1, kind: "fanout", runId: String(runId), runDir, createdAt,
    promptSha256, mode, serial: Boolean(serial), concurrency,
    providers: normalizedProviders, baseRequestId: requestBase,
    files: [...files],
    settleMs: settleMs ?? null, stallTimeoutMs: stallTimeoutMs ?? null,
    hardTimeoutMs: hardTimeoutMs ?? null, minIntervalMs: minIntervalMs ?? null,
    state: fanoutRunState(results),
    results: results.map((envelope) => fanoutRecordEnvelope(envelope)),
  };
  // Attach the answer text only for artifact writing; it is stripped from
  // the persisted record by writeFanoutArtifacts.
  record.results.forEach((entry, index) => { entry._text = results[index].text; });
  const saved = await writeFanoutArtifacts({ runDir, record });
  const publicResults = results.map((envelope) => {
    const savedEntry = saved.results.find((item) => item.provider === envelope.provider);
    const { _text, ...rest } = envelope;
    return { ...rest, resultPath: savedEntry?.resultPath ?? null };
  });
  return { runId: String(runId), runDir, state: saved.state, promptSha256, results: publicResults, record: saved };
}

// Retry exactly one provider of a recorded fan-out run. The prompt must be
// supplied again and must hash to the recorded brief — the record never
// stores prompt text. The retry mints a fresh request id derived from the
// original (`<requestId>:retry:<n>`) so broker idempotency is preserved per
// attempt and a retry can never be confused with the original turn. Only the
// named provider runs; every other provider's artifact is left untouched.
export async function retryFanoutProvider({
  runDir,
  record = null,
  provider,
  prompt,
  home,
  runTurn = null,
  deps = {},
} = {}) {
  const loaded = record ?? await loadFanoutRecord(runDir);
  const normalized = normalizeFanoutProviders([provider])[0];
  const entry = loaded.results.find((item) => item.provider === normalized);
  if (!entry) {
    throw new WfaError("FANOUT_PROVIDER_NOT_FOUND",
      `Provider ${normalized} has no entry in fan-out run ${loaded.runId}.`);
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new WfaError("EMPTY_PROMPT", "Provide the original prompt to retry a provider.");
  }
  if (fanoutPromptSha256(prompt) !== loaded.promptSha256) {
    throw new WfaError("FANOUT_PROMPT_MISMATCH",
      "Retry prompt does not match the recorded fan-out brief. Resend the identical brief; use a new fan-out run for a different prompt.");
  }
  if (!isRetryableFanoutFailure(entry)) {
    throw new WfaError("FANOUT_RETRY_REFUSED",
      `Provider ${normalized} ended in state=${entry.status} reason=${entry.reason ?? "unknown"}`
      + `${entry.sendCommittedAt != null ? " with sendCommittedAt set" : ""}.`
      + " Only a definite pre-submit failure may be retried; inspect the provider tab or run"
      + ` wfa cdp read --task-id ${entry.turnId ?? entry.requestId} before resending.`);
  }
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
  const attemptNumber = attempts.length + 1;
  const retryRequestId = `${entry.requestId}:retry:${attemptNumber}`;
  const turnFn = typeof runTurn === "function"
    ? runTurn
    : (args) => runCdpTurn({ ...args, deps: args.deps ?? deps });
  let result;
  try {
    result = await turnFn({
      provider: normalized, prompt, home: home ?? loaded.home ?? getHomeDir(),
      files: loaded.files ?? [], conversationId: entry.conversationId ?? null,
      mode: loaded.mode ?? "background", requestId: retryRequestId,
      settleMs: loaded.settleMs ?? undefined, stallTimeoutMs: loaded.stallTimeoutMs ?? undefined,
      hardTimeoutMs: loaded.hardTimeoutMs ?? undefined, minIntervalMs: loaded.minIntervalMs ?? undefined,
      deps,
    });
  } catch (error) {
    result = { status: "failed", reason: String(error?.code ?? "fanout_provider_error").toLowerCase(),
      error: error?.message ?? String(error), text: "" };
  }
  const envelope = fanoutEnvelope({
    provider: normalized, requestId: retryRequestId,
    conversationId: entry.conversationId ?? null, result,
    error: null,
  });
  const attempt = {
    requestId: retryRequestId, turnId: envelope.turnId, status: envelope.status,
    reason: envelope.reason, at: new Date().toISOString(),
  };
  const updated = {
    ...entry, ...envelope, text: undefined, _text: envelope.text,
    attempts: [...attempts, attempt], retriedAt: attempt.at,
  };
  delete updated.text;
  loaded.results = loaded.results.map((item) => (item.provider === normalized ? updated : item));
  loaded.state = fanoutRunState(loaded.results.map((item) => ({ status: item.status })));
  loaded.updatedAt = new Date().toISOString();
  const runDirPath = runDir ? path.resolve(runDir) : path.resolve(loaded.runDir);
  const saved = await writeFanoutArtifacts({ runDir: runDirPath, record: loaded });
  const savedEntry = saved.results.find((item) => item.provider === normalized);
  const { _text, ...publicEntry } = updated;
  return { record: saved, result: { ...publicEntry, resultPath: savedEntry?.resultPath ?? null }, runDir: runDirPath };
}
