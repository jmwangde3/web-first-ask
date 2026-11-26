
import { WfaError } from "../errors.js";
import { createAliveStallPolicy, DEFAULT_CONTINUED_WAIT_BUDGET_MS } from "../stall-alive.js";

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

// D5 fix (2026-11-26): whether the page shows a positive completion
// signal. For providers that require one, the field must be literally
// true. For the rest, a missing field counts as "done" ONLY when nothing
// is pending: the real Gemini adapter reports null exactly when
// pendingCount is 0 and no actions element exists, so a null seen together
// with pending nodes in flight must not count as a completion signal. The
// old loop masked this because a present pendingCount also held `settled`
// false; with that presence refresh removed (see waitForCompletion), the
// null-with-pending shape would otherwise complete a still-streaming turn.
function isActionsDone(state, requiresActions) {
  if (requiresActions) return state?.answerActionsVisible === true;
  if (state?.answerActionsVisible === true) return true;
  if (state?.answerActionsVisible === null || state?.answerActionsVisible === undefined) {
    return !(Number.isInteger(state?.pendingCount) && state.pendingCount > 0);
  }
  return false;
}

const anchorTargetByBrowser = new Map();
const anchorCreationByBrowser = new Map();

// D7: the interstitial detector is the adapter's own pattern —
// turnChallengeTitlePattern first, then challengeTitlePattern. The literal
// below is only the fallback this file already used in waitForEditor and
// waitForCompletion; it is not a second detector.
const FALLBACK_CHALLENGE_PATTERN = /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;

export function challengePatternFor(adapter) {
  return adapter?.turnChallengeTitlePattern || adapter?.challengeTitlePattern || FALLBACK_CHALLENGE_PATTERN;
}

// D7: same challenged condition waitForCompletion already used: the adapter
// reports a challenge (password field or challenge title) and no composer
// is usable on the page. A page with a live editor is not challenged even
// if its title happens to match.
export function isChallengedState(state, adapter) {
  if (!state || typeof state !== "object") return false;
  const composerReady = (state.editorEmpty !== null && state.editorEmpty !== undefined) ||
    Boolean(state.hasProseMirror);
  return (Boolean(state.hasChallenge) || challengePatternFor(adapter).test(state.title || "")) &&
    !composerReady;
}

// D7: park a challenged tab on about:blank so a retry never inherits the
// interstitial page (the blank tab no longer matches the conversation URL,
// so the next read/ask opens a fresh tab). Best-effort: a failed navigate
// must not mask the human_verification_required report it accompanies.
export async function parkChallengedTab(cdp, sessionId) {
  if (!cdp || typeof cdp.send !== "function" || typeof sessionId !== "string" || !sessionId) {
    return { parked: false, reason: "invalid_args" };
  }
  try {
    await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
    return { parked: true, url: "about:blank" };
  } catch {
    return { parked: false, reason: "navigate_failed" };
  }
}

// D8: activate the TAB (Target.activateTarget) so a throttled/frozen
// background tab can be read. This deliberately does NOT call
// Page.bringToFront: per the chrome-devtools-mcp N2 semantics, tab
// activation and window focus are different things, and whether Chrome
// also raises the window when a tab is activated is UNVERIFIED on Windows
// (see the note in src/browser/launch.js) — do not claim background mode
// is preserved until that is checked live.
export async function activateTab(cdp, targetId, { timeoutMs = 15000 } = {}) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new WfaError("CDP_REQUIRED", "A CDP client is required to activate a tab");
  }
  if (typeof targetId !== "string" || !targetId) {
    throw new WfaError("TARGET_ID_REQUIRED", "A targetId is required to activate a tab");
  }
  await cdp.send(
    "Target.activateTarget",
    { targetId },
    undefined,
    { timeoutMs },
  );
  return { targetId, activated: true };
}

export async function listPageTargets(cdp) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new WfaError("CDP_REQUIRED", "A CDP client is required to list page targets");
  }
  const result = await cdp.send("Target.getTargets", {});
  if (!Array.isArray(result?.targetInfos)) {
    throw new WfaError("TARGET_LIST_FAILED", "Target.getTargets did not return targetInfos");
  }
  return result.targetInfos.filter((target) =>
    target && target.type === "page" && typeof target.targetId === "string"
  );
}

export async function ensureAnchorTab(cdp) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new WfaError("CDP_REQUIRED", "A CDP client is required to ensure the anchor tab");
  }

  const browserKey = typeof cdp.wsUrl === "string" && cdp.wsUrl ? cdp.wsUrl : null;
  const ensure = async () => {
    const pageTargets = await listPageTargets(cdp);
    if (browserKey) {
      const knownTargetId = anchorTargetByBrowser.get(browserKey);
      if (knownTargetId && pageTargets.some((target) => target.targetId === knownTargetId)) {
        return { targetId: knownTargetId, created: false };
      }
      if (knownTargetId) anchorTargetByBrowser.delete(browserKey);
    }

    // An existing page is retained as the anchor; never navigate or activate it.
    // Only an empty page-target set causes creation of a new about:blank target.
    if (pageTargets.length > 0) {
      const targetId = pageTargets[0].targetId;
      if (browserKey) anchorTargetByBrowser.set(browserKey, targetId);
      return { targetId, created: false };
    }

    const created = await cdp.send(
      "Target.createTarget",
      { url: "about:blank", background: true },
      undefined,
      { timeoutMs: 15000 },
    );
    if (!created?.targetId) {
      throw new WfaError("ANCHOR_TARGET_CREATE_FAILED", "Target.createTarget did not return an anchor targetId");
    }
    if (browserKey) anchorTargetByBrowser.set(browserKey, created.targetId);
    return { targetId: created.targetId, created: true };
  };

  if (!browserKey) return ensure();
  const pending = anchorCreationByBrowser.get(browserKey);
  if (pending) return pending;

  const promise = ensure();
  anchorCreationByBrowser.set(browserKey, promise);
  try {
    return await promise;
  } finally {
    if (anchorCreationByBrowser.get(browserKey) === promise) {
      anchorCreationByBrowser.delete(browserKey);
    }
  }
}

export async function attachTab(cdp, targetId, { timeoutMs = 60000 } = {}) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new WfaError("CDP_REQUIRED", "A CDP client is required to attach a tab");
  }
  if (typeof targetId !== "string" || !targetId) {
    throw new WfaError("TARGET_ID_REQUIRED", "A targetId is required to attach a tab");
  }

  const attachResult = await cdp.send(
    "Target.attachToTarget",
    { targetId, flatten: true },
    undefined,
    { timeoutMs },
  );
  if (!attachResult?.sessionId) {
    throw new WfaError("ATTACH_FAILED", `Target.attachToTarget failed to return sessionId for ${targetId}`);
  }
  const { sessionId } = attachResult;

  await cdp.send("Page.enable", {}, sessionId);
  // Runtime.evaluate works without subscribing to the Runtime event domain.
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Tokyo" }, sessionId);
  return { targetId, sessionId };
}

export async function openTab(cdp, url, { timeoutMs = 60000 } = {}) {
  const targetResult = await cdp.send(
    "Target.createTarget",
    { url: "about:blank", background: true },
    undefined,
    { timeoutMs },
  );
  if (!targetResult?.targetId) {
    throw new WfaError("TARGET_CREATE_FAILED", "Target.createTarget failed to return a targetId");
  }
  const { targetId } = targetResult;

  const tab = await attachTab(cdp, targetId, { timeoutMs });
  if (url) {
    await cdp.send("Page.navigate", { url }, tab.sessionId);
  }
  return tab;
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
      url: typeof location !== "undefined" && typeof location.href === "string" ? location.href : "",
      hasPassword,
      bodyLength: bodyText.length,
      emptyBody: bodyText.length === 0,
    };
  })()`;

  let lastTitle = "";
  let lastUrl = "";
  let lastBodyLength = 0;
  let lastHasPassword = false;
  let consecutiveChallenged = 0;

  const challengePattern = challengePatternFor(adapter);
  // Neon hotfix alignment (D7): a Google /sorry redirect carries no
  // challenge title, so the title pattern alone never fires on it — the
  // URL is the signal. Same park, same HUMAN_VERIFICATION_REQUIRED error.
  const sorryUrlPattern = /\/sorry(?:\/|$|\?)/i;

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
        if (typeof val.url === "string") {
          lastUrl = val.url;
        }
        if (typeof val.bodyLength === "number") {
          lastBodyLength = val.bodyLength;
        }
        if (val.found) {
          return true;
        }

        const titleMatches = challengePattern.test(val.title || "");
        const urlMatches = sorryUrlPattern.test(val.url || "");
        const hasPassword = Boolean(val.hasPassword);

        lastHasPassword = hasPassword;

        const isPollChallenged = hasPassword || titleMatches || urlMatches;
        if (isPollChallenged) {
          consecutiveChallenged += 1;
          if (consecutiveChallenged >= 2) {
            // D7: park the challenged tab before reporting, so a retry
            // opens a fresh tab instead of inheriting the interstitial.
            const park = await parkChallengedTab(cdp, sessionId);
            const err = new WfaError(
              "HUMAN_VERIFICATION_REQUIRED",
              `Human verification required for ${adapter.id} (title: "${lastTitle}")`,
              { details: { title: lastTitle, adapter: adapter.id, challenge: true, bodyLength: lastBodyLength, parked: park.parked } }
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

  const isChallenge = Boolean(lastHasPassword || challengePattern.test(lastTitle) || sorryUrlPattern.test(lastUrl));

  if (isChallenge) {
    // D7: park the challenged tab before reporting, so a retry opens a
    // fresh tab instead of inheriting the interstitial.
    const park = await parkChallengedTab(cdp, sessionId);
    const err = new WfaError(
      "HUMAN_VERIFICATION_REQUIRED",
      `Human verification required for ${adapter.id} (title: "${lastTitle}")`,
      { details: { title: lastTitle, adapter: adapter.id, challenge: true, bodyLength: lastBodyLength, parked: park.parked } }
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

export async function waitForComposerReady(cdp, sessionId, adapter, {
  timeoutMs = 15000,
  pollIntervalMs = 200,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal,
} = {}) {
  const startTime = now();
  const expression = `(() => {
    const editor = document.querySelector(${JSON.stringify(adapter.editorSelector)});
    const tagName = String((editor && editor.tagName) || "").toLowerCase();
    const isFormControl = tagName === "textarea" || tagName === "input";
    const editorEditable = Boolean(editor && !editor.disabled && !editor.readOnly && (
      editor.isContentEditable || (typeof editor.getAttribute === "function" && editor.getAttribute("contenteditable") === "true") || isFormControl
    ));
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const editorVisible = isVisible(editor);
    const editorRaw = !editor
      ? null
      : (typeof editor.value === "string"
        ? editor.value
        : (typeof editor.innerText === "string"
          ? editor.innerText
          : (typeof editor.textContent === "string" ? editor.textContent : null)));
    const editorChars = typeof editorRaw === "string" ? editorRaw.trim().length : -1;
    const stopSelector = ${JSON.stringify(adapter.stopSelector || "")};
    const stopEls = stopSelector ? [...document.querySelectorAll(stopSelector)] : [];
    const stopActive = stopEls.some((el) =>
      Boolean(el) && !el.disabled && (typeof el.getAttribute !== "function" || el.getAttribute("aria-disabled") !== "true")
    );
    const ready = Boolean(editorEditable && editorVisible && !stopActive);
    return {
      ready,
      editorFound: Boolean(editor),
      editorEditable,
      editorVisible,
      editorChars,
      stopActive,
      stopMatched: stopActive,
    };
  })()`;

  let lastState = null;
  while (now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      const err = new Error("Operation cancelled");
      err.code = "CANCELLED";
      throw err;
    }
    try {
      const remainingBefore = timeoutMs - (now() - startTime);
      const res = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      }, sessionId, { timeoutMs: Math.max(1, remainingBefore) });
      const value = res?.result?.value;
      if (value && typeof value === "object") {
        lastState = value;
        if (value.ready === true) {
          if (now() - startTime < timeoutMs) {
            return { ...value, ok: true, status: "ready", elapsedMs: now() - startTime };
          }
          break;
        }
      }
    } catch (err) {
      if (err?.code === "CDP_CLOSED" || err?.code === "CANCELLED") throw err;
    }
    const remainingMs = timeoutMs - (now() - startTime);
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return {
    ...(lastState || {}),
    ok: false,
    status: "needs_human",
    reason: lastState?.stopActive ? "composer_stop_state" : "composer_not_ready_timeout",
    elapsedMs: now() - startTime,
  };
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

  // D3（2026-11-26，r3 排查）：setter 自身的成败在此之前是不可观测的——
  // DOM.setFileInputFiles 只在协议层报错时才抛错，成功返回不证明文件落进
  // 了 input；而 verify 轮询里读到的 input.files 是“setter 返回后最长
  // 7s 之后”的值，React 读走文件进 state 后会清空 input.files（见下文
  // 注释），所以失败诊断里的 inputFiles: [] 无法区分“setter 没落下”和
  // “React 已消费”。因此在 setter 刚返回时立即读一次 input.files，只作
  // 诊断记录，绝不参与成功判定（React 可能在毫秒内清空，空读数不是失败
  // 证据）。读数失败（求值异常 / 非数组）时记 null，不掩盖 verify 结果。
  let setterInputFiles = null;
  try {
    const inputSelector = adapter.fileInputSelector || 'input[type="file"]';
    const readRes = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const input = document.querySelector(${JSON.stringify(inputSelector)}); return input && input.files ? [...input.files].map((f) => f.name) : null; })()`,
      returnByValue: true,
    }, sessionId);
    const names = readRes?.result?.value;
    setterInputFiles = Array.isArray(names) ? names : null;
  } catch {}

  if (signal?.aborted) {
    const err = new Error("Operation cancelled");
    err.code = "CANCELLED";
    throw err;
  }

  // 4. 等待并验证附件 chip 出现（2026-11-24 真机证据）：
  // React 读文件进 state 后清空 input.files，chip 才是真实成功标志；
  // 它出现前就提交 prompt 会导致 "I don't see an attached file"。
  // input.files 仅作诊断，绝不参与成功判定。
  const diag = await verifyAttachments(cdp, sessionId, adapter, absolutePaths, {
    signal, sleep, now,
    timeoutMs: attachmentVerifyTimeoutMs,
    intervalMs: attachmentVerifyIntervalMs,
  });
  if (diag && !diag.present) {
    // D3（2026-11-26，r3 排查）：旧消息只带 inputFiles / chipCount，丢掉了
    // 恰好能区分失败原因的字段——matched（chip 里有无文件名）、chipTexts
    // （命中的 chip 是不是空壳）、sendReady（chip 对了但发送按钮未就绪）。
    // 真机 `chipCount=1, inputFiles=[]` 曾因此无法定位。失败诊断现在全量
    // 带出，成功判定不变（仍 fail-closed，不提交）。
    throw new WfaError(
      "ATTACH_UPLOAD_FAILED",
      `Attachment chip not visible within ${attachmentVerifyTimeoutMs}ms for ${adapter?.id || "unknown"}. ` +
        `diagnostics=${JSON.stringify({
          inputFiles: diag?.inputFiles ?? null,
          chipCount: diag?.chipCount ?? 0,
          matched: diag?.matched ?? null,
          chipTexts: diag?.chipTexts ?? null,
          sendReady: diag?.sendReady ?? null,
          setterInputFiles,
        })}`
    );
  }

  // 5. 不在此处重复 waitForEditor：调用方 engine 已在 openTab 后等待过 editor，
  // 这里再等一次在 mock/慢渲染下会额外卡 15s，且上传本身不改变 editor 可用性。

  return {
    attached: absolutePaths,
    provider: adapter?.id || "unknown",
    skipped: [],
  };
}

// D3（2026-11-26）：附件 chip 校验的单次评估 + 有界轮询，供 attachFiles
//（上传后校验）与 engine 提交前复核共用。adapter 没有
// buildAttachmentVerifyJs 时返回 null，调用方按“无法校验”处理，绝不伪造
// present。返回的 diag 与原内联实现同形（present / matched / chipCount /
// chipTexts / sendReady / inputFiles）。
export async function verifyAttachments(cdp, sessionId, adapter, filePaths = [], {
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = 2000,
  intervalMs = 200,
} = {}) {
  const verifyJs = typeof adapter?.buildAttachmentVerifyJs === "function"
    ? adapter.buildAttachmentVerifyJs(filePaths)
    : null;
  if (!verifyJs) return null;
  let diag = null;
  const deadline = now() + timeoutMs;
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
    await sleep(intervalMs);
  }
  return diag;
}

// D3 提交后确认（2026-11-26 真机复现）：prompt 发出后，在会话里按文件名
// 复核附件是否仍在——最新一条 user turn 必须包含每个文件名，且 userTurns
// 必须超过提交前基线（否则拿到的可能是旧 turn）。确认失败返回
// { confirmed: false, reason }，绝不抛错：prompt 已提交，调用方要的是
// 一条明确的失败记录，而不是一次异常。adapter 没有
// buildAttachmentPostSubmitVerifyJs 时返回 { confirmed: null, supported:
// false }，调用方跳过确认（不伪造通过）。timeoutMs 有界（默认 10s），
// 确认失败不进入 completion 轮询——CLI 绝不能在已提交的无附件 prompt 上
// 静默等满超时。
export async function confirmAttachmentsPostSubmit(cdp, sessionId, adapter, filePaths = [], {
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  baselineUserTurns = 0,
  timeoutMs = 10000,
  intervalMs = 500,
} = {}) {
  if (!filePaths || !filePaths.length) {
    return { confirmed: true, skipped: true, userTurns: null, matched: [] };
  }
  if (typeof adapter?.buildAttachmentPostSubmitVerifyJs !== "function") {
    return { confirmed: null, supported: false, userTurns: null, matched: [] };
  }
  const js = adapter.buildAttachmentPostSubmitVerifyJs(filePaths);
  let diag = null;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (signal?.aborted) {
      const err = new Error("Operation cancelled");
      err.code = "CANCELLED";
      throw err;
    }
    const res = await cdp.send("Runtime.evaluate", {
      expression: js,
      returnByValue: true,
    }, sessionId);
    diag = res?.result?.value || null;
    if (
      diag &&
      (diag.userTurns ?? 0) > baselineUserTurns &&
      Array.isArray(diag.matched) &&
      diag.matched.every(Boolean)
    ) {
      return {
        confirmed: true,
        userTurns: diag.userTurns,
        matched: diag.matched,
        fileNames: diag.fileNames ?? [],
      };
    }
    await sleep(intervalMs);
  }
  const rendered = (diag?.userTurns ?? 0) > baselineUserTurns;
  return {
    confirmed: false,
    reason: rendered ? "attachment_not_in_user_turn" : "user_turn_not_rendered",
    userTurns: diag?.userTurns ?? 0,
    baselineUserTurns,
    matched: diag?.matched ?? null,
    fileNames: diag?.fileNames ?? [],
  };
}

export async function submitTurn(cdp, sessionId, adapter, {
  sendButtonTimeoutMs = 2000,
  pollIntervalMs = 100,
  // F1 (2026-11-26, live REPORT-5b3e91ee.md): a dispatched .click() is not
  // proof the prompt was sent — in Gemini Task mode the click returned
  // clicked:true while the editor still held the prompt and no user turn
  // appeared, yet the old code returned success and the engine stamped
  // sendCommittedAt. After a click, poll the same ACK the completion wait
  // uses (editor emptied or a new user turn) for at most this long.
  submitAckTimeoutMs = 5000,
  submitAckPollIntervalMs = 200,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  // Post-submit ACK, via the adapter's page-state read when it has one.
  // Adapters without buildReadStateJs (e.g. test legacy adapters) cannot
  // be verified: submitTurn keeps the old return-on-dispatch behaviour
  // for them. A failed read is treated as "cannot verify", never as an
  // ACK and never as proof of a landing.
  const canVerifyAck = typeof adapter?.buildReadStateJs === "function";
  const readAckState = async () => {
    if (!canVerifyAck) return null;
    try {
      return await readTurnState(cdp, sessionId, adapter);
    } catch {
      return null;
    }
  };
  const isAcked = (state, baselineUserTurns) =>
    Boolean(state) &&
    (state.editorEmpty === true || (state.userTurns ?? 0) > baselineUserTurns);
  const waitForAck = async (baselineUserTurns) => {
    const deadline = now() + submitAckTimeoutMs;
    while (now() < deadline) {
      if (isAcked(await readAckState(), baselineUserTurns)) return true;
      await sleep(submitAckPollIntervalMs);
    }
    return false;
  };
  const dispatchEnter = async () => {
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
  };

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
        // Baseline for the post-click ACK: read before the click so a
        // pre-existing user turn cannot be mistaken for this send.
        const baseline = await readAckState();
        const baselineUserTurns = baseline?.userTurns ?? 0;
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
          // A dispatched click is not a landed send (see the header
          // comment): verify the ACK, and only then report success.
          // When the page state cannot be read at all, keep the old
          // return-on-dispatch behaviour rather than failing a send
          // that may have landed.
          if (!canVerifyAck || baseline == null) {
            return { submittedAt: now(), method: "click" };
          }
          if (await waitForAck(baselineUserTurns)) {
            return { submittedAt: now(), method: "click" };
          }
          // The click dispatched but the page shows no landing: the
          // editor still holds the prompt and no new user turn
          // appeared within the bound. That is positive evidence of a
          // no-op click under the completion wait's own ACK standard,
          // so — and only so — one Enter attempt is a new first
          // submit, not a retry. This never runs when the click
          // outcome itself was unknown (throw/empty/invalid result):
          // those paths throw SEND_UNCONFIRMED below with no Enter,
          // per the T4 invariant.
          await dispatchEnter();
          if (await waitForAck(baselineUserTurns)) {
            return { submittedAt: now(), method: "enter-fallback" };
          }
          throw new WfaError(
            "SEND_UNCONFIRMED",
            "Send button clicked but no user turn appeared and the editor still holds the prompt; Enter fallback also did not submit; automatic retry forbidden"
          );
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

  // Fallback path ONLY for adapters lacking sendSelector. Same ACK
  // verification as the click path when the adapter can report page
  // state; adapters that cannot are unchanged (return on dispatch).
  const enterBaseline = await readAckState();
  const enterBaselineUserTurns = enterBaseline?.userTurns ?? 0;
  await dispatchEnter();

  if (canVerifyAck && enterBaseline != null) {
    if (await waitForAck(enterBaselineUserTurns)) {
      return { submittedAt: now(), method: "enter" };
    }
    throw new WfaError(
      "SEND_UNCONFIRMED",
      "Enter dispatched but no user turn appeared and the editor still holds the prompt; automatic retry forbidden"
    );
  }

  return { submittedAt: now(), method: "enter" };
}

export async function readTurnState(cdp, sessionId, adapter, { targetId } = {}) {
  // D8: activate the tab before reading so a throttled/frozen background
  // tab does not hang or return stale state. Best-effort: a failed
  // activation must not fail the read — the evaluate below still reports
  // whatever the page shows. No activation happens when the caller does
  // not know the targetId.
  if (targetId) {
    try { await activateTab(cdp, targetId); } catch {}
  }

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
      pendingCount: 0,
      modelTextChars: 0,
      answerTextFull: "",
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
      // D7: no page state was read, so nothing was parked.
      // D5: no value came back from the page, so the read did not succeed —
      // the alive/dead classifier must see this as unresponsive, not as a
      // genuinely empty page.
      readOk: false,
      parked: false,
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

    const state = {
      userTurns: Number(parsed.userTurns) || 0,
      answerTurns: Number(parsed.answerTurns) || 0,
      answerText: typeof parsed.answerText === "string" ? parsed.answerText : "",
      answerActionsVisible: parsed.answerActionsVisible === null || parsed.answerActionsVisible === undefined
        ? null
        : Boolean(parsed.answerActionsVisible),
      pendingCount: Number.isInteger(parsed.pendingCount) ? parsed.pendingCount : 0,
      // D5 fix: page-level full-text signals from the Gemini adapter
      // (textContent-based; absent — e.g. older mocks or other providers —
      // means "no full-text signal", never a claim of text).
      modelTextChars: Number.isInteger(parsed.modelTextChars) ? parsed.modelTextChars : 0,
      answerTextFull: typeof parsed.answerTextFull === "string" ? parsed.answerTextFull : "",
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
      // D5: the evaluate returned a parseable page state, so the page
      // answered this read. The alive/dead classifier uses this to tell a
      // responsive-but-paused page from an unresponsive one.
      readOk: true,
      parked: false,
    };

    // D7: a challenged tab is parked on about:blank immediately, while the
    // state returned here is still the challenged one — so callers report
    // human_verification_required and a retry opens a fresh tab instead
    // of inheriting the interstitial. Detection is the adapter's own
    // (isChallengedState), not a second detector.
    if (isChallengedState(state, adapter)) {
      const park = await parkChallengedTab(cdp, sessionId);
      state.parked = park.parked;
    }
    return state;
  } catch {
    return {
      userTurns: 0,
      answerTurns: 0,
      answerText: "",
      answerActionsVisible: null,
      pendingCount: 0,
      modelTextChars: 0,
      answerTextFull: "",
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
      // D5: the page state could not be parsed, so the read did not succeed.
      readOk: false,
      parked: false,
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
  stallTimeoutMs = 420000,
  ackTimeoutMs = 30000,
  pollIntervalMs = 500,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal,
  // D8: targetId of the tab being read, when the caller knows it. The tab
  // is activated once before the first read so a throttled background tab
  // does not hang the wait. Callers that do not know the targetId omit it
  // and behaviour is unchanged.
  targetId = null,
  // D5 (coordinator wiring): pause tracker from stall-measurement.js.
  // Sampled once per poll; a throwing tracker must never break the wait.
  pauseTracker = null,
  // D5 fix: continued-wait budget for a paused-but-alive turn (see
  // src/stall-alive.js). Bounded by this AND by hardTimeoutMs. Not a CLI
  // flag: the default applies to every CDP turn; the hard timeout stays
  // the operator's control (--timeout).
  continuedWaitBudgetMs = DEFAULT_CONTINUED_WAIT_BUDGET_MS,
  // D5 fix: extra sink for stall decisions, in addition to the pause
  // tracker. Best-effort; a throwing sink must never break the wait.
  onStallDecision = null,
  // D5 fix (2026-11-26, REPORT-02360b8c run1): stale-pending completion.
  // A completed Gemini reply can sit unfinalised in a background tab with
  // pendingCount stuck > 0 and no stop button while the page already holds
  // the full answer. `stalePendingMs` is how long the pending count AND
  // the page-level full text must both stay frozen before that state
  // counts as completion; it defaults to the stall boundary
  // (stallTimeoutMs, 420 s — NOT raised as the fix). `stalePendingMinChars`
  // is the floor for "full answer text present": observed genuine thinking
  // pauses all stuck at 18-25 chars of emitted text, so a frozen full
  // text below this floor never completes through this path.
  stalePendingMs = stallTimeoutMs,
  stalePendingMinChars = 1000,
} = {}) {
  const startTime = now();
  let lastProgressAt = startTime;
  let lastActivityAt = startTime;
  let lastPendingCount = 0;
  let lastModelTextChars = 0;
  // D5 fix: when each in-flight signal last changed. A merely present
  // pendingCount is not activity (see the deleted refresh below); only a
  // change restarts these clocks.
  let pendingStableSince = startTime;
  let modelTextStableSince = startTime;
  let stalePendingConfirmDone = false;
  let hasAcked = false;
  let lastBelongsToCurrentTurn = false;
  let lastAnswerChars = 0;
  let lastAnswerText = "";
  let lastState = null;
  let stopVisibleSince = null;
  let unresolvedSince = null;
  // 三方裁决（2026-11-25 第七轮 3:0）：ChatGPT 的完成一律要求正面信号，
  // 停止按钮不参与完成判定（实测 0x0 且回答结束后长期不翻转）。
  const requiresActions = adapter.requiresCompletionActions === true;

  if (!Number.isFinite(stalePendingMs) || stalePendingMs <= 0) {
    throw new Error("INVALID_STALE_PENDING_MS");
  }
  if (!Number.isFinite(stalePendingMinChars) || stalePendingMinChars < 0) {
    throw new Error("INVALID_STALE_PENDING_MIN_CHARS");
  }

  // D5 fix: alive/dead stall policy. Decisions flow into the pause tracker
  // (recordDecision) so they land in the same opt-in pause-event log, and
  // to the caller's onStallDecision sink. Both are best-effort.
  const aliveStallPolicy = createAliveStallPolicy({
    stallTimeoutMs,
    continuedWaitBudgetMs,
    now,
    onDecision: (decision) => {
      try {
        pauseTracker?.recordDecision?.(decision);
      } catch {}
      try {
        onStallDecision?.(decision);
      } catch {}
    },
  });

  // D8: activate the tab once, before the first read — not on every poll,
  // so the window is not repeatedly disturbed while the turn runs.
  // Best-effort: a failed activation must not fail the completion wait;
  // the reads that follow still report whatever the page shows.
  if (targetId) {
    try { await activateTab(cdp, targetId); } catch {}
  }

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
        text: lastBelongsToCurrentTurn ? (lastState?.answerText || "") : "",
        elapsedMs,
        evidence: buildEvidence(lastState, now() - lastProgressAt),
      };
    }

    const state = await readTurnState(cdp, sessionId, adapter);
    lastState = state;

    // D5: one pause-tracker sample per poll (pending count, answer
    // length, answer turns). Best-effort: never breaks the wait.
    if (pauseTracker && typeof pauseTracker.sample === "function") {
      try {
        pauseTracker.sample({
          pendingCount: Number.isInteger(state.pendingCount) ? state.pendingCount : null,
          answerChars: typeof state.answerText === "string" ? state.answerText.length : null,
          answerTurns: Number.isInteger(state.answerTurns) ? state.answerTurns : null,
        });
      } catch {}
    }

    // 真机证据（2026-11-24）：续聊时 userTurns 已+1 但 answerTurns 未增，页面唯一文本是上一轮
    // 旧答案（smoke-actions2: answerTurns=1, 20575 字符旧答案却返回 completed）。
    // 本轮新答案判定：轮次增加，或（原地覆写时）文本相对基线发生变化。文本必须非空。
    // 三方 3:0（2026-11-25）：改为每轮采样即时重算，不用粘滞标志；轮次回退或归属不明时
    // 立即失去候选资格，终态分支不得回退到历史正文。
    const currentAnswerText = (state.answerText || "").trim();
    const baseText = String(baselineAnswerText || "").trim();
    const isNewTurn = state.answerTurns > baselineAnswerTurns;
    // 仅在显式提供基线文本时才用文本变化判定（覆盖原地覆写）；未提供时不可凭任意非空历史文本判新，
    // 否则会破坏 pre-ACK 的 rate-limit 快速失败等既有语义。
    const textChanged = baseText ? currentAnswerText !== baseText : false;
    const belongs = Boolean(currentAnswerText) && (isNewTurn || textChanged);
    lastBelongsToCurrentTurn = belongs;

    if (state.stopVisible) {
      if (stopVisibleSince === null) stopVisibleSince = now();
      unresolvedSince = null;
    } else {
      stopVisibleSince = null;
    }

    const challenged = isChallengedState(state, adapter);

    if (challenged) {
      // D7: readTurnState already parks a challenged tab; retry the park
      // once here only if that park did not succeed, so the challenged
      // page is not left in place for a retry to inherit.
      const parked = state.parked === true
        ? true
        : (await parkChallengedTab(cdp, sessionId)).parked;
      return {
        status: "needs_human",
        reason: "human_verification_required",
        text: belongs ? (state.answerText || "") : "",
        elapsedMs: now() - startTime,
        parked,
        evidence: { ...buildEvidence(state, now() - lastProgressAt), parked },
      };
    }

    // Tier 1 (pre-ACK): only fatal rate-limit fast-fails, to avoid 30s send_unconfirmed dead-wait
    if (state.pageError?.reason === "provider_rate_limited" && !belongs) {
      return {
        status: "needs_human",
        reason: "provider_rate_limited",
        text: belongs ? (state.answerText || "") : "",
        elapsedMs: now() - startTime,
        evidence: buildEvidence(state, now() - lastProgressAt),
      };
    }

    if (!hasAcked) {
      const ackConfirmed = (state.userTurns > baselineUserTurns) || (state.editorEmpty === true);
      if (ackConfirmed) {
        hasAcked = true;
        lastProgressAt = now();
        lastActivityAt = now();
        lastPendingCount = Number.isInteger(state.pendingCount) ? state.pendingCount : 0;
        lastAnswerText = state.answerText || "";
        lastAnswerChars = lastAnswerText.length;
        // D5 fix: ACK establishes the baselines for the stale-pending
        // clocks too — pre-ACK silence must not count as a frozen page.
        lastModelTextChars = Number.isInteger(state.modelTextChars) ? state.modelTextChars : 0;
        pendingStableSince = now();
        modelTextStableSince = now();
      } else {
        if (now() - startTime >= ackTimeoutMs) {
          return {
            status: "stalled",
        reason: "send_unconfirmed",
        text: belongs ? (state.answerText || "") : "",
            elapsedMs: now() - startTime,
            evidence: buildEvidence(state, now() - lastProgressAt),
          };
        }
        await sleep(pollIntervalMs);
        continue;
      }
    }

    // Tier 2 (post-ACK): all page errors, still protecting a current-turn answer
    if (state.pageError && !belongs) {
      return {
        status: "needs_human",
        reason: state.pageError.reason,
        text: belongs ? (state.answerText || "") : "",
        elapsedMs: now() - startTime,
        evidence: buildEvidence(state, now() - lastProgressAt),
      };
    }

    const currentText = state.answerText || "";
    const currentChars = currentText.length;
    const currentPendingCount = !requiresActions && Number.isInteger(state.pendingCount)
      ? state.pendingCount
      : 0;
    const currentModelTextChars = Number.isInteger(state.modelTextChars) ? state.modelTextChars : 0;
    const textProgressed = currentChars > lastAnswerChars || (currentText && currentText !== lastAnswerText);
    const pendingProgressed = !requiresActions && currentPendingCount > 0 && currentPendingCount !== lastPendingCount;
    // D5 fix: the page-level full text (textContent) growing is progress
    // too — during run1's early phase text streamed into pending spans
    // while the extractor's innerText stayed frozen at 43 chars. Any
    // change counts: growth, or a shrink from a replaced response.
    const modelTextProgressed = currentModelTextChars !== lastModelTextChars;
    const pendingChanged = currentPendingCount !== lastPendingCount;
    if (textProgressed || pendingProgressed || modelTextProgressed) {
      lastProgressAt = now();
      lastActivityAt = now();
      // D5 fix: progress ends the silence episode, so a later silence gets
      // a fresh continued-wait budget instead of reusing a spent one.
      aliveStallPolicy.noteProgress();
      if (textProgressed) {
        lastAnswerChars = currentChars;
        lastAnswerText = currentText;
      }
      unresolvedSince = null;
    }
    // D5 fix: the stability clocks restart only when the value actually
    // changes — a frozen count is not activity, however large it is.
    if (pendingChanged) pendingStableSince = now();
    if (modelTextProgressed) {
      modelTextStableSince = now();
      lastModelTextChars = currentModelTextChars;
    }
    lastPendingCount = currentPendingCount;

    const stopVisibleForMs = stopVisibleSince === null ? 0 : now() - stopVisibleSince;
    const stopGone = !state.stopVisible;
    const stopDegraded = state.stopVisible && stopVisibleForMs >= stopGraceMs;
    // D5 fix (2026-11-26, REPORT-02360b8c run1): the old refresh below
    // treated a merely present pendingCount as activity, so with pending
    // stuck at 666 `lastActivityAt` was refreshed on every poll and
    // `settled` could never become true — the turn sat "paused" for 13.8
    // min until the hard timeout even though nothing had changed. Removed:
    // activity now means a change (text, pending count, or page-level full
    // text — see the progress branch above). The stop button keeps its own
    // gate: `stopGateSatisfied` still requires it gone, or visible for
    // >= stopGraceMs. ChatGPT is unaffected: this block never ran when
    // requiresActions is true.

    const hasAnswer = currentAnswerText.length > 0;
    const settled = requiresActions
      ? (now() - lastProgressAt) >= settleMs
      : (now() - lastActivityAt) >= settleMs;
    // 若 adapter 提供回答完成标记（如 Gemini 的 message-actions / ChatGPT 的动作栏），
    // 它必须为 true 才算完成。对声明 requiresCompletionActions 的 provider，字段缺失
    // 一律视为"无正面信号"（不得当作 true，否则等于没有门禁）。
    // 真机证据（2026-11-24）：Gemini 长思考暂停时停止按钮会消失，仅靠 stopGone 会把
    // 只输出了 18 字符的回答判为完成，而完整回答（20575 字符）要几十秒后才继续生成。
    const actionsDone = isActionsDone(state, requiresActions);
    // 停止按钮只对未声明 requiresCompletionActions 的 provider 参与完成判定。
    // ChatGPT 实测（2026-11-25，三次 400ms 逐帧）：生成期该按钮 getBoundingClientRect 为 0x0；
    // 回答结束后 45 秒仍未翻回发送箭头。它既不能判完成，也不能做活动否决。
    const stopGateSatisfied = requiresActions ? true : (stopGone || stopDegraded);

    // D5 fix (2026-11-26, REPORT-02360b8c run1): stale-pending
    // completion. A page that proves completion is not a stall, so this
    // runs before the stall classification below. All of these must hold
    // for the whole stale window, and the candidate is confirmed with one
    // fresh read (which also re-activates the tab, D8 — a throttled
    // background tab can unfreeze its finalisation pass on activation)
    // before the turn completes:
    //   - no stop control (stopGone);
    //   - pendingCount frozen above zero (no streaming activity);
    //   - the full answer text present and frozen (modelTextChars, the
    //     textContent length of the last model-response, at or above
    //     stalePendingMinChars);
    //   - no positive completion signal yet (otherwise the normal
    //     completion below fires with reason "completed").
    // The returned text is the page-level full text (answerTextFull), not
    // the extractor's frozen innerText — run1 would otherwise "complete"
    // with 43 chars while the page holds 29,970.
    // Residual risk, recorded not hidden: a genuine long thinking pause
    // after a long partial answer, with the stop button already gone,
    // would also satisfy this after stalePendingMs of silence. The
    // observed genuine pauses all stuck at 18-25 chars of emitted text
    // (2026-11-25: pending 378, chars 18-25, then completed at 7,803),
    // i.e. below stalePendingMinChars, and the window defaults to the
    // 420 s stall boundary — but a pause past 420 s with a long partial
    // answer cannot be told apart from a completed-but-unfinalised one
    // from this data, so a completion through this path is labelled
    // `completed_stale_pending` with the counts in evidence.
    const stalePendingCandidate = !requiresActions
      && belongs && hasAnswer && stopGone && !actionsDone
      && currentPendingCount > 0
      && (now() - pendingStableSince) >= stalePendingMs
      && (now() - modelTextStableSince) >= stalePendingMs
      && currentModelTextChars >= stalePendingMinChars;
    if (stalePendingCandidate) {
      if (!stalePendingConfirmDone) {
        stalePendingConfirmDone = true;
        let confirmed = null;
        try {
          if (targetId) {
            try { await activateTab(cdp, targetId); } catch {}
          }
          confirmed = await readTurnState(cdp, sessionId, adapter, targetId ? { targetId } : {});
        } catch {}
        if (confirmed) {
          lastState = confirmed;
          const confirmText = (confirmed.answerText || "").trim();
          const confirmBelongs = Boolean(confirmText)
            && (confirmed.answerTurns > baselineAnswerTurns || (baseText ? confirmText !== baseText : false));
          const confirmModelTextChars = Number.isInteger(confirmed.modelTextChars) ? confirmed.modelTextChars : 0;
          const confirmPendingCount = !requiresActions && Number.isInteger(confirmed.pendingCount)
            ? confirmed.pendingCount
            : 0;
          const confirmActionsDone = isActionsDone(confirmed, requiresActions);
          if (confirmBelongs && !confirmed.stopVisible && !confirmActionsDone
              && confirmPendingCount > 0 && confirmPendingCount === currentPendingCount
              && confirmModelTextChars === currentModelTextChars
              && confirmModelTextChars >= stalePendingMinChars) {
            const fullText = (confirmed.answerTextFull || "").trim();
            return {
              status: "completed",
              reason: "completed_stale_pending",
              text: fullText || confirmed.answerText || "",
              elapsedMs: now() - startTime,
              evidence: {
                ...buildEvidence(confirmed, now() - lastProgressAt),
                stopVisibleForMs,
                stopSignalDegraded: stopDegraded,
                stalePending: true,
                answerTextFullUsed: fullText.length > 0,
                // The gap that diagnosed run1: extractor chars (43) vs the
                // full text present on the page (29,970), with pending stuck.
                modelTextChars: confirmModelTextChars,
                pendingCount: confirmPendingCount,
                pendingStableMs: now() - pendingStableSince,
                modelTextStableMs: now() - modelTextStableSince,
                ...(aliveStallPolicy.decisions().length
                  ? { stallDecisions: aliveStallPolicy.decisions() }
                  : {}),
              },
            };
          }
          // Confirm did not hold (or the fresh read showed progress or a
          // signal): keep polling on the current data. A later progress
          // resets the confirm flag via the candidate going false below.
        }
      }
    } else {
      stalePendingConfirmDone = false;
    }

    if (now() - lastProgressAt >= stallTimeoutMs) {
      if (!requiresActions) {
        // D5 fix: 420 s is a classification boundary, not a stall
        // declaration. A paused-but-alive turn (page responsive,
        // pendingCount > 0) keeps waiting under the continued-wait budget
        // and is re-classified on every poll; a dead turn is declared
        // stalled exactly as before. The decision is recorded in the pause
        // log via the policy's onDecision sink and in evidence below.
        // stopVisible is deliberately NOT an alive signal: Gemini's stop
        // button disappears during a long-thinking pause (see the completed
        // branch comment below), so only pendingCount counts as in-flight.
        const outcome = aliveStallPolicy.evaluate({
          silentMs: now() - lastProgressAt,
          pendingCount: Number.isInteger(state.pendingCount) ? state.pendingCount : 0,
          // A state object without readOk (e.g. older mocks) came from a
          // read that returned a value, so it counts as responsive.
          readOk: state.readOk !== false,
          completionSignal: state.answerActionsVisible === true,
          answerChars: currentChars,
          answerTurns: Number.isInteger(state.answerTurns) ? state.answerTurns : null,
        });
        if (outcome.action === "stalled") {
          return {
            status: "stalled",
            reason: "no_progress",
            text: belongs ? (state.answerText || "") : "",
            elapsedMs: now() - startTime,
            evidence: {
              ...buildEvidence(state, now() - lastProgressAt),
              stallDecision: outcome.decision,
            },
          };
        }
        // Alive: fall through to the completion checks below, then keep
        // polling until progress resumes, the page goes dead, the
        // continued-wait budget runs out, or hardTimeoutMs hits.
      } else if (belongs && hasAnswer && !actionsDone) {
        // ChatGPT（三方裁决 B@180，2026-11-25 3:0）：正文为空说明仍在思考，等到 hardTimeout；
        // 正文非空且已归属本轮、却连续 stallTimeoutMs 仍拿不到正面信号 → 缺信号退出（非成功）。
        // 绝不因超时把缺信号的正文标成 completed。
        return {
          status: "stalled",
          reason: "no_completion_signal",
          text: state.answerText || "",
          elapsedMs: now() - startTime,
          evidence: {
            ...buildEvidence(state, now() - lastProgressAt),
            completionSignalMissing: true,
          },
        };
      }
    }

    // 必须确认本轮产生了新答案，才允许 completed；否则旧答案会从各终态分支泄漏（裁决见 wfa-resume-bug-verdict.md）。
    if (belongs && hasAnswer && settled && stopGateSatisfied && actionsDone) {
      return {
        status: "completed",
        reason: !requiresActions && stopDegraded ? "completed_stop_signal_unreliable" : "completed",
        text: state.answerText,
        elapsedMs: now() - startTime,
        evidence: {
          ...buildEvidence(state, now() - lastProgressAt),
          stopVisibleForMs,
          stopSignalDegraded: stopDegraded,
          // D5 fix: a run that kept waiting past 420 s because it was
          // paused-but-alive records that here (and in the pause log),
          // so a later read can tell throttling from a freeze.
          ...(aliveStallPolicy.decisions().length
            ? { stallDecisions: aliveStallPolicy.decisions() }
            : {}),
        },
      };
    }

    // ChatGPT（三方 3:0）：无正面信号的空正文不得靠 settle+grace 判 MESSAGE_SELECTOR_UNRESOLVED，
    // 只有已取得本轮动作栏证据、正文仍提取不到时才走该分支。
    // D5 fix: the Gemini branch additionally requires pendingCount 0. The
    // old `settled` was false while pending nodes were reported (the
    // presence refresh kept lastActivityAt fresh), so a stuck-pending page
    // could never reach this branch; with that refresh removed, `settled`
    // alone no longer proves the provider finished — a pending count still
    // in flight means generation (or a stale-pending completion) is the
    // question, not an unresolved selector. The stall / stale-pending
    // paths above own the pending > 0 shape.
    const unresolvedCandidate = requiresActions
      ? (state.answerTurns > baselineAnswerTurns && actionsDone && settled && !hasAnswer)
      : (state.answerTurns > baselineAnswerTurns && stopGone && settled && !hasAnswer && currentPendingCount === 0);
    if (unresolvedCandidate) {
      if (unresolvedSince === null) {
        unresolvedSince = now();
      } else if (now() - unresolvedSince >= unresolvedGraceMs) {
        const confirm = await readTurnState(cdp, sessionId, adapter);
        lastState = confirm;
        const confirmHasAnswer = (confirm.answerText || "").trim().length > 0;
        const confirmStopGone = !confirm.stopVisible;
        const confirmActionsDone = isActionsDone(confirm, requiresActions);
        const confirmPendingCount = !requiresActions && Number.isInteger(confirm.pendingCount)
          ? confirm.pendingCount
          : 0;
        const confirmCandidate = requiresActions
          ? (confirm.answerTurns > baselineAnswerTurns && confirmActionsDone && confirmHasAnswer === false)
          : (confirm.answerTurns > baselineAnswerTurns && confirmStopGone && confirmHasAnswer === false && confirmPendingCount === 0);
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
