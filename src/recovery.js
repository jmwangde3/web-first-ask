import path from "node:path";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "./store.js";
import { normalizeProviders } from "./jobs.js";
import { isPidAlive, sha256, uuid } from "./util.js";
import { loadConfig } from "./config.js";
import { resolveAskBridge, runProcess } from "./ask-bridge.js";
import { WfaError } from "./errors.js";
import { isBlockingChild, rememberSession, summarizeTask } from "./state.js";
import { refreshTask } from "./runner.js";
import { stageTaskFiles } from "./stage.js";
import { isSafeProviderConversationUrl, verifyStoredCompletion } from "./metadata.js";

export async function getTask(taskId, { home, store = new Store(home) } = {}) {
  const task = await refreshTask(taskId, { home, store });
  return task;
}

export async function listTasks({ home, store = new Store(home) } = {}) {
  const snapshot = await store.snapshot();
  return Object.values(snapshot.tasks.tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function verifyExistingResult(task, provider, child) {
  if (!child.resultPath || !task.runDir) {
    throw new WfaError("COMPLETED_RESULT_MISSING", `Provider ${provider} is marked completed but has no saved result path.`);
  }
  const resultPath = path.resolve(child.resultPath);
  if (!pathInside(task.runDir, resultPath)) {
    throw new WfaError("UNSAFE_RESULT_SOURCE", "The recorded resultPath is outside this task's run directory.");
  }
  const rootPath = path.resolve(task.runDir);
  const rootInfo = await lstat(rootPath).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WfaError("UNSAFE_RESULT_SOURCE", "The task run directory is missing or is not a real directory.");
  }
  const relative = path.relative(rootPath, resultPath);
  let currentPath = rootPath;
  const parts = relative.split(path.sep).filter(Boolean);
  let info = rootInfo;
  for (let index = 0; index < parts.length; index += 1) {
    currentPath = path.join(currentPath, parts[index]);
    info = await lstat(currentPath).catch(() => null);
    if (!info || info.isSymbolicLink()) {
      throw new WfaError("UNSAFE_RESULT_SOURCE", "The saved result path contains a missing or symbolic-link component.");
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new WfaError("UNSAFE_RESULT_SOURCE", "A parent component of the saved result is not a directory.");
    }
  }
  if (!info?.isFile()) {
    throw new WfaError("COMPLETED_RESULT_MISSING", "The saved result is missing or not a regular file.");
  }
  const body = await readFile(resultPath).catch(() => null);
  if (!body?.length || !body.toString("utf8").trim()) {
    throw new WfaError("COMPLETED_RESULT_MISSING", "The saved result is empty or unreadable.");
  }
  if (child.completionProof) {
    const proof = await verifyStoredCompletion(task.outputDir, child, provider, task.runDir);
    if (!proof.verified || path.resolve(proof.result.responsePath) !== resultPath
      || sha256(body) !== child.completionProof.responseSha256) {
      throw new WfaError("RESULT_INTEGRITY_FAILED", proof.error ?? "The verified ask-bridge result changed after it was collected.");
    }
  }
  return resultPath;
}

export async function collectTask(taskId, {
  provider,
  confirmComplete,
  home,
  store = new Store(home),
  config,
  run = runProcess,
} = {}) {
  const task = await getTask(taskId, { home, store });
  const childKeys = Object.keys(task.children ?? {});
  const candidates = provider
    ? [provider]
    : (childKeys.length === 1 ? childKeys : childKeys.filter((key) => isBlockingChild(task.children[key])));
  if (candidates.length !== 1) {
    throw new WfaError("PROVIDER_REQUIRED", "Specify --provider when the task contains multiple providers or has no single unresolved provider.");
  }
  const selected = normalizeProviders([candidates[0]])[0];
  const child = task.children[selected];
  if (!child) throw new WfaError("PROVIDER_NOT_IN_TASK", `Provider ${selected} is not part of task ${taskId}.`);

  // A completed ask-bridge batch artifact is already the final response. The
  // collect command becomes idempotent and does not call `ask-bridge get`.
  if (child.state === "completed") {
    const resultPath = await verifyExistingResult(task, selected, child);
    return {
      task,
      provider: selected,
      resultPath,
      alreadyCollected: true,
      autoCollected: child.completionProof?.source === "ask-bridge-batch-terminal",
      executionPending: Boolean(task.executionPending),
    };
  }

  if (!isBlockingChild(child)) {
    throw new WfaError("NOT_UNRESOLVED", `Provider ${selected} is not in an unresolved state (${child.state}).`);
  }
  if (!confirmComplete) {
    throw new WfaError(
      "CONFIRMATION_REQUIRED",
      "No trusted ask-bridge completed metadata and complete response.md are available for this provider. `ask-bridge get` cannot prove generation has finished. Confirm completion in the browser, then retry with --confirm-complete for manual recovery.",
    );
  }
  if (child.childPid && isPidAlive(child.childPid)) throw new WfaError("TASK_STILL_RUNNING", "The ask-bridge batch process is still running. Wait for it to exit before manual collection.");
  if (task.parentPid && isPidAlive(task.parentPid)) throw new WfaError("WAITER_STILL_RUNNING", "The original wfa process is still running. Wait for it to exit before manual collection.");
  if (!isSafeProviderConversationUrl(selected, child.threadUrl)) {
    throw new WfaError("NO_RECOVERY_URL", "No verified provider conversation URL was persisted. Automatic resend is forbidden; inspect the original browser conversation manually.");
  }

  const expectedRevision = child.revision ?? 0;
  const expectedState = child.state;
  const expectedThread = child.threadUrl;
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
    if (!isBlockingChild(candidate) || candidate.threadUrl !== expectedThread
      || (candidate.revision ?? 0) !== expectedRevision || candidate.state !== expectedState) {
      throw new WfaError("COLLECT_STATE_CHANGED", "The provider state changed during collection. Inspect the current task before trying again.");
    }
    candidate.state = "completed";
    candidate.resultPath = outputPath;
    candidate.error = null;
    candidate.errorCode = null;
    candidate.recoveryHint = null;
    candidate.completionProof = null;
    candidate.collectionSource = "manual-confirmed-get";
    candidate.collectedAt = new Date().toISOString();
    candidate.revision = (candidate.revision ?? 0) + 1;
    rememberSession(tasks.tasks, sessions, current, selected);
    current.state = summarizeTask(current).state;
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { task: collected, provider: selected, resultPath: outputPath, alreadyCollected: false, autoCollected: false };
}

export async function waitForTask(taskId, {
  provider,
  timeoutSeconds = 300,
  pollMs = 2000,
  stage = false,
  home,
  store = new Store(home),
  onPoll,
} = {}) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 7200) {
    throw new WfaError("INVALID_TIMEOUT", "Wait timeout must be an integer from 0 to 7200 seconds.");
  }
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60000) {
    throw new WfaError("INVALID_POLL_INTERVAL", "Poll interval must be an integer from 250 to 60000 milliseconds.");
  }
  const selected = provider ? normalizeProviders([provider])[0] : null;
  const before = await store.snapshot();
  const beforeTask = before.tasks.tasks[taskId];
  if (!beforeTask) throw new WfaError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  if (selected && !beforeTask.children?.[selected]) {
    throw new WfaError("PROVIDER_NOT_IN_TASK", `Provider ${selected} is not part of task ${taskId}.`);
  }
  const priorProofs = new Set(Object.entries(beforeTask.children ?? {})
    .filter(([, child]) => child.completionProof?.source === "ask-bridge-batch-terminal")
    .map(([key]) => key));
  const collected = [];
  const recorded = new Set(priorProofs);
  const noteNewlyCollected = (current) => {
    for (const [key, child] of Object.entries(current.children ?? {})) {
      if (recorded.has(key) || child.state !== "completed"
        || child.completionProof?.source !== "ask-bridge-batch-terminal" || !child.resultPath) continue;
      recorded.add(key);
      collected.push({ provider: key, resultPath: child.resultPath, source: "ask-bridge-batch-terminal" });
    }
  };

  const deadline = Date.now() + timeoutSeconds * 1000;
  let task = await refreshTask(taskId, { home, store });
  noteNewlyCollected(task);
  onPoll?.(task);
  while (true) {
    const children = selected ? [task.children[selected]] : Object.values(task.children ?? {});
    const isActive = Boolean(task.executionPending) || task.state === "preparing"
      || children.some((child) => ["queued", "running"].includes(child.state));
    const remaining = deadline - Date.now();
    if (!isActive || remaining <= 0) break;
    await delay(Math.min(pollMs, remaining));
    task = await refreshTask(taskId, { home, store });
    noteNewlyCollected(task);
    onPoll?.(task);
  }
  const staged = [];
  if (stage) {
    if (task.kind !== "code" || task.mode !== "full-file") {
      throw new WfaError("STAGE_REQUIRES_FULL_FILE", "--stage requires a completed wfa code --mode full-file task.");
    }
    const targets = selected ? [selected] : Object.keys(task.children ?? {});
    for (const p of targets) {
      if (task.children[p]?.state === "completed" && task.children[p]?.resultPath) {
        staged.push(await stageTaskFiles(taskId, { provider: p, home, store }));
      }
    }
  }
  return { task, staged, collected };
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
    child.revision = (child.revision ?? 0) + 1;
    task.state = summarizeTask(task).state;
    task.updatedAt = new Date().toISOString();
    return task;
  });
}
