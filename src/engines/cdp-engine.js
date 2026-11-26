import { getHomeDir } from "../paths.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import { classifyRunError } from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import * as claudeAdapter from "../browser/adapters/claude.js";
import { WfaError } from "../errors.js";
import { sleep as defaultSleep } from "../util.js";
import * as defaultConversationStore from "../browser/conversation-store.js";
import { DEFAULT_MIN_INTERVAL_MS, enforceCooldown, recordLastTurn } from "../browser/cooldown.js";
import { acquireTurnLock } from "../broker/turn-lock.js";
import { pace as defaultPace } from "../browser/pacer.js";
import { withSendSlot as defaultWithSendSlot } from "../browser/stagger.js";

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
  claude: claudeAdapter,
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
  stallTimeoutMs = 420000,
  hardTimeoutMs = 900000,
  minIntervalMs,
  geminiMode = null,
  downloadDir = null,
  cleanupCreated = false,
  onWait,
  onProgress,
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
  const withSendSlot = deps.withSendSlot || defaultWithSendSlot;
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
  let terminalHasAnswer = false;
  let targetId = null;
  let anchorTargetId = null;
  let conversationUrl = "";
  let submitted = false;
  let submittedAt = null;
  let typeRes = null;
  let turnLock = null;

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
      let downloadBeforeFiles = null;
      if (downloadDir) {
        const cfgDl = typeof driver.configureDownloadBehavior === "function"
          ? driver.configureDownloadBehavior
          : defaultDriver.configureDownloadBehavior;
        const snapDl = typeof driver.snapshotDownloadDir === "function"
          ? driver.snapshotDownloadDir
          : defaultDriver.snapshotDownloadDir;
        await cfgDl(cdp, downloadDir);
        downloadBeforeFiles = await snapDl(downloadDir);
      }
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
      if (normalizedProvider === "gemini" && geminiMode) {
        const ensureModeFn = typeof driver.ensureProviderMode === "function"
          ? driver.ensureProviderMode
          : defaultDriver.ensureProviderMode;
        await ensureModeFn(cdp, sessionId, adapter, geminiMode, {
          sleep: sleepFn,
          signal,
        });
      }
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

      // 三方裁决 2026-11-24：人类操作节奏（日常 1-2s），经 deps 注入便于测试旁路。
      const paceFn = deps.pace || defaultPace;
      await paceFn("casual", { sleep: sleepFn, signal });

      if (typeof driver.waitForComposerReady === "function") {
        const composerReady = await driver.waitForComposerReady(cdp, sessionId, adapter, {
          timeoutMs: Math.min(15000, hardTimeoutMs),
          sleep: sleepFn,
          signal,
        });
        if (!composerReady?.ok) {
          return withTerminalStatus({
            status: composerReady?.status || "needs_human",
            text: "",
            reason: composerReady?.reason || "composer_not_ready_stop_state",
            evidence: {
              message: "Composer did not become ready before typing. It must be editable and visible, with no active stop control.",
              ...(composerReady && typeof composerReady === "object" ? composerReady : {}),
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

      typeRes = await driver.typePrompt(cdp, sessionId, adapter, prompt);
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      // 输入完成到提交之间再注入一次日常节奏，杜绝 0 间隔击发。
      await paceFn("casual", { sleep: sleepFn, signal });

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

      let downloads = null;
      if (downloadDir && finalStatus === "completed") {
        const collectDl = typeof driver.collectDownloads === "function"
          ? driver.collectDownloads
          : defaultDriver.collectDownloads;
        downloads = await collectDl({
          downloadDir,
          beforeFiles: downloadBeforeFiles || new Set(),
        });
      }
      const createdByWfa = Boolean(!restoreUrl && conversationUrl && conversationUrl !== adapter.url);
      let createdCleanup = null;
      if (cleanupCreated && createdByWfa && finalStatus === "completed" && !signal?.aborted && cdp) {
        if (typeof adapter.buildDeleteConversationJs === "function") {
          try {
            const delExpr = adapter.buildDeleteConversationJs(conversationUrl);
            const delRes = await cdp.send("Runtime.evaluate", {
              expression: delExpr,
              awaitPromise: true,
              returnByValue: true,
            }, sessionId);
            createdCleanup = { status: delRes?.result?.value?.deleted ? "deleted" : "attempted", url: conversationUrl, createdByWfa: true };
          } catch (cleanupErr) {
            createdCleanup = { status: "failed", reason: cleanupErr?.message || String(cleanupErr), url: conversationUrl, createdByWfa: true };
          }
        } else {
          createdCleanup = { status: "skipped", reason: "adapter_delete_not_supported", url: conversationUrl, createdByWfa: true };
        }
      } else if (cleanupCreated && !createdByWfa) {
        createdCleanup = { status: "skipped", reason: "preexisting_conversation_preserved", url: conversationUrl || null, createdByWfa: false };
      }

      return withTerminalStatus({
        status: finalStatus,
        text: completion.text || "",
        reason: finalReason,
        downloads,
        createdByWfa,
        ...(createdCleanup ? { createdCleanup } : {}),
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
