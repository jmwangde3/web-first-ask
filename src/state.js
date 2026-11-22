import { BLOCKING_STATES } from "./constants.js";

// One place decides what a state means. Before this, the same six upstream
// states were spelled out in metadata.js, stall-watch.js and policy-store.js,
// and the error-code mapping existed twice with one copy silently missing the
// degraded-success branch.
export const UPSTREAM_TERMINAL_STATES = new Set(["completed", "failed", "timed_out", "recoverable", "cancelled"]);
export const ACTIVE_CHILD_STATES = new Set(["queued", "running"]);
export const SETTLED_CHILD_STATES = new Set(["completed", "failed", "failed_before_start", "abandoned", "cancelled"]);

export function isBlockingChild(child) {
  return BLOCKING_STATES.has(child?.state);
}

// A metadata write that failed after response.md was written is a complete
// answer, not a loss (provider-errors.js METADATA_PERSIST_FAILED). The batch
// path and the refresh path must agree on that, otherwise the same artifact is
// `completed` when the runner sees it and `failed` when only refresh does.
export function mapProviderErrorState(state, classified, hasResponse = false) {
  if (classified?.degraded && hasResponse) return "completed";
  if (state !== "failed" && state !== "failed_before_start") return state;
  switch (classified?.errorCode) {
    case "RATE_LIMITED": return "rate_limited";
    case "LOGIN_REQUIRED": return "login_required";
    case "CLOUDFLARE_BLOCKED": return "cloudflare_blocked";
    default: return state;
  }
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
  } else if (states.length && states.every((value) => SETTLED_CHILD_STATES.has(value))) {
    state = states.some((value) => value === "completed") ? "partial" : "failed";
  } else if (states.length && !states.some((value) => ACTIVE_CHILD_STATES.has(value))) {
    // No provider is still working and not every one settled: a provider is
    // stalled, unreadable, rate-limited or of unknown submission. Only then is
    // the task waiting on a human. A failed provider next to a running one used
    // to land here and freeze the whole task before the other answer arrived.
    state = "needs_recovery";
  }
  return { ...task, state, children: task.children };
}

export function workspaceHasBlockingTask(tasks, workspace, providers, exceptTaskId = null, allowUnreadable = null) {
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
    // A follow-up on a repository-unreadable parent is the documented way out of
    // that state; the parent must not lock the child it authorized.
    if (allowUnreadable && allowUnreadable.taskId === latest.taskId
      && allowUnreadable.provider === provider && child.state === "repo_unreadable") continue;
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
    return { expected: "a new conversation (not the previous workspace thread)", actual: threadUrl };
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
