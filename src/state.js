import { BLOCKING_STATES } from "./constants.js";

export function isBlockingChild(child) {
  return BLOCKING_STATES.has(child?.state);
}

// Failures that provably happened before the prompt reached the page. Without
// this exemption a single dead job locks the workspace provider forever and the
// only way out is `wfa resolve --confirm`, even though nothing was ever sent.
// Anything ambiguous (timed_out, stalled, recoverable, interrupted_unknown, a
// generic `failed`, or a failure that still carries a thread URL / result /
// completion proof) stays blocking on purpose: resending an uncertain request is
// worse than an explicit resolve.
const CONFIRMED_UNSUBMITTED_PATTERNS = [
  /^failed to open tab\b/i,
  /^prompt submission failed\b/i,
  /Timed out waiting for Gemini to show attachment/i,
];

export function isConfirmedUnsubmittedFailure(child) {
  if (!child || child.state !== "failed") return false;
  if (child.threadUrl || child.resultPath || child.completionProof) return false;
  if (child.errorCode === "ATTACHMENT_UPLOAD_TIMEOUT") return true;
  const error = String(child.error ?? "").trim();
  if (!error) return false;
  return CONFIRMED_UNSUBMITTED_PATTERNS.some((pattern) => pattern.test(error));
}

export function summarizeTask(task) {
  const states = Object.values(task.children ?? {}).map((child) => child.state);
  let state = "running";
  if (states.length && states.every((value) => value === "completed")) {
    state = "completed";
  } else if (states.length && states.every((value) => value === "abandoned")) {
    state = "abandoned";
  } else if (states.length && states.every((value) => ["completed", "failed", "failed_before_start", "abandoned", "cancelled"].includes(value))) {
    state = states.some((value) => value === "completed") ? "partial" : "failed";
  } else if (states.some((value) => ["stalled", "repo_unreadable", "timed_out", "recoverable", "interrupted_unknown", "failed", "rate_limited", "login_required", "cloudflare_blocked"].includes(value))) {
    state = "needs_recovery";
  }
  return { ...task, state, children: task.children };
}

export function workspaceHasBlockingTask(tasks, workspace, providers, exceptTaskId = null) {
  const ordered = Object.values(tasks)
    .filter((task) => task.taskId !== exceptTaskId && task.workspace === workspace)
    .reverse();
  for (const provider of providers) {
    const latest = ordered.find((task) => task.children?.[provider]);
    const child = latest?.children?.[provider];
    if (!latest || !child) continue;
    const retryAt = child.errorCode === "RATE_LIMITED" && child.state !== "completed"
      ? Date.parse(child.retryAfterAt ?? "") : NaN;
    if (Number.isFinite(retryAt) && retryAt > Date.now()) {
      return { taskId: latest.taskId, provider, state: child.state, cooldownUntil: child.retryAfterAt, cooldown: true };
    }
    if (latest.executionPending) {
      return { taskId: latest.taskId, provider, state: "execution_pending", childState: child.state, executionPending: true };
    }
    if (isConfirmedUnsubmittedFailure(child)) continue;
    if (isBlockingChild(child)) return { taskId: latest.taskId, provider, state: child.state };
  }
  return null;
}

function latestSessionTask(tasks, workspace, provider) {
  return Object.values(tasks).findLast((task) => {
    const child = task.children?.[provider];
    return task.workspace === workspace && child?.state === "completed"
      && child.threadUrl && !child.threadMismatch && !child.repoUnreadable;
  });
}

export function workspaceSessions(tasks, sessions, workspace, providers) {
  const current = { ...sessions.workspaces?.[workspace] };
  for (const provider of providers) {
    const latest = latestSessionTask(tasks, workspace, provider);
    if (latest) current[provider] = latest.children[provider].threadUrl;
  }
  return current;
}

export function detectThreadMismatch(task, provider, threadUrl) {
  if (!threadUrl) return null;
  const expected = task.sessionBaseline?.[provider] ?? null;
  const policy = task.sessionPolicy ?? (task.fresh ? "fresh" : "continue");
  if (policy === "fresh" && expected === threadUrl) {
    return { expected: "a new conversation (not the previously saved thread)", actual: threadUrl };
  }
  if (policy === "continue" && expected && expected !== threadUrl) {
    return { expected, actual: threadUrl };
  }
  return null;
}

export function detectSessionIsolationWarning(tasks, currentTask, provider, threadUrl) {
  if (!threadUrl) return null;
  const child = currentTask.children?.[provider];
  const baseline = currentTask.sessionBaseline?.[provider] ?? null;
  // Older ledger records had only `fresh`; compare against preceding tasks.
  let priorUrl = baseline;
  if (!priorUrl && !currentTask.sessionBaseline) {
    const entries = Object.values(tasks);
    const index = entries.findIndex((task) => task.taskId === currentTask.taskId);
    const previous = entries.slice(0, index).findLast((task) => task.workspace === currentTask.workspace
      && task.children?.[provider]?.state === "completed" && task.children[provider].threadUrl);
    priorUrl = previous?.children?.[provider]?.threadUrl ?? null;
  }
  const mismatch = detectThreadMismatch({ ...currentTask, sessionBaseline: {
    ...currentTask.sessionBaseline, [provider]: priorUrl,
  } }, provider, threadUrl);
  if (!mismatch) return null;
  if (child) child.threadMismatch = mismatch;
  return `THREAD_MISMATCH (${provider}): expected ${mismatch.expected}, got ${mismatch.actual}. The result may belong to a different conversation; it has not been saved for reuse.`;
}

export function rememberSession(tasks, sessions, task, provider) {
  const child = task.children?.[provider];
  if (!child?.threadUrl || child.threadMismatch || child.repoUnreadable) return;
  if (latestSessionTask(tasks, task.workspace, provider) !== task) return;
  sessions.workspaces ??= {};
  sessions.workspaces[task.workspace] ??= {};
  sessions.workspaces[task.workspace][provider] = child.threadUrl;
}
