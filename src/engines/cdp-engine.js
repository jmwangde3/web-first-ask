import { getHomeDir } from "../paths.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import { classifyRunError } from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import { WfaError } from "../errors.js";
import { sleep as defaultSleep } from "../util.js";
import * as defaultConversationStore from "../browser/conversation-store.js";
import { DEFAULT_MIN_INTERVAL_MS, enforceCooldown, recordLastTurn } from "../browser/cooldown.js";
import { acquireTurnLock } from "../broker/turn-lock.js";
import { pace as defaultPace } from "../browser/pacer.js";
import { waitForSendSlot as defaultWaitForSendSlot } from "../browser/stagger.js";

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
};

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
  const waitForSendSlot = deps.waitForSendSlot || defaultWaitForSendSlot;
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
  const classifyError = driver.classifyRunError || classifyRunError;

  let terminalStatus = "failed";
  let submitted = false;
  let submittedAt = null;
  let typeRes = null;
  let turnLock = null;

  const withTerminalStatus = (result) => {
    if (result && typeof result.status === "string") {
      terminalStatus = result.status;
    }
    return result;
  };

  try {
    // 三方裁决 2026-11-24：turn 级互斥，防止多进程共用同一 Chrome profile 时互相导航。
    // 冲突时排队，超时抛 CONCURRENT_TURN_BUSY（绝不静默抢占/重发）。
    if (!deps.skipTurnLock) {
      const acquireFn = deps.acquireTurnLock || acquireTurnLock;
      turnLock = await acquireFn(effectiveHome, normalizedProvider, {
        turnId: conversationId || null,
        conversationId: conversationId || null,
        sleep: sleepFn,
        signal,
        now: deps.now || Date.now,
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
    let targetId = null;
    let sessionId = null;
    let conversationUrl = adapter.url || "";
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

      // 批次 D：在 typePrompt 之前附加文件；失败即终止，绝不带着未上传的附件发 prompt。
      if (Array.isArray(files) && files.length > 0) {
        const attachFn = driver.attachFiles || defaultDriver.attachFiles;
        try {
          await attachFn(cdp, sessionId, adapter, files, { signal, sleep: sleepFn });
          // 多附件批量操作后注入 4-6s 批量节奏（三方裁决 2026-11-24），再进入输入。
          await (deps.pace || defaultPace)("batch", { sleep: sleepFn, signal });
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

      // 三方裁决 2026-11-24：人类操作节奏（日常 1-2s），经 deps 注入便于测试旁路。
      const paceFn = deps.pace || defaultPace;
      await paceFn("casual", { sleep: sleepFn, signal });

      typeRes = await driver.typePrompt(cdp, sessionId, adapter, prompt);
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      // 输入完成到提交之间再注入一次日常节奏，杜绝 0 间隔击发。
      await paceFn("casual", { sleep: sleepFn, signal });

      // 三方裁决 2026-11-24：同 provider 发送错峰硬限制（仅新会话），在实际 submit 之前排队 3-5s。
      // 放在发送时刻而非入口，避免页面加载/输入耗时差异导致"预约错开但实际发送仍重叠"。
      await waitForSendSlot(normalizedProvider, {
        isNewConversation: !conversationId,
        sleep: sleepFn,
        signal,
        now: deps.now || Date.now,
        random: deps.random || Math.random,
      });

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
        baselineAnswerText,
        settleMs,
        stallTimeoutMs,
        hardTimeoutMs,
        sleep: sleepFn,
        signal,
      });
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

      return withTerminalStatus({
        status: finalStatus,
        text: completion.text || "",
        reason: finalReason,
        evidence: {
          ...(completion.evidence || {}),
          replacedChars: typeRes?.replacedChars ?? 0,
          ...(sessionCleanupEvidence ? { sessionCleanup: sessionCleanupEvidence } : {}),
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
