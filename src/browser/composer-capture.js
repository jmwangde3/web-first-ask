// D6 — composer stop-state capture (backlog item D6).
//
// After an answer finishes, the composer can stay in a stop-state for up to
// ~45 s; a continuation sent in that window is rejected with
// PROMPT_NOT_TYPED / composer_stop_state. The long stop-state did not
// reproduce on 2026-11-26, so the cause is still unknown and NO gate logic
// is changed here. This module only captures evidence from a real occurrence.
//
// Design: a standalone capture helper that takes a CDP evaluate function —
// it does NOT touch driver.js internals. The coordinator wires it into the
// continuation path (where `waitForComposerReady` returns
// `reason: "composer_stop_state"`, or where `typePrompt` throws
// PROMPT_NOT_TYPED): call `captureComposerState(evaluate, adapter, ...)`
// with `evaluate` being the caller's Runtime.evaluate wrapper, i.e. an
// async function taking a JS expression string and returning either the CDP
// response (`{ result: { value } }`) or the already-unwrapped value.
//
// What a capture holds (bounded size, no prompt/response content):
// - gate state: editorEditable / editorVisible / stopActive (booleans),
//   editorChars (length only — never editor text);
// - one descriptor per matched stop control (max 10): tag, aria-label,
//   title, disabled, aria-disabled, class (truncated), id, visibility,
//   bounding rect, and outerHTML truncated to 2000 chars;
// - timestamps: capture time plus, via `createStopStateSampler`, how long
//   the stop-state persists across sampled polls.
//
// Nothing here resends, retries, or relaxes the composer gate.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const COMPOSER_CAPTURE_LIMITS = Object.freeze({
  maxStopControls: 10,
  maxOuterHtmlChars: 2000,
  maxAttrChars: 200,
  maxClassChars: 200,
});

function truncate(value, max) {
  if (typeof value !== "string") return value ?? null;
  return value.length > max ? value.slice(0, max) : value;
}

// Page-side expression: dumps the stop control DOM and composer state.
// Editor text is never read — only its character length. Stop-control
// outerHTML is truncated in-page so a huge DOM cannot blow up the capture.
export function buildComposerCaptureJs(adapter) {
  const editorSelector = adapter?.editorSelector ?? "";
  const stopSelector = adapter?.stopSelector ?? "";
  return `(() => {
  const MAX_HTML = ${COMPOSER_CAPTURE_LIMITS.maxOuterHtmlChars};
  const MAX_ATTR = ${COMPOSER_CAPTURE_LIMITS.maxAttrChars};
  const MAX_CONTROLS = ${COMPOSER_CAPTURE_LIMITS.maxStopControls};
  const trunc = (v, n) => (typeof v === "string" && v.length > n ? v.slice(0, n) : (v ?? null));
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };
  const editor = document.querySelector(${JSON.stringify(editorSelector)});
  const tagName = String((editor && editor.tagName) || "").toLowerCase();
  const isFormControl = tagName === "textarea" || tagName === "input";
  const editorEditable = Boolean(editor && !editor.disabled && !editor.readOnly && (
    editor.isContentEditable || (typeof editor.getAttribute === "function" && editor.getAttribute("contenteditable") === "true") || isFormControl
  ));
  const editorVisible = isVisible(editor);
  const editorRaw = !editor
    ? null
    : (typeof editor.value === "string"
      ? editor.value
      : (typeof editor.innerText === "string"
        ? editor.innerText
        : (typeof editor.textContent === "string" ? editor.textContent : null)));
  const editorChars = typeof editorRaw === "string" ? editorRaw.trim().length : -1;
  const stopEls = ${JSON.stringify(stopSelector)}
    ? [...document.querySelectorAll(${JSON.stringify(stopSelector)})].slice(0, MAX_CONTROLS)
    : [];
  const stopControls = stopEls.map((el, index) => {
    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    return {
      index,
      tagName: String((el.tagName || "").toLowerCase()),
      ariaLabel: trunc(typeof el.getAttribute === "function" ? el.getAttribute("aria-label") : null, MAX_ATTR),
      title: trunc(typeof el.getAttribute === "function" ? el.getAttribute("title") : null, MAX_ATTR),
      disabled: Boolean(el.disabled),
      ariaDisabled: trunc(typeof el.getAttribute === "function" ? el.getAttribute("aria-disabled") : null, MAX_ATTR),
      className: trunc(typeof el.className === "string" ? el.className : null, MAX_ATTR),
      id: trunc(typeof el.id === "string" ? el.id : null, MAX_ATTR),
      visible: isVisible(el),
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      outerHtml: trunc(typeof el.outerHTML === "string" ? el.outerHTML : null, MAX_HTML),
    };
  });
  const stopActive = stopControls.some((c) => c.visible && !c.disabled && c.ariaDisabled !== "true");
  return {
    capturedAtPageMs: Date.now(),
    pageUrl: location.href,
    pageTitle: document.title || "",
    editorFound: Boolean(editor),
    editorEditable,
    editorVisible,
    editorChars,
    stopActive,
    stopMatched: stopControls.length,
    stopControls,
  };
})()`;
}

export function unwrapEvaluateValue(raw) {
  if (raw && typeof raw === "object" && raw.result && typeof raw.result === "object"
    && "value" in raw.result) {
    return raw.result.value;
  }
  return raw;
}

function normalizeStopControl(control, index) {
  if (!control || typeof control !== "object") return null;
  return {
    index: Number.isInteger(control.index) ? control.index : index,
    tagName: typeof control.tagName === "string" ? control.tagName : "",
    ariaLabel: truncate(control.ariaLabel, COMPOSER_CAPTURE_LIMITS.maxAttrChars),
    title: truncate(control.title, COMPOSER_CAPTURE_LIMITS.maxAttrChars),
    disabled: Boolean(control.disabled),
    ariaDisabled: truncate(control.ariaDisabled, COMPOSER_CAPTURE_LIMITS.maxAttrChars),
    className: truncate(control.className, COMPOSER_CAPTURE_LIMITS.maxClassChars),
    id: truncate(control.id, COMPOSER_CAPTURE_LIMITS.maxAttrChars),
    visible: Boolean(control.visible),
    rect: control.rect && typeof control.rect === "object"
      ? {
          x: Number(control.rect.x) || 0,
          y: Number(control.rect.y) || 0,
          width: Number(control.rect.width) || 0,
          height: Number(control.rect.height) || 0,
        }
      : null,
    outerHtml: truncate(control.outerHtml, COMPOSER_CAPTURE_LIMITS.maxOuterHtmlChars),
  };
}

// Normalises a raw page value into a bounded capture record. Only lengths
// and attributes are kept; any text field the page value might carry is
// dropped here, so a capture can never smuggle prompt/response content into
// the run record.
export function normalizeComposerCapture(raw, {
  now = () => Date.now(),
  provider = null,
  taskId = null,
  reason = null,
} = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const controls = Array.isArray(value.stopControls) ? value.stopControls : [];
  const stopControls = controls
    .slice(0, COMPOSER_CAPTURE_LIMITS.maxStopControls)
    .map((control, index) => normalizeStopControl(control, index))
    .filter(Boolean);
  const stopActive = typeof value.stopActive === "boolean"
    ? value.stopActive
    : stopControls.some((c) => c.visible && !c.disabled && c.ariaDisabled !== "true");
  return {
    schema: 1,
    kind: "composer_capture",
    capturedAt: new Date(now()).toISOString(),
    capturedAtPageMs: Number.isFinite(value.capturedAtPageMs) ? value.capturedAtPageMs : null,
    provider,
    taskId,
    reason,
    pageUrl: typeof value.pageUrl === "string" ? value.pageUrl : null,
    pageTitle: typeof value.pageTitle === "string" ? value.pageTitle : "",
    gate: {
      editorFound: Boolean(value.editorFound),
      editorEditable: Boolean(value.editorEditable),
      editorVisible: Boolean(value.editorVisible),
      editorChars: Number.isInteger(value.editorChars) ? value.editorChars : -1,
      stopActive,
      stopMatched: Number.isInteger(value.stopMatched) ? value.stopMatched : controls.length,
    },
    stopControls,
  };
}

export async function captureComposerState(evaluate, adapter, options = {}) {
  if (typeof evaluate !== "function") {
    throw new Error("COMPOSER_CAPTURE_EVALUATE_REQUIRED");
  }
  const raw = await evaluate(buildComposerCaptureJs(adapter));
  return normalizeComposerCapture(unwrapEvaluateValue(raw), options);
}

// Samples the stop-state over time (one sample per composer-gate poll) and
// records how long the stop-state persists. Pure clock-injected logic; no
// DOM access — feed it the `gate.stopActive` values from captures or from
// `waitForComposerReady` polls.
export function createStopStateSampler({ now = () => Date.now() } = {}) {
  const events = [];
  let samples = 0;
  let currentlyStopped = false;
  let stopSince = null;
  let totalStopMs = 0;
  let longestStopMs = 0;
  let transitions = 0;

  // Returns a transition event when the stop-state flips, else null.
  function sample({ stopActive, editorEditable = null, editorVisible = null } = {}) {
    const at = now();
    samples += 1;
    const active = Boolean(stopActive);
    let emitted = null;
    if (active && !currentlyStopped) {
      currentlyStopped = true;
      stopSince = at;
      transitions += 1;
      emitted = { type: "stop_state_started", at: new Date(at).toISOString(), atMs: at };
      events.push(emitted);
    } else if (!active && currentlyStopped) {
      const durationMs = at - stopSince;
      totalStopMs += durationMs;
      longestStopMs = Math.max(longestStopMs, durationMs);
      currentlyStopped = false;
      stopSince = null;
      transitions += 1;
      emitted = {
        type: "stop_state_ended", at: new Date(at).toISOString(), atMs: at, durationMs,
        editorEditable, editorVisible,
      };
      events.push(emitted);
    }
    return emitted;
  }

  function summary() {
    const at = now();
    return {
      samples,
      transitions,
      stopActiveMs: totalStopMs,
      longestStopMs,
      currentlyStopped,
      currentStopMs: currentlyStopped ? at - stopSince : null,
    };
  }

  return { sample, summary, events: () => [...events] };
}

// Offline summary over timestamped samples: [{ at, stopActive }], where `at`
// is epoch ms or an ISO string. State is assumed to persist until the next
// sample; a trailing open interval is reported separately as openTailMs
// (unknown end, excluded from longestStopMs).
export function summarizeStopPersistence(samples) {
  const list = (Array.isArray(samples) ? samples : [])
    .map((s) => ({
      atMs: typeof s?.at === "number" ? s.at : Date.parse(s?.at ?? ""),
      stopActive: Boolean(s?.stopActive),
    }))
    .filter((s) => Number.isFinite(s.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  let totalStopMs = 0;
  let longestStopMs = 0;
  let openTail = false;
  let stopIntervals = 0;
  for (let i = 0; i < list.length; i++) {
    const current = list[i];
    const next = list[i + 1];
    if (!current.stopActive) continue;
    if (!next) {
      // Trailing sample: the interval has no end timestamp, so its
      // duration is unknown — reported as an open tail, not counted.
      openTail = true;
      continue;
    }
    const duration = next.atMs - current.atMs;
    if (duration < 0) continue;
    totalStopMs += duration;
    longestStopMs = Math.max(longestStopMs, duration);
    stopIntervals += 1;
  }
  return {
    samples: list.length,
    stopIntervals,
    totalStopMs,
    longestStopMs,
    openTail,
    firstAt: list.length ? new Date(list[0].atMs).toISOString() : null,
    lastAt: list.length ? new Date(list[list.length - 1].atMs).toISOString() : null,
  };
}

export async function appendComposerCapture(filePath, capture) {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("INVALID_COMPOSER_CAPTURE_PATH");
  }
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(capture)}\n`, "utf8");
}

export function formatComposerCapture(capture) {
  const gate = capture?.gate ?? {};
  const controls = capture?.stopControls ?? [];
  const visible = controls.filter((c) => c.visible).map((c) =>
    `${c.tagName}[aria-label=${JSON.stringify(c.ariaLabel ?? "")}]`).join(", ");
  return [
    `composer capture ${capture?.capturedAt ?? "unknown time"} provider=${capture?.provider ?? "?"} reason=${capture?.reason ?? "?"}`,
    `gate: editorFound=${gate.editorFound} editable=${gate.editorEditable} visible=${gate.editorVisible} editorChars=${gate.editorChars} stopActive=${gate.stopActive} stopMatched=${gate.stopMatched}`,
    `stop controls (${controls.length}): ${visible || "none visible"}`,
  ].join("\n");
}
