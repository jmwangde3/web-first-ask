
import { WfaError } from "../errors.js";

function buildEvidence(state, lastProgressAgoMs) {
  return {
    userTurns: state?.userTurns ?? 0,
    answerTurns: state?.answerTurns ?? 0,
    answerChars: (state?.answerText || "").length,
    stopVisible: Boolean(state?.stopVisible),
    editorEmpty: Boolean(state?.editorEmpty),
    title: state?.title ?? "",
    lastProgressAgoMs: Math.max(0, lastProgressAgoMs ?? 0),
  };
}

export async function openTab(cdp, url, { timeoutMs = 60000 } = {}) {
  const targetResult = await cdp.send("Target.createTarget", { url: "about:blank" }, undefined, {
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
} = {}) {
  const startTime = now();
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(adapter.editorSelector)});
    return {
      found: Boolean(el),
      title: document.title || "",
    };
  })()`;

  let lastTitle = "";
  while (now() - startTime < timeoutMs) {
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
        if (val.found) {
          return true;
        }
      }
    } catch (err) {
      if (err?.code === "CDP_CLOSED") throw err;
    }
    await sleep(pollIntervalMs);
  }

  const err = new WfaError(
    "EDITOR_NOT_FOUND",
    `Editor not found within ${timeoutMs}ms for ${adapter.id} (title: "${lastTitle}")`,
    { details: { title: lastTitle, adapter: adapter.id } }
  );
  err.title = lastTitle;
  throw err;
}

export async function typePrompt(cdp, sessionId, adapter, text) {
  if (typeof text !== "string" || text.length === 0) {
    const err = new WfaError("PROMPT_NOT_TYPED", "Prompt text is empty or invalid");
    throw err;
  }

  const focusExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(adapter.editorSelector)});
    if (!el) return false;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
  })()`;

  const focusRes = await cdp.send("Runtime.evaluate", {
    expression: focusExpr,
    returnByValue: true,
  }, sessionId);

  if (!focusRes?.result?.value) {
    const err = new WfaError("EDITOR_NOT_FOUND", `Editor element not found for ${adapter.id}`);
    throw err;
  }

  await cdp.send("Input.insertText", { text }, sessionId);

  return { typedChars: text.length };
}

export async function submitTurn(cdp, sessionId, adapter) {
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

  return { submittedAt: Date.now() };
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
      stopVisible: false,
      editorEmpty: false,
      title: "",
      hasChallenge: false,
    };
  }

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      userTurns: Number(parsed.userTurns) || 0,
      answerTurns: Number(parsed.answerTurns) || 0,
      answerText: typeof parsed.answerText === "string" ? parsed.answerText : "",
      stopVisible: Boolean(parsed.stopVisible),
      editorEmpty: Boolean(parsed.editorEmpty),
      title: typeof parsed.title === "string" ? parsed.title : "",
      hasChallenge: Boolean(parsed.hasChallenge),
    };
  } catch {
    return {
      userTurns: 0,
      answerTurns: 0,
      answerText: "",
      stopVisible: false,
      editorEmpty: false,
      title: "",
      hasChallenge: false,
    };
  }
}

export async function waitForCompletion(cdp, sessionId, adapter, {
  baselineAnswerTurns = 0,
  baselineUserTurns = 0,
  settleMs = 4000,
  stopGraceMs = 60000,
  hardTimeoutMs = 900000,
  stallTimeoutMs = 180000,
  ackTimeoutMs = 30000,
  pollIntervalMs = 500,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const startTime = now();
  let lastProgressAt = startTime;
  let hasAcked = false;
  let lastAnswerChars = 0;
  let lastAnswerText = "";
  let lastState = null;
  let stopVisibleSince = null;

  while (true) {
    const elapsedMs = now() - startTime;
    if (elapsedMs >= hardTimeoutMs) {
      return {
        status: "needs_human",
        reason: "hard_timeout",
        text: lastState?.answerText || "",
        elapsedMs,
        evidence: buildEvidence(lastState, now() - lastProgressAt),
      };
    }

    const state = await readTurnState(cdp, sessionId, adapter);
    lastState = state;

    if (state.stopVisible) {
      if (stopVisibleSince === null) stopVisibleSince = now();
    } else {
      stopVisibleSince = null;
    }

    if (
      state.hasChallenge ||
      /challenges\.cloudflare\.com|input\[type="password"\]/i.test(state.title) ||
      /cloudflare|just a moment|security check|challenges\.cloudflare\.com/i.test(state.title)
    ) {
      return {
        status: "needs_human",
        reason: "human_verification_required",
        text: state.answerText || "",
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
            text: state.answerText || "",
            elapsedMs: now() - startTime,
            evidence: buildEvidence(state, now() - lastProgressAt),
          };
        }
        await sleep(pollIntervalMs);
        continue;
      }
    }

    const currentText = state.answerText || "";
    const currentChars = currentText.length;
    if (currentChars > lastAnswerChars || (currentText && currentText !== lastAnswerText)) {
      lastProgressAt = now();
      lastAnswerChars = currentChars;
      lastAnswerText = currentText;
    }

    if (now() - lastProgressAt >= stallTimeoutMs) {
      return {
        status: "stalled",
        reason: "no_progress",
        text: state.answerText || "",
        elapsedMs: now() - startTime,
        evidence: buildEvidence(state, now() - lastProgressAt),
      };
    }

    const hasAnswer = (state.answerText || "").trim().length > 0;
    const settled = (now() - lastProgressAt) >= settleMs;
    const stopVisibleForMs = stopVisibleSince === null ? 0 : now() - stopVisibleSince;
    const stopGone = !state.stopVisible;
    const stopDegraded = state.stopVisible && stopVisibleForMs >= stopGraceMs;

    if (hasAnswer && settled && (stopGone || stopDegraded)) {
      return {
        status: "completed",
        reason: stopDegraded ? "completed_stop_signal_unreliable" : "completed",
        text: state.answerText,
        elapsedMs: now() - startTime,
        evidence: {
          ...buildEvidence(state, now() - lastProgressAt),
          stopVisibleForMs,
          stopSignalDegraded: stopDegraded,
        },
      };
    }

    if (state.answerTurns > baselineAnswerTurns && stopGone && settled && !hasAnswer) {
      return {
        status: "failed",
        reason: "MESSAGE_SELECTOR_UNRESOLVED",
        text: "",
        elapsedMs: now() - startTime,
        evidence: buildEvidence(state, now() - lastProgressAt),
      };
    }

    await sleep(pollIntervalMs);
  }
}

export function classifyRunError(error) {
  const code = error?.code || "UNKNOWN_ERROR";
  const message = error?.message || String(error);

  if (
    code === "HUMAN_VERIFICATION_REQUIRED" ||
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
