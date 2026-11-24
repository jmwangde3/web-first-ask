
import { WfaError } from "../errors.js";

function buildEvidence(state, lastProgressAgoMs) {
  return {
    userTurns: state?.userTurns ?? 0,
    answerTurns: state?.answerTurns ?? 0,
    answerChars: (state?.answerText || "").length,
    stopVisible: Boolean(state?.stopVisible),
    editorEmpty: Boolean(state?.editorEmpty),
    title: state?.title ?? "",
    pageError: state?.pageError ?? null,
    lastProgressAgoMs: Math.max(0, lastProgressAgoMs ?? 0),
  };
}

export async function openTab(cdp, url, { timeoutMs = 60000 } = {}) {
  const targetResult = await cdp.send("Target.createTarget", { url: "about:blank", background: true }, undefined, {
    timeoutMs,
  });
  if (!targetResult || !targetResult.targetId) {
    throw new WfaError("TARGET_CREATE_FAILED", "Target.createTarget failed to return a targetId");
  }
  const { targetId } = targetResult;

  const attachResult = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined, {
    timeoutMs,
  });
  if (!attachResult || !attachResult.sessionId) {
    throw new WfaError("ATTACH_FAILED", `Target.attachToTarget failed to return sessionId for ${targetId}`);
  }
  const { sessionId } = attachResult;

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  // Pin the page timezone before any script runs. Session-scoped so each tab
  // is isolated; must precede Page.navigate so first-paint code sees Asia/Tokyo.
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Tokyo" }, sessionId);

  if (url) {
    await cdp.send("Page.navigate", { url }, sessionId);
  }

  return { targetId, sessionId };
}

export async function waitForEditor(cdp, sessionId, adapter, {
  timeoutMs = 60000,
  pollIntervalMs = 200,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal,
} = {}) {
  const startTime = now();
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(adapter.editorSelector)});
    const bodyText = (document.body && (document.body.innerText || document.body.textContent) || "").trim();
    const hasPassword = Boolean(document.querySelector('input[type="password"]'));
    return {
      found: Boolean(el),
      title: document.title || "",
      hasPassword,
      bodyLength: bodyText.length,
      emptyBody: bodyText.length === 0,
    };
  })()`;

  let lastTitle = "";
  let lastBodyLength = 0;
  let lastHasPassword = false;
  let consecutiveChallenged = 0;

  const challengePattern = adapter.turnChallengeTitlePattern || adapter.challengeTitlePattern || /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;

  while (now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      const err = new Error("Operation cancelled");
      err.code = "CANCELLED";
      throw err;
    }
    try {
      const res = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      }, sessionId);

      const val = res?.result?.value;
      if (val) {
        if (typeof val.title === "string") {
          lastTitle = val.title;
        }
        if (typeof val.bodyLength === "number") {
          lastBodyLength = val.bodyLength;
        }
        if (val.found) {
          return true;
        }

        const titleMatches = challengePattern.test(val.title || "");
        const hasPassword = Boolean(val.hasPassword);

        lastHasPassword = hasPassword;

        const isPollChallenged = hasPassword || titleMatches;
        if (isPollChallenged) {
          consecutiveChallenged += 1;
          if (consecutiveChallenged >= 2) {
            const err = new WfaError(
              "HUMAN_VERIFICATION_REQUIRED",
              `Human verification required for ${adapter.id} (title: "${lastTitle}")`,
              { details: { title: lastTitle, adapter: adapter.id, challenge: true, bodyLength: lastBodyLength } }
            );
            err.title = lastTitle;
            throw err;
          }
        } else {
          consecutiveChallenged = 0;
        }
      }
    } catch (err) {
      if (err?.code === "CDP_CLOSED" || err?.code === "CANCELLED" || err?.code === "HUMAN_VERIFICATION_REQUIRED") throw err;
    }
    await sleep(pollIntervalMs);
  }

  const isChallenge = Boolean(lastHasPassword || challengePattern.test(lastTitle));

  if (isChallenge) {
    const err = new WfaError(
      "HUMAN_VERIFICATION_REQUIRED",
      `Human verification required for ${adapter.id} (title: "${lastTitle}")`,
      { details: { title: lastTitle, adapter: adapter.id, challenge: true, bodyLength: lastBodyLength } }
    );
    err.title = lastTitle;
    throw err;
  }

  const err = new WfaError(
    "EDITOR_NOT_FOUND",
    `Editor not found within ${timeoutMs}ms for ${adapter.id} (title: "${lastTitle}")`,
    { details: { title: lastTitle, adapter: adapter.id } }
  );
  err.title = lastTitle;
  throw err;
}

export function normalizePromptText(str) {
  return String(str ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .trim();
}

export function foldEditorLines(str) {
  return String(str ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

export function isPromptTextMatch(expected, observed) {
  const a = foldEditorLines(normalizePromptText(expected));
  const b = foldEditorLines(normalizePromptText(observed));
  return a === b;
}

export async function typePrompt(cdp, sessionId, adapter, text) {
  if (typeof text !== "string" || text.length === 0) {
    const err = new WfaError("PROMPT_NOT_TYPED", "Prompt text is empty or invalid");
    throw err;
  }

  const focusExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(adapter.editorSelector)});
    if (!el) return { kind: "none" };
    el.focus();
    const kind = ("value" in el) ? "value" : "editable";
    let replacedChars = 0;
    if (kind === "editable") {
      const rawText = el.innerText || el.textContent || "";
      const cleaned = rawText.replace(/[\\s\\u00a0\\u200b]/g, "");
      if (cleaned.length > 0) {
        replacedChars = rawText.length;
      }
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } else if (kind === "value") {
      const val = el.value || "";
      const cleaned = val.replace(/[\\s\\u00a0\\u200b]/g, "");
      if (cleaned.length > 0) {
        replacedChars = val.length;
      }
    }
    return { kind, replacedChars };
  })()`;

  const focusRes = await cdp.send("Runtime.evaluate", {
    expression: focusExpr,
    returnByValue: true,
  }, sessionId);

  const val = focusRes?.result?.value;
  let kind = "none";
  let replacedChars = 0;
  if (val === true) {
    kind = "editable";
  } else if (val && typeof val === "object" && typeof val.kind === "string") {
    kind = val.kind;
    replacedChars = Number.isInteger(val.replacedChars) && val.replacedChars >= 0 ? val.replacedChars : 0;
  }

  if (!kind || kind === "none") {
    const err = new WfaError("EDITOR_NOT_FOUND", `Editor element not found for ${adapter.id}`);
    throw err;
  }

  if (kind === "editable") {
    await cdp.send("Input.insertText", { text }, sessionId);

    // Read back and compare normalized text
    const readBackExpr = `(() => {
      const el = document.querySelector(${JSON.stringify(adapter.editorSelector)});
      if (!el) return null;
      return el.innerText || el.textContent || "";
    })()`;

    const readRes = await cdp.send("Runtime.evaluate", {
      expression: readBackExpr,
      returnByValue: true,
    }, sessionId);

    const observedText = readRes?.result?.value;
    if (!isPromptTextMatch(text, observedText)) {
      const normObserved = normalizePromptText(observedText);
      const normExpected = normalizePromptText(text);
      throw new WfaError(
        "PROMPT_NOT_TYPED",
        `Prompt text mismatch in editor for ${adapter.id} (observed length ${normObserved.length}, expected ${normExpected.length})`
      );
    }

    return { typedChars: text.length, replacedChars };
  }

  if (kind === "value") {
    const valueExpr = `(() => {
      const el = document.querySelector(${JSON.stringify(adapter.editorSelector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value === ${JSON.stringify(text)};
    })()`;

    const valRes = await cdp.send("Runtime.evaluate", {
      expression: valueExpr,
      returnByValue: true,
    }, sessionId);

    if (!valRes?.result?.value) {
      throw new WfaError("PROMPT_NOT_TYPED", `Failed to set value on editor for ${adapter.id}`);
    }

    return { typedChars: text.length, replacedChars };
  }

  throw new WfaError("PROMPT_NOT_TYPED", `Unknown editor kind "${kind}" for ${adapter.id}`);
}

/**
 * 批次 D 新增：为 native CDP 附加文件到 Provider 界面
 * @param {object} cdp CDP 客户端连接
 * @param {string} sessionId 当前页面的 Target Session ID
 * @param {object} adapter Provider 适配器定义
 * @param {string[]} filePaths 需要附加的绝对文件路径数组
 * @param {object} options
 */
export async function attachFiles(cdp, sessionId, adapter, filePaths = [], {
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  attachmentVerifyTimeoutMs = 7000,
  attachmentVerifyIntervalMs = 200,
} = {}) {
  if (signal?.aborted) {
    const err = new Error("Operation cancelled");
    err.code = "CANCELLED";
    throw err;
  }

  if (!filePaths || !filePaths.length) {
    return { attached: [], provider: adapter?.id || "unknown", skipped: [] };
  }

  // 1. 严格校验绝对路径
  const absolutePaths = filePaths.map((fp) => String(fp).trim());
  for (const fp of absolutePaths) {
    const isAbs = /^[a-zA-Z]:[\\/]/.test(fp) || fp.startsWith("/") || fp.startsWith("\\\\");
    if (!isAbs) {
      throw new WfaError("ATTACHMENT_NOT_FOUND", `Attachment path must be absolute: ${fp}`);
    }
  }

  // 2. 若 adapter 需要触发前端上传前置动作（例如 Gemini 展开菜单），先执行 buildUploadJs
  if (typeof adapter.buildUploadJs === "function") {
    const uploadJs = adapter.buildUploadJs();
    if (uploadJs) {
      const evalRes = await cdp.send("Runtime.evaluate", {
        expression: uploadJs,
        returnByValue: true,
        awaitPromise: true,
      }, sessionId);

      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }

      const resVal = evalRes?.result?.value;
      if (resVal && resVal.success === false) {
        throw new WfaError("ATTACH_UPLOAD_FAILED", `Failed to prepare upload UI: ${resVal.reason || "unknown"}`);
      }
    }
  }

  const selector = adapter.fileInputSelector || 'input[type="file"]';

  // 3. 核心机制：CDP DOM 查找与 DOM.setFileInputFiles
  // 先通过 DOM.getDocument 拿 root nodeId，再用 DOM.querySelector 查询 input 元素
  let fileNodeId = null;
  let backendNodeId = null;

  try {
    const doc = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
    if (doc?.root?.nodeId) {
      const queryRes = await cdp.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      }, sessionId);
      if (queryRes?.nodeId) {
        fileNodeId = queryRes.nodeId;
      }
    }
  } catch {}

  // 兜底路径：若 DOM.querySelector 未直接拿到有效 nodeId，通过 Runtime.evaluate 解析 DOM 并提取 backendNodeId
  if (!fileNodeId) {
    const evalNode = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    }, sessionId);
    const objectId = evalNode?.result?.objectId;
    if (objectId) {
      try {
        const desc = await cdp.send("DOM.describeNode", { objectId }, sessionId);
        backendNodeId = desc?.node?.backendNodeId;
      } catch {}
    }
  }

  if (!fileNodeId && !backendNodeId) {
    throw new WfaError("ATTACH_UPLOAD_FAILED", `File input element not found for selector: ${selector}`);
  }

  if (signal?.aborted) {
    const err = new Error("Operation cancelled");
    err.code = "CANCELLED";
    throw err;
  }

  // 选择理由：优先采用 CDP DOM.setFileInputFiles 配合 nodeId 或 backendNodeId 注入，
  // 避免使用 Page.setInterceptFileChooserDialog（其需要真实触发用户点击并捕获原生文件选择对话框，在隐藏式 input 或不同 OS 平台下时序不可靠）。
  try {
    if (fileNodeId) {
      await cdp.send("DOM.setFileInputFiles", {
        files: absolutePaths,
        nodeId: fileNodeId,
      }, sessionId);
    } else {
      await cdp.send("DOM.setFileInputFiles", {
        files: absolutePaths,
        backendNodeId,
      }, sessionId);
    }
  } catch (err) {
    throw new WfaError("ATTACH_UPLOAD_FAILED", `CDP DOM.setFileInputFiles failed: ${err.message || String(err)}`);
  }

  if (signal?.aborted) {
    const err = new Error("Operation cancelled");
    err.code = "CANCELLED";
    throw err;
  }

  // 4. 等待并验证附件 chip 出现（2026-11-24 真机证据）：
  // React 读文件进 state 后清空 input.files，chip 才是真实成功标志；
  // 它出现前就提交 prompt 会导致 "I don't see an attached file"。
  // input.files 仅作诊断，绝不参与成功判定。
  const verifyJs = typeof adapter.buildAttachmentVerifyJs === "function"
    ? adapter.buildAttachmentVerifyJs(absolutePaths)
    : null;
  if (verifyJs) {
    let diag = null;
    const deadline = now() + attachmentVerifyTimeoutMs;
    while (now() < deadline) {
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }
      const res = await cdp.send("Runtime.evaluate", {
        expression: verifyJs,
        returnByValue: true,
      }, sessionId);
      diag = res?.result?.value || null;
      if (diag?.present) break;
      await sleep(attachmentVerifyIntervalMs);
    }
    if (!diag?.present) {
      throw new WfaError(
        "ATTACH_UPLOAD_FAILED",
        `Attachment chip not visible within ${attachmentVerifyTimeoutMs}ms for ${adapter?.id || "unknown"}. ` +
          `diagnostics=${JSON.stringify({ inputFiles: diag?.inputFiles ?? null, chipCount: diag?.chipCount ?? 0 })}`
      );
    }
  }

  // 5. 不在此处重复 waitForEditor：调用方 engine 已在 openTab 后等待过 editor，
  // 这里再等一次在 mock/慢渲染下会额外卡 15s，且上传本身不改变 editor 可用性。

  return {
    attached: absolutePaths,
    provider: adapter?.id || "unknown",
    skipped: [],
  };
}

export async function submitTurn(cdp, sessionId, adapter, {
  sendButtonTimeoutMs = 2000,
  pollIntervalMs = 100,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (adapter.sendSelector) {
    const startTime = now();
    let lastProbe = null;

    while (now() - startTime < sendButtonTimeoutMs) {
      const probeExpr = `(() => {
        const all = [...document.querySelectorAll(${JSON.stringify(adapter.sendSelector)})];
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
          if (style && (style.display === "none" || style.visibility === "hidden")) return false;
          if (typeof el.getBoundingClientRect === "function") {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }
          return true;
        };
        const isEnabled = (el) => Boolean(el && !el.disabled && el.getAttribute("aria-disabled") !== "true");

        const visible = all.filter(isVisible);
        const enabled = visible.filter(isEnabled);

        return {
          exists: all.length > 0,
          visibleCount: visible.length,
          enabledCount: enabled.length,
          visible: visible.length > 0,
          disabled: visible.length > 0 && enabled.length === 0,
        };
      })()`;

      const probeRes = await cdp.send("Runtime.evaluate", {
        expression: probeExpr,
        returnByValue: true,
      }, sessionId).catch(() => null);

      const val = probeRes?.result?.value;
      lastProbe = val;

      if (val?.exists && val.visible && !val.disabled) {
        const clickExpr = `(() => {
          const all = [...document.querySelectorAll(${JSON.stringify(adapter.sendSelector)})];
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (style && (style.display === "none" || style.visibility === "hidden")) return false;
            if (typeof el.getBoundingClientRect === "function") {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }
            return true;
          };
          const isEnabled = (el) => Boolean(el && !el.disabled && el.getAttribute("aria-disabled") !== "true");

          const visible = all.filter(isVisible);
          const enabled = visible.filter(isEnabled);

          if (enabled.length === 1) {
            const btn = enabled[0];
            btn.click();
            return { clicked: true };
          }
          if (enabled.length === 0) {
            return { clicked: false, reason: visible.length ? "disabled" : "missing" };
          }
          return { clicked: false, reason: "ambiguous" };
        })()`;

        let clickRes;
        try {
          clickRes = await cdp.send("Runtime.evaluate", {
            expression: clickExpr,
            returnByValue: true,
          }, sessionId);
        } catch (cause) {
          const err = new WfaError("SEND_UNCONFIRMED", "CDP click outcome unknown; automatic retry forbidden");
          err.cause = cause;
          throw err;
        }

        if (!clickRes || clickRes.exceptionDetails) {
          const err = new WfaError("SEND_UNCONFIRMED", "Click evaluation raised an exception or returned empty; outcome unknown");
          throw err;
        }

        const outcome = clickRes.result?.value;
        if (outcome?.clicked === true) {
          return { submittedAt: now(), method: "click" };
        }

        if (outcome?.clicked === false) {
          if (outcome.reason === "ambiguous") {
            const err = new WfaError("SEND_BUTTON_AMBIGUOUS", "Multiple eligible send buttons; no click performed");
            throw err;
          }
          if (outcome.reason === "missing" || outcome.reason === "disabled") {
            await sleep(pollIntervalMs);
            continue; // proven no click happened
          }
        }

        const err = new WfaError("SEND_UNCONFIRMED", "Invalid CDP click result; automatic retry forbidden");
        throw err;
      }

      await sleep(pollIntervalMs);
    }

    if (!lastProbe?.exists || !lastProbe.visible) {
      throw new WfaError("SEND_BUTTON_MISSING", `Send button not found or not visible for ${adapter.id}`);
    }
    if (lastProbe?.disabled) {
      throw new WfaError("SEND_BUTTON_DISABLED", `Send button remained disabled after prompt input for ${adapter.id}`);
    }
    throw new WfaError("SEND_BUTTON_MISSING", `Send button could not be clicked for ${adapter.id}`);
  }

  // Fallback path ONLY for adapters lacking sendSelector
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    windowsVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
    text: "\r",
  }, sessionId);

  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
  }, sessionId);

  return { submittedAt: now(), method: "enter" };
}

export async function readTurnState(cdp, sessionId, adapter) {
  const expression = adapter.buildReadStateJs();
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  }, sessionId);

  const raw = res?.result?.value;
  if (!raw) {
    return {
      userTurns: 0,
      answerTurns: 0,
      answerText: "",
      answerActionsVisible: null,
      stopVisible: false,
      editorEmpty: false,
      title: "",
      hasChallenge: false,
      loggedOut: false,
      hasProseMirror: false,
      hasMobileComposer: false,
      signedIn: false,
      signedOut: false,
      pageError: null,
    };
  }

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    let pageError = null;
    if (parsed.pageError && typeof parsed.pageError === "object") {
      pageError = {
        reason: parsed.pageError.reason === "provider_rate_limited" || parsed.pageError.reason === "conversation_invalidated"
          ? parsed.pageError.reason
          : "provider_error",
        message: typeof parsed.pageError.message === "string" ? parsed.pageError.message : "",
      };
    }

    return {
      userTurns: Number(parsed.userTurns) || 0,
      answerTurns: Number(parsed.answerTurns) || 0,
      answerText: typeof parsed.answerText === "string" ? parsed.answerText : "",
      answerActionsVisible: parsed.answerActionsVisible === null || parsed.answerActionsVisible === undefined
        ? null
        : Boolean(parsed.answerActionsVisible),
      stopVisible: Boolean(parsed.stopVisible),
      editorEmpty: parsed.editorEmpty !== null && parsed.editorEmpty !== undefined ? Boolean(parsed.editorEmpty) : null,
      title: typeof parsed.title === "string" ? parsed.title : "",
      hasChallenge: Boolean(parsed.hasChallenge),
      loggedOut: Boolean(parsed.loggedOut),
      hasProseMirror: Boolean(parsed.hasProseMirror),
      hasMobileComposer: Boolean(parsed.hasMobileComposer),
      signedIn: Boolean(parsed.signedIn),
      signedOut: Boolean(parsed.signedOut),
      pageError,
    };
  } catch {
    return {
      userTurns: 0,
      answerTurns: 0,
      answerText: "",
      answerActionsVisible: null,
      stopVisible: false,
      editorEmpty: null,
      title: "",
      hasChallenge: false,
      loggedOut: false,
      hasProseMirror: false,
      hasMobileComposer: false,
      signedIn: false,
      signedOut: false,
      pageError: null,
    };
  }
}

export async function waitForCompletion(cdp, sessionId, adapter, {
  baselineAnswerTurns = 0,
  baselineUserTurns = 0,
  baselineAnswerText = "",
  settleMs = 4000,
  unresolvedGraceMs = 6000,
  stopGraceMs = 60000,
  hardTimeoutMs = 900000,
  stallTimeoutMs = 180000,
  ackTimeoutMs = 30000,
  pollIntervalMs = 500,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal,
} = {}) {
  const startTime = now();
  let lastProgressAt = startTime;
  let hasAcked = false;
  let sawCurrentAnswer = false;
  let lastAnswerChars = 0;
  let lastAnswerText = "";
  let lastState = null;
  let stopVisibleSince = null;
  let unresolvedSince = null;

  const challengePattern = adapter.turnChallengeTitlePattern || adapter.challengeTitlePattern || /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;

  while (true) {
    if (signal?.aborted) {
      const err = new Error("Operation cancelled");
      err.code = "CANCELLED";
      throw err;
    }
    const elapsedMs = now() - startTime;
    if (elapsedMs >= hardTimeoutMs) {
      return {
        status: "needs_human",
        reason: "hard_timeout",
        text: sawCurrentAnswer ? (lastState?.answerText || "") : "",
        elapsedMs,
        evidence: buildEvidence(lastState, now() - lastProgressAt),
      };
    }

    const state = await readTurnState(cdp, sessionId, adapter);
    lastState = state;

    if (state.stopVisible) {
      if (stopVisibleSince === null) stopVisibleSince = now();
      unresolvedSince = null;
    } else {
      stopVisibleSince = null;
    }

    const composerReady = (state.editorEmpty !== null && state.editorEmpty !== undefined) || Boolean(state.hasProseMirror);
    const challenged = (state.hasChallenge || challengePattern.test(state.title || "")) && !composerReady;

    if (challenged) {
      return {
        status: "needs_human",
        reason: "human_verification_required",
        text: sawCurrentAnswer ? (state.answerText || "") : "",
        elapsedMs: now() - startTime,
        evidence: buildEvidence(state, now() - lastProgressAt),
      };
    }

    const currentAnswerText = (state.answerText || "").trim();
    // 真机证据（2026-11-24）：续聊时 userTurns 已+1 但 answerTurns 未增，页面唯一文本是上一轮
    // 旧答案（smoke-actions2: answerTurns=1, 20575 字符旧答案却返回 completed）。
    // 本轮新答案判定：轮次增加，或（原地覆写时）文本相对基线发生变化。文本必须非空。
    const baseText = String(baselineAnswerText || "").trim();
    const isNewTurn = state.answerTurns > baselineAnswerTurns;
    // 仅在显式提供基线文本时才用文本变化判定（覆盖原地覆写）；未提供时不可凭任意非空历史文本判新，
    // 否则会破坏 pre-ACK 的 rate-limit 快速失败等既有语义。
    const textChanged = baseText ? currentAnswerText !== baseText : false;
    if (currentAnswerText && (isNewTurn || textChanged)) {
      sawCurrentAnswer = true;
    }
    // Tier 1 (pre-ACK): only fatal rate-limit fast-fails, to avoid 30s send_unconfirmed dead-wait
    if (state.pageError?.reason === "provider_rate_limited" && !sawCurrentAnswer) {
      return {
        status: "needs_human",
        reason: "provider_rate_limited",
        text: sawCurrentAnswer ? (state.answerText || "") : "",
        elapsedMs: now() - startTime,
        evidence: buildEvidence(state, now() - lastProgressAt),
      };
    }

    if (!hasAcked) {
      const ackConfirmed = (state.userTurns > baselineUserTurns) || (state.editorEmpty === true);
      if (ackConfirmed) {
        hasAcked = true;
        lastProgressAt = now();
        lastAnswerText = state.answerText || "";
        lastAnswerChars = lastAnswerText.length;
      } else {
        if (now() - startTime >= ackTimeoutMs) {
          return {
            status: "stalled",
        reason: "send_unconfirmed",
        text: sawCurrentAnswer ? (state.answerText || "") : "",
            elapsedMs: now() - startTime,
            evidence: buildEvidence(state, now() - lastProgressAt),
          };
        }
        await sleep(pollIntervalMs);
        continue;
      }
    }

    // Tier 2 (post-ACK): all page errors, still protecting a current-turn answer
    if (state.pageError && !sawCurrentAnswer) {
      return {
        status: "needs_human",
        reason: state.pageError.reason,
        text: sawCurrentAnswer ? (state.answerText || "") : "",
        elapsedMs: now() - startTime,
        evidence: buildEvidence(state, now() - lastProgressAt),
      };
    }

    const currentText = state.answerText || "";
    const currentChars = currentText.length;
    if (currentChars > lastAnswerChars || (currentText && currentText !== lastAnswerText)) {
      lastProgressAt = now();
      lastAnswerChars = currentChars;
      lastAnswerText = currentText;
      unresolvedSince = null;
    }

    if (now() - lastProgressAt >= stallTimeoutMs) {
      return {
        status: "stalled",
        reason: "no_progress",
        text: sawCurrentAnswer ? (state.answerText || "") : "",
        elapsedMs: now() - startTime,
        evidence: buildEvidence(state, now() - lastProgressAt),
      };
    }

    const hasAnswer = (state.answerText || "").trim().length > 0;
    const settled = (now() - lastProgressAt) >= settleMs;
    const stopVisibleForMs = stopVisibleSince === null ? 0 : now() - stopVisibleSince;
    const stopGone = !state.stopVisible;
    const stopDegraded = state.stopVisible && stopVisibleForMs >= stopGraceMs;
    // 若 adapter 提供回答完成标记（如 Gemini 的 message-actions），它必须可见才算完成。
    // 真机证据（2026-11-24）：Gemini 长思考暂停时停止按钮会消失，仅靠 stopGone 会把
    // 只输出了 18 字符的回答判为完成，而完整回答（20575 字符）要几十秒后才继续生成。
    const actionsDone = state.answerActionsVisible === null || state.answerActionsVisible === undefined
      ? true
      : state.answerActionsVisible === true;
    const actionsGraceMs = 180000;
    const actionsStale = !actionsDone && (now() - lastProgressAt) >= actionsGraceMs;

    // 必须确认本轮产生了新答案，才允许 completed；否则旧答案会从各终态分支泄漏（裁决见 wfa-resume-bug-verdict.md）。
    if (sawCurrentAnswer && hasAnswer && settled && (stopGone || stopDegraded) && (actionsDone || actionsStale)) {
      return {
        status: "completed",
        reason: actionsStale
          ? "completed_actions_unverified"
          : (stopDegraded ? "completed_stop_signal_unreliable" : "completed"),
        text: state.answerText,
        elapsedMs: now() - startTime,
        evidence: {
          ...buildEvidence(state, now() - lastProgressAt),
          stopVisibleForMs,
          stopSignalDegraded: stopDegraded,
          actionsUnverified: actionsStale,
        },
      };
    }

    const unresolvedCandidate = state.answerTurns > baselineAnswerTurns && stopGone && settled && !hasAnswer;
    if (unresolvedCandidate) {
      if (unresolvedSince === null) {
        unresolvedSince = now();
      } else if (now() - unresolvedSince >= unresolvedGraceMs) {
        const confirm = await readTurnState(cdp, sessionId, adapter);
        lastState = confirm;
        const confirmHasAnswer = (confirm.answerText || "").trim().length > 0;
        const confirmStopGone = !confirm.stopVisible;
        const confirmCandidate = confirm.answerTurns > baselineAnswerTurns && confirmStopGone && confirmHasAnswer === false;
        if (confirmCandidate) {
          return {
            status: "failed",
            reason: "MESSAGE_SELECTOR_UNRESOLVED",
            text: "",
            elapsedMs: now() - startTime,
            evidence: buildEvidence(confirm, now() - lastProgressAt),
          };
        }
        unresolvedSince = null;
      }
    } else {
      unresolvedSince = null;
    }

    await sleep(pollIntervalMs);
  }
}

export function classifyRunError(error) {
  const code = error?.code || "UNKNOWN_ERROR";
  const message = error?.message || String(error);
  const conversationInvalidatedPattern =
    /conversation not found|chat not found|context length|maximum context|对话不存在|上下文过长|会话已失效/i;

  if (
    code === "CONVERSATION_INVALIDATED" ||
    conversationInvalidatedPattern.test(message) ||
    conversationInvalidatedPattern.test(code)
  ) {
    return {
      state: "failed",
      code: "CONVERSATION_INVALIDATED",
      detail: message,
    };
  }

  if (
    code === "HUMAN_VERIFICATION_REQUIRED" ||
    code === "SEND_BUTTON_MISSING" ||
    code === "SEND_BUTTON_DISABLED" ||
    code === "SEND_BUTTON_AMBIGUOUS" ||
    code === "PROMPT_NOT_TYPED" ||
    /cloudflare|human_verification|challenges\.cloudflare|captcha|just a moment|security check|sign in|log in/i.test(message) ||
    /cloudflare|human_verification|challenges\.cloudflare|captcha|just a moment|security check|sign in|log in/i.test(code)
  ) {
    return {
      state: "needs_human",
      code: code === "UNKNOWN_ERROR" ? "HUMAN_VERIFICATION_REQUIRED" : code,
      detail: message,
    };
  }

  return {
    state: "failed",
    code,
    detail: message,
  };
}
