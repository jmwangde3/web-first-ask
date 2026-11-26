import { getHomeDir } from "../paths.js";
import { WfaError } from "../errors.js";
import { recoverBrowser as defaultRecoverBrowser } from "../browser/recovery.js";
import { connectCdp as defaultConnectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import * as claudeAdapter from "../browser/adapters/claude.js";
import * as defaultResultStore from "../broker/result-store.js";
import * as defaultTurnStore from "../broker/turn-store.js";
import * as defaultJournal from "../broker/journal.js";
import {
  diagnoseBrokerUnreachable,
  discoverBroker as defaultDiscoverBroker,
  getTurn as defaultGetTurn,
} from "../broker/client.js";
import { sleep as defaultSleep } from "../util.js";

// F5 (coordinator wiring): Claude registered here too — the read path
// rejected claude before this even though the CLI accepted it. Selectors
// remain UNVERIFIED against the live Claude DOM (adapters/claude.js).
const ADAPTERS = Object.freeze({ chatgpt: chatgptAdapter, gemini: geminiAdapter, claude: claudeAdapter });
const POLL_INTERVAL_MS = 500;
const STALL_AFTER_MS = 30000;
// D2: after (re)attaching to a tab the message list may not have rendered
// yet. Poll until answer text appears, or this bound, before deciding the
// read is empty. Driven by the injectable clock/timer (deps.now /
// deps.sleep), never a fixed sleep. Applies to both branches: a tab opened
// by this read (openTab) and a tab already in the target list (attachTab) —
// a restored-session shell tab is indistinguishable from a loaded one at
// attach time (REPORT-7b9e1ceb path A), so both must settle. The settle
// completes only on non-empty answerText, not on message nodes or the
// action bar: ChatGPT renders user turns, then the answer shell / action
// bar, then the body text (REPORT-7b9e1ceb path B).
const REOPEN_SETTLE_TIMEOUT_MS = 10000;
// D4: a completed candidate must prove its text stable across two consecutive
// samples. The action bar can appear a beat before the final text lands, so a
// single sample can return only the first line(s) of a long answer as
// "completed". Bound the extra wait; a candidate still changing at the bound
// is returned as streaming with partial:true instead of completed.
const COMPLETION_SETTLE_MS = 2000;

function coded(code, message = code, cause) {
  const error = new WfaError(code, message, cause ? { cause } : undefined);
  return error;
}

function providerFromUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw coded("INVALID_ARGUMENT", `Invalid conversation URL: ${value}`);
  }
  if (parsed.protocol !== "https:") {
    throw coded("INVALID_ARGUMENT", "Conversation URL must use HTTPS");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "chatgpt.com" || host === "www.chatgpt.com") return "chatgpt";
  if (host === "gemini.google.com") return "gemini";
  // F5 (coordinator wiring): claude.ai maps to the new Claude adapter.
  if (host === "claude.ai") return "claude";
  throw coded("INVALID_ARGUMENT", `Unsupported conversation URL host: ${host}`);
}

function normalizeConversationUrl(value, provider) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  let actualProvider;
  try {
    actualProvider = providerFromUrl(value);
  } catch {
    return null;
  }
  if (provider && actualProvider !== provider) return null;
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${parsed.hostname.toLowerCase()}${pathname}${parsed.hash}`;
}

function directResult(record) {
  return {
    status: "completed",
    state: "completed",
    taskId: record.turnId ?? record.id ?? null,
    provider: record.provider ?? null,
    conversationId: record.conversationId ?? null,
    conversationUrl: record.conversationUrl ?? null,
    targetId: record.targetId ?? null,
    text: record.text,
    reason: record.reason ?? "completed",
    evidence: record.evidence ?? null,
    source: "result-store",
    partial: false,
  };
}

function turnStateResult(turn, taskId) {
  const turnState = turn?.state;
  // A broker/persisted turn that carries text without a terminal state is
  // still in flight: its text is a partial snapshot, not a final answer.
  const turnPartial = typeof turn?.text === "string" && turn.text.trim().length > 0;
  if (turnState === "queued") {
    return {
      status: "pending",
      state: "pending",
      taskId,
      provider: turn.provider ?? null,
      conversationUrl: turn.conversationUrl ?? null,
      targetId: turn.targetId ?? null,
      text: typeof turn.text === "string" ? turn.text : "",
      reason: turn.reason ?? "queued",
      evidence: turn.evidence ?? null,
      partial: turnPartial,
    };
  }
  if (turnState === "running") {
    return {
      status: "thinking",
      state: "thinking",
      taskId,
      provider: turn.provider ?? null,
      conversationUrl: turn.conversationUrl ?? null,
      targetId: turn.targetId ?? null,
      text: typeof turn.text === "string" ? turn.text : "",
      reason: turn.reason ?? "waiting_for_answer",
      evidence: turn.evidence ?? null,
      partial: turnPartial,
    };
  }
  if (turnState === "stalled") {
    return {
      status: "stalled",
      state: "stalled",
      taskId,
      provider: turn.provider ?? null,
      conversationUrl: turn.conversationUrl ?? null,
      targetId: turn.targetId ?? null,
      text: typeof turn.text === "string" ? turn.text : "",
      reason: turn.reason ?? "stalled",
      evidence: turn.evidence ?? null,
      partial: turnPartial,
    };
  }
  if (turnState === "needs_human" || turnState === "takeover") {
    return {
      status: "needs_user",
      state: "needs_user",
      taskId,
      provider: turn.provider ?? null,
      conversationUrl: turn.conversationUrl ?? null,
      targetId: turn.targetId ?? null,
      text: typeof turn.text === "string" ? turn.text : "",
      reason: turn.reason ?? turnState,
      evidence: turn.evidence ?? null,
      partial: turnPartial,
    };
  }
  if (turnState === "failed") {
    return {
      status: "unconfirmed",
      state: "unconfirmed",
      taskId,
      provider: turn.provider ?? null,
      conversationUrl: turn.conversationUrl ?? null,
      targetId: turn.targetId ?? null,
      text: typeof turn.text === "string" ? turn.text : "",
      reason: turn.reason ?? "turn_failed",
      evidence: turn.evidence ?? null,
      partial: turnPartial,
    };
  }
  return null;
}

function mapPageState(page, turn, taskId, metadata) {
  const text = typeof page?.answerText === "string" ? page.answerText : "";
  const nonEmptyText = text.trim().length > 0;
  const pendingCount = Number.isInteger(page?.pendingCount) ? page.pendingCount : 0;
  // D4: Gemini reports pending nodes in the last model-response while the
  // answer is still streaming. An action bar seen while pending > 0 is not a
  // completion signal: the text sampled then is only the streamed prefix.
  // Gated on !requiresCompletionActions to match waitForCompletion: ChatGPT
  // never reports pendingCount and its stop/action signals are judged
  // differently, so its behaviour is unchanged.
  const requiresCompletionActions = metadata?.requiresCompletionActions === true;
  const base = {
    taskId: taskId ?? null,
    provider: metadata.provider,
    conversationUrl: metadata.conversationUrl ?? null,
    targetId: metadata.targetId ?? null,
    text,
    // partial marks a non-empty text that is not a confirmed final answer.
    // A short string returned with partial:true must not be read as complete.
    partial: nonEmptyText,
    evidence: {
      userTurns: page?.userTurns ?? 0,
      answerTurns: page?.answerTurns ?? 0,
      answerActionsVisible: page?.answerActionsVisible ?? null,
      pendingCount,
      stopVisible: Boolean(page?.stopVisible),
      title: page?.title ?? "",
      pageError: page?.pageError ?? null,
    },
  };

  if (page?.hasChallenge || page?.loggedOut || page?.pageError) {
    return {
      ...base,
      status: "needs_user",
      state: "needs_user",
      reason: page?.pageError?.reason || (page?.loggedOut ? "login_required" : "human_verification_required"),
    };
  }

  if (nonEmptyText && page?.answerActionsVisible === true) {
    if (!requiresCompletionActions && pendingCount > 0) {
      return { ...base, status: "streaming", state: "streaming", reason: "streaming_pending" };
    }
    return { ...base, status: "completed", state: "completed", reason: "completed", partial: false };
  }

  if (nonEmptyText && page?.answerActionsVisible === false) {
    return { ...base, status: "streaming", state: "streaming", reason: "completion_signal_not_seen" };
  }

  if (nonEmptyText) {
    return { ...base, status: "unconfirmed", state: "unconfirmed", reason: "completion_signal_unknown" };
  }

  if (page?.stopVisible) {
    return { ...base, status: "thinking", state: "thinking", reason: "generation_in_progress" };
  }

  if (turn?.state === "queued") {
    return { ...base, status: "pending", state: "pending", reason: "queued" };
  }
  if (turn?.state === "running") {
    return { ...base, status: "thinking", state: "thinking", reason: "waiting_for_answer" };
  }
  return { ...base, status: "unconfirmed", state: "unconfirmed", reason: "no_positive_completion_signal" };
}

function findMatchingTarget(targets, targetId, conversationUrl, provider) {
  if (targetId) {
    const exact = targets.find((target) => target.targetId === targetId);
    if (exact) return exact;
  }
  const expected = normalizeConversationUrl(conversationUrl, provider);
  if (!expected) return null;
  return targets.find((target) =>
    normalizeConversationUrl(target.url, provider) === expected
  ) || null;
}

export async function readConversation({
  home,
  provider,
  url,
  taskId,
  mode = "background",
  timeoutMs = 15000,
  wait = 0,
  noReopen = false,
  signal,
  deps = {},
} = {}) {
  const hasUrl = typeof url === "string" && url.trim().length > 0;
  const hasTaskId = typeof taskId === "string" && taskId.trim().length > 0;
  if (hasUrl === hasTaskId) {
    throw coded("INVALID_ARGUMENT", "Specify exactly one of url or taskId");
  }
  if (!["background", "visible", "headless"].includes(mode)) {
    throw coded("INVALID_ARGUMENT", `Invalid mode: ${mode}`);
  }
  if (provider !== undefined && !ADAPTERS[String(provider).toLowerCase()]) {
    throw coded("INVALID_ARGUMENT", `Unsupported provider: ${provider}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw coded("INVALID_ARGUMENT", "timeoutMs must be a positive number");
  }
  const waitMs = wait === true ? 30000 : Number(wait || 0);
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw coded("INVALID_ARGUMENT", "wait must be a non-negative number of milliseconds");
  }
  if (hasTaskId && (taskId.includes("/") || taskId.includes("\\") || taskId.includes(".."))) {
    throw coded("INVALID_ARGUMENT", "Invalid taskId");
  }

  const effectiveHome = home || getHomeDir();
  const readResultFn = deps.resultStore?.readResult || deps.readResult || defaultResultStore.readResult;
  const readTurnRecordFn = deps.turnStore?.readTurn || deps.readTurn || defaultTurnStore.readTurn;
  const readCommitFn = deps.readCommit || deps.journal?.readCommit || defaultJournal.readCommit;
  const discoverBrokerFn = deps.discoverBroker || defaultDiscoverBroker;
  const getTurnFn = deps.getTurn || defaultGetTurn;
  const recoverFn = deps.recoverBrowser || defaultRecoverBrowser;
  const connectFn = deps.connectCdp || defaultConnectCdp;
  const driver = deps.driver || defaultDriver;
  const listTargetsFn = driver.listPageTargets || defaultDriver.listPageTargets;
  const attachTabFn = driver.attachTab || defaultDriver.attachTab;
  const openTabFn = driver.openTab || defaultDriver.openTab;
  const readStateFn = driver.readTurnState || defaultDriver.readTurnState;
  const sleepFn = deps.sleep || defaultSleep;
  const nowFn = deps.now || (() => Date.now());

  let resultRecord = null;
  let persistedTurnRecord = null;
  let journalRecord = null;
  let turn = null;
  let brokerRecord = null;
  let resolvedProvider = provider ? String(provider).toLowerCase() : null;
  let conversationUrl = hasUrl ? url : null;
  let targetId = null;
  let initialTurnLookupDone = false;

  if (hasUrl) {
    const fromUrl = providerFromUrl(url);
    if (resolvedProvider && resolvedProvider !== fromUrl) {
      throw coded("INVALID_ARGUMENT", `URL belongs to ${fromUrl}, not ${resolvedProvider}`);
    }
    resolvedProvider = fromUrl;
  } else {
    resultRecord = await readResultFn(effectiveHome, taskId);
    persistedTurnRecord = await readTurnRecordFn(effectiveHome, taskId);
    journalRecord = await Promise.resolve().then(() => readCommitFn(effectiveHome, taskId)).catch(() => null);

    if (resolvedProvider && resultRecord?.provider &&
        resolvedProvider !== String(resultRecord.provider).toLowerCase()) {
      throw coded("INVALID_ARGUMENT", `Task ${taskId} belongs to ${resultRecord.provider}, not ${resolvedProvider}`);
    }

    if (resolvedProvider && persistedTurnRecord?.provider &&
        resolvedProvider !== String(persistedTurnRecord.provider).toLowerCase()) {
      throw coded("INVALID_ARGUMENT", `Task ${taskId} belongs to ${persistedTurnRecord.provider}, not ${resolvedProvider}`);
    }

    if (resultRecord?.state === "completed" &&
        typeof resultRecord.text === "string" && resultRecord.text.trim()) {
      return directResult(resultRecord);
    }

    try {
      brokerRecord = await discoverBrokerFn(effectiveHome);
      if (brokerRecord) {
        const response = await getTurnFn(brokerRecord, taskId);
        initialTurnLookupDone = true;

        if (response?.status === 200 && response.json && typeof response.json === "object") {
          turn = response.json;
        } else if (response?.status === 404 && persistedTurnRecord) {
          // The durable record is authoritative for a known task even if a
          // broker instance has not yet restored it into its in-memory map.
          turn = persistedTurnRecord;
        } else if (response?.status === 401 || response?.status >= 500) {
          throw coded("BROKER_UNREACHABLE", `Broker cannot serve persisted turn ${taskId}`);
        }
      }
    } catch (error) {
      brokerRecord = null;
      if (persistedTurnRecord || journalRecord) {
        const diag = await diagnoseBrokerUnreachable({
          home: effectiveHome,
          turnId: taskId,
          lastTurn: persistedTurnRecord,
          deps,
        });
        const unreachable = coded(
          "BROKER_UNREACHABLE",
          `Persisted turn ${taskId} exists, but its broker is unreachable (submissionState=${diag.submissionState}, safeToResend=${diag.safeToResend})`,
          error
        );
        unreachable.turnId = taskId;
        unreachable.submissionState = diag.submissionState;
        unreachable.safeToResend = diag.safeToResend;
        unreachable.livePage = diag.livePage;
        unreachable.details = diag;
        throw unreachable;
      }
    }

    if (!brokerRecord && (persistedTurnRecord || journalRecord)) {
      const diag = await diagnoseBrokerUnreachable({
        home: effectiveHome,
        turnId: taskId,
        lastTurn: persistedTurnRecord,
        deps,
      });
      const unreachable = coded(
        "BROKER_UNREACHABLE",
        `Persisted turn ${taskId} exists, but its broker is not running (submissionState=${diag.submissionState}, safeToResend=${diag.safeToResend})`
      );
      unreachable.turnId = taskId;
      unreachable.submissionState = diag.submissionState;
      unreachable.safeToResend = diag.safeToResend;
      unreachable.livePage = diag.livePage;
      unreachable.details = diag;
      throw unreachable;
    }

    if (!turn && persistedTurnRecord && brokerRecord) {
      turn = persistedTurnRecord;
    }

    if (!turn && !resultRecord && !persistedTurnRecord && !journalRecord) {
      throw coded("TURN_NOT_FOUND", `No broker turn or persisted result exists for ${taskId}`);
    }

    const taskProvider = turn?.provider || persistedTurnRecord?.provider || resultRecord?.provider || journalRecord?.provider;
    if (resolvedProvider && taskProvider &&
        resolvedProvider !== String(taskProvider).toLowerCase()) {
      throw coded("INVALID_ARGUMENT", `Task ${taskId} belongs to ${taskProvider}, not ${resolvedProvider}`);
    }
    resolvedProvider = resolvedProvider || taskProvider || null;
    conversationUrl =
      turn?.conversationUrl ||
      persistedTurnRecord?.conversationUrl ||
      resultRecord?.conversationUrl ||
      null;
    targetId =
      turn?.targetId ||
      persistedTurnRecord?.targetId ||
      resultRecord?.targetId ||
      null;

    if (!resolvedProvider && conversationUrl) {
      resolvedProvider = providerFromUrl(conversationUrl);
    }
    if (resolvedProvider && !ADAPTERS[resolvedProvider]) {
      throw coded("INVALID_ARGUMENT", `Unsupported provider: ${resolvedProvider}`);
    }
  }

  if (!resolvedProvider || !ADAPTERS[resolvedProvider]) {
    throw coded("INVALID_ARGUMENT", "Provider could not be resolved; supply --provider or a supported URL");
  }
  const adapter = ADAPTERS[resolvedProvider];
  if (conversationUrl && !normalizeConversationUrl(conversationUrl, resolvedProvider)) {
    throw coded("INVALID_ARGUMENT", "Conversation URL does not match the selected provider");
  }

  const deadline = nowFn() + waitMs;
  const startTime = nowFn();
  let cdp = null;
  let sessionId = null;
  let selectedTargetId = targetId;
  let openedOnce = false;
  // D2: deadline (via nowFn) until which an attached or freshly opened tab
  // is polled for answer text; null when no tab was (re)attached in this read.
  let reopenSettleDeadline = null;
  let reopenSettled = false;
  // D4: text of a completed candidate awaiting a confirming second sample,
  // and the bound for that confirmation.
  let completedCandidateText = null;
  let completedCandidateDeadline = null;
  let lastPageState = null;
  let lastResult = null;
  let lastProgressAt = startTime;
  let lastProgressSignature = "";
  let lastTurnState = turn || persistedTurnRecord || resultRecord;

  try {
    while (true) {
      if (signal?.aborted) {
        throw coded("CANCELLED", "Read operation cancelled");
      }

      if (hasTaskId) {
        const latestRecord = await readResultFn(effectiveHome, taskId);
        if (latestRecord?.state === "completed" &&
            typeof latestRecord.text === "string" && latestRecord.text.trim()) {
          return directResult(latestRecord);
        }
        if (latestRecord) {
          resultRecord = latestRecord;
          if (!turn) lastTurnState = latestRecord;
          conversationUrl = conversationUrl || latestRecord.conversationUrl || null;
          targetId = targetId || latestRecord.targetId || null;
          selectedTargetId = selectedTargetId || targetId;
        }

        if (initialTurnLookupDone) {
          initialTurnLookupDone = false;
        } else {
          try {
            brokerRecord = brokerRecord || await discoverBrokerFn(effectiveHome);
            if (brokerRecord) {
              const response = await getTurnFn(brokerRecord, taskId);
              if (response?.status === 200 && response.json && typeof response.json === "object") {
                lastTurnState = turn = response.json;
                conversationUrl = turn.conversationUrl || conversationUrl;
                targetId = turn.targetId || targetId;
                selectedTargetId = selectedTargetId || targetId;
              }
            }
          } catch {
            // Re-discover on the next observation interval if the broker restarts.
            brokerRecord = null;
          }
        }
      }

      const terminalTurnResult = turnStateResult(lastTurnState, taskId);
      if (terminalTurnResult && terminalTurnResult.status !== "unconfirmed") {
        if (terminalTurnResult.status === "needs_user" ||
            (terminalTurnResult.status === "stalled" && !conversationUrl && !selectedTargetId)) {
          return { ...terminalTurnResult, elapsedMs: nowFn() - startTime };
        }
      }

      if (!cdp && (conversationUrl || selectedTargetId)) {
        const recovery = await recoverFn({
          home: effectiveHome,
          mode,
          ...(deps.chromePath ? { chromePath: deps.chromePath } : {}),
          probes: deps.probes,
        });
        if (!recovery?.chrome?.port) {
          return {
            status: "needs_user",
            state: "needs_user",
            taskId: hasTaskId ? taskId : null,
            provider: resolvedProvider,
            conversationUrl,
            targetId: selectedTargetId,
            text: "",
            reason: recovery?.reason || "browser_unavailable",
            evidence: recovery?.evidence ?? null,
            elapsedMs: nowFn() - startTime,
            partial: false,
          };
        }
        cdp = await connectFn(recovery.chrome.port);
      }

      if (cdp && !sessionId) {
        const targets = await listTargetsFn(cdp);
        const target = findMatchingTarget(targets, selectedTargetId, conversationUrl, resolvedProvider);
        const effectiveNoReopen = noReopen || terminalTurnResult?.status === "stalled";
        if (target) {
          selectedTargetId = target.targetId;
          conversationUrl = conversationUrl || (normalizeConversationUrl(target.url, resolvedProvider) ? target.url : null);
          const attached = await attachTabFn(cdp, target.targetId, { timeoutMs });
          sessionId = attached.sessionId;
          // D2 (fix, REPORT-7b9e1ceb path A): a target already in the list
          // may be a restored-session shell whose page has not loaded yet.
          // It cannot be told apart from a loaded tab here, so it enters
          // the same settle as a freshly opened tab. A loaded tab settles
          // on the first sample (answerText already present), so this
          // costs a rendered tab nothing.
          reopenSettleDeadline = nowFn() + REOPEN_SETTLE_TIMEOUT_MS;
          reopenSettled = false;
        } else if (!openedOnce && conversationUrl && !effectiveNoReopen) {
          openedOnce = true;
          const opened = await openTabFn(cdp, conversationUrl, { timeoutMs });
          selectedTargetId = opened.targetId;
          sessionId = opened.sessionId;
          // D2: the page has just started loading; do not decide the read is
          // empty until the message list has had a chance to render.
          reopenSettleDeadline = nowFn() + REOPEN_SETTLE_TIMEOUT_MS;
          reopenSettled = false;
        } else if (effectiveNoReopen || !conversationUrl) {
          return {
            status: "tab_missing",
            state: "tab_missing",
            taskId: hasTaskId ? taskId : null,
            provider: resolvedProvider,
            conversationUrl,
            targetId: selectedTargetId,
            text: "",
            reason: "SESSION_TAB_MISSING",
            evidence: null,
            elapsedMs: nowFn() - startTime,
            partial: false,
          };
        }
      }

      if (cdp && sessionId) {
        try {
          lastPageState = await readStateFn(cdp, sessionId, adapter);
          const signature = JSON.stringify([
            lastPageState?.userTurns ?? 0,
            lastPageState?.answerTurns ?? 0,
            lastPageState?.answerText ?? "",
            lastPageState?.answerActionsVisible ?? null,
            lastPageState?.pendingCount ?? 0,
            Boolean(lastPageState?.stopVisible),
          ]);
          if (signature !== lastProgressSignature) {
            lastProgressSignature = signature;
            lastProgressAt = nowFn();
          }
          lastResult = mapPageState(lastPageState, lastTurnState, hasTaskId ? taskId : null, {
            provider: resolvedProvider,
            conversationUrl,
            targetId: selectedTargetId,
            requiresCompletionActions: adapter.requiresCompletionActions === true,
          });
          // D2 (fix, REPORT-7b9e1ceb path B): a reopened tab counts as
          // settled only once non-empty answer text has rendered. Message
          // nodes and the action bar render before the body text, so
          // userTurns/answerTurns/actionsVisible alone must not end the
          // settle — until then the read keeps polling instead of
          // reporting an empty conversation. A genuinely empty
          // conversation never produces text, so it still returns
          // unconfirmed when the bounded settle expires.
          if (reopenSettleDeadline !== null && !reopenSettled) {
            const hasAnswerText = (lastPageState?.answerText ?? "").trim().length > 0;
            if (hasAnswerText) reopenSettled = true;
          }
        } catch (error) {
          lastResult = {
            status: "unconfirmed",
            state: "unconfirmed",
            taskId: hasTaskId ? taskId : null,
            provider: resolvedProvider,
            conversationUrl,
            targetId: selectedTargetId,
            text: lastPageState?.answerText || "",
            reason: error?.code || "page_read_failed",
            evidence: null,
            partial: Boolean((lastPageState?.answerText || "").trim()),
          };
        }
      } else {
        lastResult = turnStateResult(lastTurnState, taskId) || {
          status: "unconfirmed",
          state: "unconfirmed",
          taskId: hasTaskId ? taskId : null,
          provider: resolvedProvider,
          conversationUrl,
          targetId: selectedTargetId,
          text: "",
          reason: "conversation_locator_pending",
          evidence: null,
          partial: false,
        };
      }

      // D4: a completed result is only returned once its text has been seen
      // unchanged on two consecutive samples. The first sighting arms a
      // bounded confirmation window anchored at that sighting; text changes
      // inside the window update the candidate but do not extend it, so a
      // still-growing answer cannot hold the read open indefinitely.
      if (lastResult?.status === "completed") {
        if (completedCandidateText !== null && lastResult.text === completedCandidateText) {
          return { ...lastResult, elapsedMs: nowFn() - startTime };
        }
        if (completedCandidateText === null) {
          completedCandidateDeadline = nowFn() + COMPLETION_SETTLE_MS;
        }
        completedCandidateText = lastResult.text;
      } else if (lastResult?.status === "needs_user") {
        return { ...lastResult, elapsedMs: nowFn() - startTime };
      } else {
        completedCandidateText = null;
        completedCandidateDeadline = null;
      }

      if (["thinking", "streaming"].includes(lastResult?.status) &&
          nowFn() - lastProgressAt >= STALL_AFTER_MS) {
        return {
          ...lastResult,
          status: "stalled",
          state: "stalled",
          reason: "no_read_progress",
          elapsedMs: nowFn() - startTime,
        };
      }

      // The observation window is extended while a (re)attached tab has not
      // rendered answer text yet (D2) or a completed candidate is awaiting
      // its confirming sample (D4); both extensions are bounded.
      const effectiveDeadline = Math.max(
        deadline,
        reopenSettleDeadline !== null && !reopenSettled ? reopenSettleDeadline : -Infinity,
        completedCandidateDeadline !== null ? completedCandidateDeadline : -Infinity,
      );
      if (nowFn() >= effectiveDeadline) {
        let result = lastResult || {
          status: "unconfirmed",
          state: "unconfirmed",
          taskId: hasTaskId ? taskId : null,
          provider: resolvedProvider,
          conversationUrl,
          targetId: selectedTargetId,
          text: "",
          reason: "observation_window_elapsed",
          evidence: null,
          partial: false,
        };
        // D4: a completed candidate whose text was still changing when the
        // window closed is a partial stream, not a completed answer.
        if (completedCandidateText !== null && result?.status === "completed") {
          result = {
            ...result,
            status: "streaming",
            state: "streaming",
            reason: "completion_unsettled",
            partial: true,
          };
        }
        return {
          ...result,
          elapsedMs: nowFn() - startTime,
        };
      }

      await sleepFn(Math.min(POLL_INTERVAL_MS, Math.max(0, effectiveDeadline - nowFn())));
    }
  } finally {
    if (cdp) {
      try { cdp.close(); } catch {}
    }
  }
}
