import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Store } from "./store.js";
import { normalizeProviders } from "./jobs.js";
import { isPidAlive, uuid } from "./util.js";
import { loadConfig } from "./config.js";
import { resolveAskBridge, runProcess } from "./ask-bridge.js";
import { WfaError } from "./errors.js";
import { isBlockingChild, rememberSession, summarizeTask } from "./state.js";
import { refreshTask } from "./runner.js";

export async function getTask(taskId, { home, store = new Store(home) } = {}) {
  const task = await refreshTask(taskId, { home, store });
  return task;
}

export async function listTasks({ home, store = new Store(home) } = {}) {
  const snapshot = await store.snapshot();
  return Object.values(snapshot.tasks.tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function collectTask(taskId, {
  provider, confirmComplete, home, store = new Store(home), config, run = runProcess,
} = {}) {
  if (!confirmComplete) {
    throw new WfaError("CONFIRMATION_REQUIRED", "Collecting uses ask-bridge get to read the latest message; it does not prove generation is complete. Re-run with --confirm-complete only after you have confirmed the provider finished generating.");
  }
  const task = await getTask(taskId, { home, store });
  const candidates = provider ? [provider] : Object.keys(task.children).filter((key) => isBlockingChild(task.children[key]));
  if (candidates.length !== 1) {
    throw new WfaError("PROVIDER_REQUIRED", "Specify --provider when the task contains multiple providers or has no single unresolved provider.");
  }
  const selected = normalizeProviders([candidates[0]])[0];
  const child = task.children[selected];
  if (!child) throw new WfaError("PROVIDER_NOT_IN_TASK", `Provider ${selected} is not part of task ${taskId}.`);
  if (child.state === "completed") throw new WfaError("ALREADY_COMPLETED", "This provider already has a collected result.");
  if (!isBlockingChild(child)) throw new WfaError("NOT_UNRESOLVED", `Provider ${selected} is not in an unresolved state (${child.state}).`);
  if (child.childPid && isPidAlive(child.childPid)) throw new WfaError("TASK_STILL_RUNNING", "The ask-bridge batch process is still running. Wait for it to exit before collecting.");
  if (task.parentPid && isPidAlive(task.parentPid)) throw new WfaError("WAITER_STILL_RUNNING", "The original wfa process is still running. Wait for it to exit before collecting.");
  if (!child.threadUrl) throw new WfaError("NO_RECOVERY_URL", "No conversation URL was persisted. Automatic resend is forbidden; inspect the original browser conversation manually.");
  const resolvedConfig = config ?? await loadConfig(home);
  const command = resolveAskBridge(resolvedConfig);
  const outputPath = path.join(task.runDir, "recovered", `${selected}-${uuid()}.md`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await run(command, [
    "--backend", "browser",
    "--provider", selected,
    "--output", outputPath,
    "get",
    child.threadUrl,
  ], { inherit: false, timeoutMs: 60000 });

  if (result.spawnError || result.processError || result.timedOut || result.code !== 0) {
    const detail = result.spawnError?.message || result.processError?.message || result.stderr || `exit ${result.code}`;
    throw new WfaError("COLLECT_FAILED", `ask-bridge get failed: ${detail}`);
  }
  const body = await readFile(outputPath, "utf8").catch(() => "");
  if (!body.trim()) throw new WfaError("EMPTY_RECOVERY", "ask-bridge get returned no response content. The task remains unresolved.");
  const collected = await store.transaction(({ tasks, sessions }) => {
    const current = tasks.tasks[taskId];
    const candidate = current?.children[selected];
    if (!isBlockingChild(candidate) || candidate.threadUrl !== child.threadUrl) {
      throw new WfaError("COLLECT_STATE_CHANGED", "The provider state changed during collection. Inspect the current task before trying again.");
    }
    candidate.state = "completed";
    candidate.resultPath = outputPath;
    candidate.error = null;
    candidate.collectedAt = new Date().toISOString();
    rememberSession(tasks.tasks, sessions, current, selected);
    current.state = summarizeTask(current).state;
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { task: collected, provider: selected, resultPath: outputPath };
}

export async function abandonProvider(taskId, provider, { confirm, home, store = new Store(home) } = {}) {
  if (!confirm) throw new WfaError("CONFIRMATION_REQUIRED", "Abandoning unlocks this provider/workspace. Confirm that the old generation is no longer running, then add --confirm.");
  return store.transaction(({ tasks }) => {
    const task = tasks.tasks[taskId];
    if (!task) throw new WfaError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    const child = task.children[provider];
    if (!child) throw new WfaError("PROVIDER_NOT_IN_TASK", `Provider ${provider} is not part of task ${taskId}.`);
    if (!isBlockingChild(child)) {
      throw new WfaError("NOT_UNRESOLVED", `Provider ${provider} is not in an unresolved state (${child.state}).`);
    }
    if ((child.childPid && isPidAlive(child.childPid)) || (task.parentPid && isPidAlive(task.parentPid))) {
      throw new WfaError("TASK_STILL_RUNNING", "The original wfa/ask-bridge process is still running. Do not unlock a live task.");
    }
    child.state = "abandoned";
    child.error = "Manually abandoned by the user after confirming the previous generation is no longer active.";
    child.abandonedAt = new Date().toISOString();
    task.state = summarizeTask(task).state;
    task.updatedAt = new Date().toISOString();
    return task;
  });
}
