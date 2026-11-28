
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WfaError } from "../errors.js";
import {
  generateMousePath,
  getLastCursor,
  setLastCursor,
  humanTypeText,
  isHumanizeEnabled,
} from "./humanize.js";

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

const anchorTargetByBrowser = new Map();
const anchorCreationByBrowser = new Map();

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

export const DEFAULT_TARGET_TIMEZONE = "Asia/Tokyo";

export function getSystemTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : null;
  } catch {
    return null;
  }
}

export function pickHumanPoint(rect, random = Math.random) {
  const r1 = Math.max(0, Math.min(1, Number(random()) || 0));
  const r2 = Math.max(0, Math.min(1, Number(random()) || 0));
  const rx = 0.25 + r1 * 0.5;
  const ry = 0.25 + r2 * 0.5;
  return {
    x: Math.round((rect.left + rect.width * rx) * 100) / 100,
    y: Math.round((rect.top + rect.height * ry) * 100) / 100,
  };
}

export async function humanClickAt(cdp, sessionId, x, y, {
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  curved = isHumanizeEnabled(),
  from,
} = {}) {
  const hoverDelay = 40 + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 61);
  const pressDelay = 80 + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 61);
  if (curved) {
    const start = from || getLastCursor(sessionId, random);
    const points = generateMousePath(start, { x, y }, { random });
    for (const pt of points) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }, sessionId);
      if (pt.delayMs > 0) await sleep(pt.delayMs);
    }
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  }
  await sleep(hoverDelay);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
  await sleep(pressDelay);
  const driftX = curved ? Math.round((Math.max(0, Math.min(1, Number(random()) || 0)) - 0.5) * 200) / 100 : 0;
  const driftY = curved ? Math.round((Math.max(0, Math.min(1, Number(random()) || 0)) - 0.5) * 200) / 100 : 0;
  const relX = Math.round((x + driftX) * 100) / 100;
  const relY = Math.round((y + driftY) * 100) / 100;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: relX, y: relY, button: "left", clickCount: 1 }, sessionId);
  setLastCursor(sessionId, { x: relX, y: relY });
}

export async function evaluateInWorld(cdp, sessionId, expression, {
  awaitPromise = false,
  returnByValue = true,
  isolated = true,
} = {}) {
  if (isolated) {
    try {
      const tree = await cdp.send("Page.getFrameTree", {}, sessionId);
      const frameId = tree?.frameTree?.frame?.id;
      if (frameId) {
        const world = await cdp.send("Page.createIsolatedWorld", {
          frameId,
          worldName: "",
          grantUniveralAccess: true,
        }, sessionId);
        const contextId = world?.executionContextId;
        if (contextId != null) {
          return await cdp.send("Runtime.evaluate", {
            expression,
            contextId,
            awaitPromise,
            returnByValue,
          }, sessionId);
        }
      }
    } catch {
      // Fallback cleanly to default Runtime.evaluate when isolated world is unavailable.
    }
  }
  return await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue,
  }, sessionId);
}

export async function attachTab(cdp, targetId, {
  timeoutMs = 60000,
  targetTimezone = DEFAULT_TARGET_TIMEZONE,
  systemTimezone,
} = {}) {
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

  try {
    await cdp.send("Page.enable", {}, sessionId);
  } catch (err) {
    // D8: frozen/throttled background tab can stall CDP enable until activated once.
    const activated = await activateTarget(cdp, targetId);
    if (!activated) throw err;
    await cdp.send("Page.enable", {}, sessionId);
  }
  // Runtime.evaluate works without subscribing to the Runtime event domain.
  // Auto-detect host OS timezone: only override when it differs from targetTimezone (default Asia/Tokyo).
  const hostTz = systemTimezone !== undefined ? systemTimezone : getSystemTimezone();
  if (targetTimezone && hostTz !== targetTimezone) {
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: targetTimezone }, sessionId);
  }
  // D8: soft-enable focus emulation so background tabs stay composited without stealing focus.
  await enableFocusEmulation(cdp, sessionId);
  return { targetId, sessionId };
}

export async function enableFocusEmulation(cdp, sessionId) {
  if (!cdp || typeof cdp.send !== "function" || !sessionId) return false;
  try {
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    return true;
  } catch {
    return false;
  }
}

export async function activateTarget(cdp, targetId) {
  if (!cdp || typeof cdp.send !== "function" || !targetId) return false;
  try {
    await cdp.send("Target.activateTarget", { targetId });
    return true;
  } catch {
    return false;
  }
}

export async function parkChallengedTab(cdp, sessionId) {
  if (!cdp || typeof cdp.send !== "function" || !sessionId) return false;
  try {
    await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
    return true;
  } catch {
    return false;
  }
}

export async function configureDownloadBehavior(cdp, downloadDir, sessionId = undefined) {
  if (!cdp || typeof cdp.send !== "function" || !downloadDir) {
    return { configured: false, method: null };
  }
  const absDir = path.resolve(downloadDir);
  await mkdir(absDir, { recursive: true });
  try {
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: absDir,
      eventsEnabled: true,
    });
    return { configured: true, method: "Browser.setDownloadBehavior", downloadDir: absDir };
  } catch {
    try {
      await cdp.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: absDir,
      }, sessionId);
      return { configured: true, method: "Page.setDownloadBehavior", downloadDir: absDir };
    } catch {
      return { configured: false, method: null, downloadDir: absDir };
    }
  }
}

export async function snapshotDownloadDir(downloadDir) {
  if (!downloadDir) return new Set();
  try {
    const entries = await readdir(downloadDir);
    return new Set(entries);
  } catch {
    return new Set();
  }
}

export async function collectDownloads({ downloadDir, beforeFiles = new Set() } = {}) {
  if (!downloadDir) return null;
  let entries;
  try {
    entries = await readdir(downloadDir);
  } catch {
    return null;
  }
  const collected = [];
  for (const name of entries.sort()) {
    if (beforeFiles.has(name)) continue;
    if (name.endsWith(".crdownload") || name.endsWith(".tmp") || name.endsWith(".part")) continue;
    const fullPath = path.join(downloadDir, name);
    try {
      const info = await stat(fullPath);
      if (!info.isFile()) continue;
      const buf = await readFile(fullPath);
      const digest = createHash("sha256").update(buf).digest("hex");
      collected.push({
        name,
        path: fullPath,
        bytes: info.size,
        sha256: digest,
      });
    } catch {}
  }
  return collected.length > 0 ? collected : null;
}

export async function ensureProviderMode(cdp, sessionId, adapter, targetMode, {
  timeoutMs = 10000,
  pollIntervalMs = 250,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal,
} = {}) {
  if (!targetMode || typeof adapter?.buildEnsureModeJs !== "function") {
    return { ok: true, skipped: true };
  }
  const expression = adapter.buildEnsureModeJs(targetMode);
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    if (signal?.aborted) {
      const err = new Error("Operation cancelled");
      err.code = "CANCELLED";
      throw err;
    }
    const res = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    }, sessionId);
    const val = res?.result?.value || null;
    last = val;
    if (val?.ok && val?.active) {
      return val;
    }
    if (val?.reason === "mode_button_not_found") {
      // Allow brief SPA hydration before failing.
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new WfaError(
    "PROVIDER_MODE_SWITCH_FAILED",
    `Failed to switch ${adapter?.id || "provider"} to mode "${targetMode}" (${last?.reason || "timeout"})`,
    { details: { provider: adapter?.id || null, targetMode, last } },
  );
}

export async function openTab(cdp, url, { timeoutMs = 60000, targetTimezone = DEFAULT_TARGET_TIMEZONE, systemTimezone } = {}) {
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

  const tab = await attachTab(cdp, targetId, { timeoutMs, targetTimezone, systemTimezone });
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

  const challengePattern = adapter.turnChallengeTitlePattern || adapter.challengeTitlePattern || /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;
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
            const parked = await parkChallengedTab(cdp, sessionId);
            const err = new WfaError(
              "HUMAN_VERIFICATION_REQUIRED",
              `Human verification required for ${adapter.id} (title: "${lastTitle}")`,
              { details: { title: lastTitle, adapter: adapter.id, challenge: true, bodyLength: lastBodyLength, parked } }
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
    const parked = await parkChallengedTab(cdp, sessionId);
    const err = new WfaError(
      "HUMAN_VERIFICATION_REQUIRED",
      `Human verification required for ${adapter.id} (title: "${lastTitle}")`,
      { details: { title: lastTitle, adapter: adapter.id, challenge: true, bodyLength: lastBodyLength, parked } }
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
    const inspectStop = (el) => {
      if (!el) return null;
      const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      const visible = !rect || (rect.width > 0 && rect.height > 0);
      const disabled = Boolean(el.disabled);
      const ariaDisabled = typeof el.getAttribute === "function" ? el.getAttribute("aria-disabled") : null;
      const active = !disabled && ariaDisabled !== "true";
      return {
        tag: String(el.tagName || "").toLowerCase(),
        ariaLabel: typeof el.getAttribute === "function" ? (el.getAttribute("aria-label") || "") : "",
        disabled,
        ariaDisabled,
        visible,
        width: rect ? rect.width : null,
        height: rect ? rect.height : null,
        active,
        html: typeof el.outerHTML === "string" ? el.outerHTML.slice(0, 160) : "",
      };
    };
    const stopDiagnostics = stopEls.map(inspectStop).filter(Boolean);
    const stopActive = stopDiagnostics.some((d) => d.active);
    const ready = Boolean(editorEditable && editorVisible && !stopActive);
    return {
      ready,
      editorFound: Boolean(editor),
      editorEditable,
      editorVisible,
      editorChars,
      stopActive,
      stopMatched: stopActive,
      stopDiagnostics,
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
    await humanTypeText(cdp, sessionId, text);

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

  // Best-effort: if CDP setFileInputFiles populated input.files without triggering
  // framework onChange, dispatch bubbling input/change events and capture inputDesc.
  let postSetInfo = null;
  try {
    const postRes = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return { found: false };
        const count = input.files ? input.files.length : 0;
        let dispatched = false;
        if (count > 0 && typeof input.dispatchEvent === "function") {
          try {
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            dispatched = true;
          } catch {}
        }
        return {
          found: true,
          filesAfterSet: count,
          changeDispatched: dispatched,
          inputDesc: {
            ariaLabel: typeof input.getAttribute === "function" ? input.getAttribute("aria-label") : null,
            accept: typeof input.getAttribute === "function" ? input.getAttribute("accept") : null,
            multiple: Boolean(input.multiple),
            id: input.id || null,
            inForm: Boolean(typeof input.closest === "function" && input.closest("form")),
          },
        };
      })()`,
      returnByValue: true,
    }, sessionId);
    postSetInfo = postRes?.result?.value || null;
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
  const verifyJs = typeof adapter.buildAttachmentVerifyJs === "function"
    ? adapter.buildAttachmentVerifyJs(absolutePaths)
    : null;
  if (verifyJs) {
    let diag = null;
    let verifyPolls = 0;
    const deadline = now() + attachmentVerifyTimeoutMs;
    while (now() < deadline) {
      if (signal?.aborted) {
        const err = new Error("Operation cancelled");
        err.code = "CANCELLED";
        throw err;
      }
      verifyPolls += 1;
      const res = await cdp.send("Runtime.evaluate", {
        expression: verifyJs,
        returnByValue: true,
      }, sessionId);
      diag = res?.result?.value || null;
      if (diag?.present) break;
      await sleep(attachmentVerifyIntervalMs);
    }
    if (!diag?.present) {
      const diagnostics = {
        provider: adapter?.id || "unknown",
        expectedFiles: absolutePaths.map((fp) => path.basename(fp)),
        verifyPolls,
        inputFiles: diag?.inputFiles ?? null,
        inputDesc: diag?.inputDesc ?? postSetInfo?.inputDesc ?? null,
        changeDispatched: postSetInfo?.changeDispatched ?? null,
        chipCount: diag?.chipCount ?? 0,
        chipTexts: diag?.chipTexts ?? [],
        matched: diag?.matched ?? [],
        sendReady: diag?.sendReady ?? null,
      };
      throw new WfaError(
        "ATTACH_UPLOAD_FAILED",
        `Attachment chip not visible within ${attachmentVerifyTimeoutMs}ms for ${adapter?.id || "unknown"}. ` +
          `diagnostics=${JSON.stringify(diagnostics)}`,
        { details: diagnostics },
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

      const probeRes = await evaluateInWorld(cdp, sessionId, probeExpr, {
        returnByValue: true,
      }).catch(() => null);

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
            if (typeof btn.scrollIntoView === "function") {
              try { btn.scrollIntoView({ block: "center", inline: "center" }); } catch {}
            }
            if (typeof btn.getBoundingClientRect === "function") {
              const r = btn.getBoundingClientRect();
              if (r && r.width > 0 && r.height > 0) {
                return { readyToClick: true, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
              }
            }
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
          clickRes = await evaluateInWorld(cdp, sessionId, clickExpr, {
            returnByValue: true,
          });
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
        if (outcome?.readyToClick === true && outcome?.rect) {
          const pt = pickHumanPoint(outcome.rect);
          try {
            await humanClickAt(cdp, sessionId, pt.x, pt.y, { sleep });
          } catch (cause) {
            const err = new WfaError("SEND_UNCONFIRMED", "CDP mouse click outcome unknown; automatic retry forbidden");
            err.cause = cause;
            throw err;
          }
          return { submittedAt: now(), method: "click" };
        }
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
      pendingCount: 0,
      collapsed: false,
      stopVisible: false,
      editorEmpty: false,
      title: "",
      url: "",
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
      pendingCount: Number.isInteger(parsed.pendingCount) ? parsed.pendingCount : 0,
      collapsed: Boolean(parsed.collapsed),
      stopVisible: Boolean(parsed.stopVisible),
      editorEmpty: parsed.editorEmpty !== null && parsed.editorEmpty !== undefined ? Boolean(parsed.editorEmpty) : null,
      title: typeof parsed.title === "string" ? parsed.title : "",
      url: typeof parsed.url === "string" ? parsed.url : "",
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
      pendingCount: 0,
      collapsed: false,
      stopVisible: false,
      editorEmpty: null,
      title: "",
      url: "",
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
  baselineUrl = "",
  settleMs = 4000,
  unresolvedGraceMs = 6000,
  stopGraceMs = 60000,
  stalePendingMs = 60000,
  hardTimeoutMs = 900000,
  stallTimeoutMs = 420000,
  ackTimeoutMs = 30000,
  pollIntervalMs = 500,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal,
} = {}) {
  const startTime = now();
  let lastProgressAt = startTime;
  let lastActivityAt = startTime;
  let lastPendingCount = 0;
  let lastPendingChangedAt = startTime;
  let sawStopVisible = false;
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
        text: lastBelongsToCurrentTurn ? (lastState?.answerText || "") : "",
        elapsedMs,
        evidence: buildEvidence(lastState, now() - lastProgressAt),
      };
    }

    const state = await readTurnState(cdp, sessionId, adapter);
    lastState = state;

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
      sawStopVisible = true;
      if (stopVisibleSince === null) stopVisibleSince = now();
      unresolvedSince = null;
    } else {
      stopVisibleSince = null;
    }

    const composerReady = (state.editorEmpty !== null && state.editorEmpty !== undefined) || Boolean(state.hasProseMirror);
    const challenged = (state.hasChallenge || challengePattern.test(state.title || "")) && !composerReady;

    if (challenged) {
      const parked = await parkChallengedTab(cdp, sessionId);
      return {
        status: "needs_human",
        reason: "human_verification_required",
        text: belongs ? (state.answerText || "") : "",
        elapsedMs: now() - startTime,
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
      const urlAdvanced = Boolean(baselineUrl && state.url && state.url !== baselineUrl);
      const ackConfirmed =
        (state.userTurns > baselineUserTurns) ||
        (state.editorEmpty === true) ||
        (state.answerTurns > baselineAnswerTurns) ||
        Boolean(state.stopVisible) ||
        urlAdvanced;
      if (ackConfirmed) {
        hasAcked = true;
        lastProgressAt = now();
        lastActivityAt = now();
        lastPendingCount = Number.isInteger(state.pendingCount) ? state.pendingCount : 0;
        lastPendingChangedAt = now();
        lastAnswerText = state.answerText || "";
        lastAnswerChars = lastAnswerText.length;
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
    const rawPendingCount = !requiresActions && Number.isInteger(state.pendingCount)
      ? state.pendingCount
      : 0;
    if (rawPendingCount !== lastPendingCount) {
      lastPendingChangedAt = now();
    }
    const collapsedPendingFrozen = Boolean(state.collapsed) && !state.stopVisible && currentAnswerText.length > 0;
    const stalePendingFallback =
      !requiresActions &&
      rawPendingCount > 0 &&
      !state.stopVisible &&
      belongs &&
      currentAnswerText.length > 0 &&
      state.answerActionsVisible === true &&
      (now() - lastPendingChangedAt) >= stalePendingMs;
    const currentPendingCount = (collapsedPendingFrozen || stalePendingFallback) ? 0 : rawPendingCount;
    const textProgressed = currentChars > lastAnswerChars || (currentText && currentText !== lastAnswerText);
    const pendingProgressed = !requiresActions && currentPendingCount > 0 && currentPendingCount !== lastPendingCount;
    if (textProgressed || pendingProgressed) {
      lastProgressAt = now();
      lastActivityAt = now();
      if (textProgressed) {
        lastAnswerChars = currentChars;
        lastAnswerText = currentText;
      }
      unresolvedSince = null;
    }
    lastPendingCount = rawPendingCount;

    const stopVisibleForMs = stopVisibleSince === null ? 0 : now() - stopVisibleSince;
    const stopGone = !state.stopVisible;
    const stopDegraded = state.stopVisible && stopVisibleForMs >= stopGraceMs;
    if (!requiresActions && (currentPendingCount > 0 || (state.stopVisible && !stopDegraded))) {
      lastActivityAt = now();
    }

    const hasAnswer = currentAnswerText.length > 0;
    const settled = requiresActions
      ? (now() - lastProgressAt) >= settleMs
      : (now() - lastActivityAt) >= settleMs;
    // 若 adapter 提供回答完成标记（如 Gemini 的 message-actions / ChatGPT 的动作栏），
    // 它必须为 true 才算完成。对声明 requiresCompletionActions 的 provider，字段缺失
    // 一律视为"无正面信号"（不得当作 true，否则等于没有门禁）。
    // 真机证据（2026-11-24）：Gemini 长思考暂停时停止按钮会消失，仅靠 stopGone 会把
    // 只输出了 18 字符的回答判为完成，而完整回答（20575 字符）要几十秒后才继续生成。
    const actionsDone = requiresActions
      ? state.answerActionsVisible === true
      : (state.answerActionsVisible === null || state.answerActionsVisible === undefined
        ? true
        : state.answerActionsVisible === true);
    // 停止按钮只对未声明 requiresCompletionActions 的 provider 参与完成判定。
    // ChatGPT 实测（2026-11-25，三次 400ms 逐帧）：生成期该按钮 getBoundingClientRect 为 0x0；
    // 回答结束后 45 秒仍未翻回发送箭头。它既不能判完成，也不能做活动否决。
    const stopGateSatisfied = requiresActions ? true : (stopGone || stopDegraded);

    if (now() - lastProgressAt >= stallTimeoutMs) {
      if (!requiresActions) {
        return {
          status: "stalled",
          reason: "no_progress",
          text: belongs ? (state.answerText || "") : "",
          elapsedMs: now() - startTime,
          evidence: buildEvidence(state, now() - lastProgressAt),
        };
      }
      // ChatGPT（三方裁决 B@180，2026-11-25 3:0）：正文为空说明仍在思考，等到 hardTimeout；
      // 正文非空且已归属本轮、却连续 stallTimeoutMs 仍拿不到正面信号 → 缺信号退出（非成功）。
      // 绝不因超时把缺信号的正文标成 completed。
      if (belongs && hasAnswer && !actionsDone) {
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
    const effectiveActionsDone = actionsDone || stalePendingFallback;
    if (belongs && hasAnswer && settled && stopGateSatisfied && effectiveActionsDone) {
      return {
        status: "completed",
        reason: stalePendingFallback
          ? "completed_stale_pending_fallback"
          : (!requiresActions && stopDegraded ? "completed_stop_signal_unreliable" : "completed"),
        text: state.answerText,
        elapsedMs: now() - startTime,
        evidence: {
          ...buildEvidence(state, now() - lastProgressAt),
          stopVisibleForMs,
          stopSignalDegraded: stopDegraded,
          ...(stalePendingFallback ? { stalePendingFallback: true } : {}),
        },
      };
    }

    // ChatGPT（三方 3:0）：无正面信号的空正文不得靠 settle+grace 判 MESSAGE_SELECTOR_UNRESOLVED，
    // 只有已取得本轮动作栏证据、正文仍提取不到时才走该分支。
    const unresolvedCandidate = requiresActions
      ? (state.answerTurns > baselineAnswerTurns && actionsDone && settled && !hasAnswer)
      : (state.answerTurns > baselineAnswerTurns && stopGone && settled && !hasAnswer);
    if (unresolvedCandidate) {
      if (unresolvedSince === null) {
        unresolvedSince = now();
      } else if (now() - unresolvedSince >= unresolvedGraceMs) {
        const confirm = await readTurnState(cdp, sessionId, adapter);
        lastState = confirm;
        const confirmHasAnswer = (confirm.answerText || "").trim().length > 0;
        const confirmStopGone = !confirm.stopVisible;
        const confirmActionsDone = requiresActions
          ? confirm.answerActionsVisible === true
          : (confirm.answerActionsVisible === null || confirm.answerActionsVisible === undefined
            ? true
            : confirm.answerActionsVisible === true);
        const confirmCandidate = requiresActions
          ? (confirm.answerTurns > baselineAnswerTurns && confirmActionsDone && confirmHasAnswer === false)
          : (confirm.answerTurns > baselineAnswerTurns && confirmStopGone && confirmHasAnswer === false);
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
