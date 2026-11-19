import { BLOCKING_STATES } from "./constants.js";

export function isBlockingChild(child) {
  return BLOCKING_STATES.has(child?.state);
}

export function summarizeTask(task) {
  const states = Object.values(task.children ?? {}).map((child) => child.state);
  let state = "running";
  if (states.length && states.every((value) => value === "completed")) {
    state = "completed";
  } else if (states.length && states.every((value) => value === "abandoned")) {
    state = "abandoned";
  } else if (states.length && states.every((value) => ["completed", "failed", "failed_before_start", "abandoned"].includes(value))) {
    state = states.some((value) => value === "completed") ? "partial" : "failed";
  } else if (states.some((value) => ["timed_out", "recoverable", "interrupted_unknown", "failed"].includes(value))) {
    state = "needs_recovery";
  }
  return { ...task, state, children: task.children };
}

export function workspaceHasBlockingTask(tasks, workspace, providers, exceptTaskId = null) {
  for (const task of Object.values(tasks)) {
    if (task.taskId === exceptTaskId || task.workspace !== workspace) continue;
    for (const provider of providers) {
      if (isBlockingChild(task.children?.[provider])) {
        return { taskId: task.taskId, provider, state: task.children[provider].state };
      }
    }
  }
  return null;
}
