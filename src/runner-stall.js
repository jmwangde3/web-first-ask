import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.js";
import { WfaError } from "./errors.js";
import { isPidAlive, owningProcessAlive } from "./util.js";
import { readBatchMetadata } from "./metadata.js";
import { classifyProviderError } from "./provider-errors.js";
import { detectSessionIsolationWarning, rememberSession, summarizeTask } from "./state.js";
import { createStallWatch } from "./stall-watch.js";

function stateFromProviderError(state, classified) {
  if (state !== "failed" && state !== "failed_before_start") return state;
  if (classified.errorCode === "RATE_LIMITED") return "rate_limited";
  if (classified.errorCode === "LOGIN_REQUIRED") return "login_required";
  if (classified.errorCode === "CLOUDFLARE_BLOCKED") return "cloudflare_blocked";
  return state;
}

// Both the synchronous CLI and the detached worker use this guard. Progress is
// accumulated independently of runProcess, so a forced settlement never loses
// the text already streamed by the child.
export async function guardedBatch(run, command, args, options, store, timeoutSeconds) {
  if (!timeoutSeconds || !args.includes("batch")) return run(command, args, options);
  const inputFile = args[args.indexOf("--input") + 1];
  const outputDir = args[args.indexOf("--output-dir") + 1];
  const jobs = (await readFile(inputFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const taskId = path.basename(path.dirname(inputFile));
  const watch = createStallWatch(jobs, outputDir, timeoutSeconds);
  const controller = new AbortController();
  const stdoutLines = [];
  const stderrLines = [];
  let accumulatedStdout = "";
  let accumulatedStderr = "";
  const mergeCaptured = (saved, streamed) => {
    if (!saved) return streamed;
    if (!streamed || saved.includes(streamed)) return saved;
    if (streamed.includes(saved)) return streamed;
    return `${saved}\n${streamed}`;
  };
  const collectedStdout = () => mergeCaptured(accumulatedStdout, stdoutLines.join("\n"));
  const collectedStderr = () => mergeCaptured(accumulatedStderr, stderrLines.join("\n"));
  let pid = null;
  let stalled = null;
  let stopped = false;
  let resolveFallback;
  let afterKillTimer = null;
  const fallback = new Promise((resolve) => { resolveFallback = resolve; });
  const tick = async () => {
    if (stopped || stalled) return;
    const evidence = await watch.check();
    if (!evidence || stopped) return;
    stalled = evidence;
    store.stalls?.set(taskId, { ...(store.stalls.get(taskId) ?? {}), ...evidence });
    controller.abort();
    if (pid && pid !== process.pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    afterKillTimer = setTimeout(() => resolveFallback({
      code: null, signal: "SIGTERM", stdout: collectedStdout(), stderr: collectedStderr(),
      spawnError: null, childMayRun: Boolean(pid && isPidAlive(pid)), pid, stalled: evidence,
    }), 6000);
    // This timer is only a fallback for mocks/upstream that do not settle when
    // aborted. The actual child/streams keep the event loop alive until then.
    afterKillTimer.unref?.();
  };
  const wrapped = {
    ...options,
    abortSignal: controller.signal,
    onSpawn: async (value) => { pid = value; await options.onSpawn?.(value); },
    onStdout: (value) => { accumulatedStdout = value; options.onStdout?.(value); },
    onStderr: (value) => { accumulatedStderr = value; options.onStderr?.(value); },
    onStdoutLine: (line) => { stdoutLines.push(line); watch.progress(line); options.onStdoutLine?.(line); },
    onStderrLine: (line) => { stderrLines.push(line); watch.progress(line); options.onStderrLine?.(line); },
  };
  const interval = setInterval(() => { void tick().catch(() => {}); }, 1000);
  try {
    const result = await Promise.race([run(command, args, wrapped), fallback]);
    return {
      ...result,
      stdout: mergeCaptured(result.stdout, collectedStdout()),
      stderr: mergeCaptured(result.stderr, collectedStderr()),
      stalled: result.stalled ?? stalled,
    };
  } finally {
    stopped = true;
    clearInterval(interval);
    clearTimeout(afterKillTimer);
  }
}

export async function refreshTask(taskId, { home, store = new Store(home) } = {}) {
  return store.transaction(async ({ tasks, sessions }) => {
    const task = tasks.tasks[taskId];
    if (!task) throw new WfaError("TASK_NOT_FOUND", `Task not found: ${taskId}`);

    const processAlive = isPidAlive(task.childPid) || isPidAlive(task.workerPid)
      || (task.processExitCode == null && ["preparing", "running"].includes(task.state) && owningProcessAlive(task));
    if (processAlive) {
      task.executionPending = true;
    } else if (task.executionPending) {
      task.executionPending = false;
      task.executionEndedAt = new Date().toISOString();
    }

    for (const [providerKey, child] of Object.entries(task.children ?? {})) {
      const provider = child.provider ?? providerKey;
      if (["abandoned", "failed_before_start"].includes(child.state)) continue;
      if (child.state === "completed" && child.resultPath) continue;

      const metadata = await readBatchMetadata(task.outputDir, child.jobId, provider, { runDir: task.runDir });
      const previousState = child.state;
      const previousThread = child.threadUrl;
      const previousResult = child.resultPath;
      const previousProofHash = child.completionProof?.responseSha256 ?? null;

      if (metadata.threadUrl && !child.threadUrl) child.threadUrl = metadata.threadUrl;
      if (metadata.trustedCompletion && metadata.state === "completed" && metadata.responsePath) {
        child.state = "completed";
        child.threadUrl = metadata.threadUrl ?? child.threadUrl;
        child.resultPath = metadata.responsePath;
        child.completionProof = metadata.completionProof;
        child.collectionSource = "ask-bridge-batch-terminal";
        child.collectedAt = metadata.completionProof.verifiedAt;
        child.responseHeuristics = metadata.responseHeuristics ?? null;
        child.sessionIsolationWarning = detectSessionIsolationWarning(tasks.tasks, task, provider, metadata.threadUrl);
        child.error = null;
        child.errorCode = null;
        child.recoveryHint = null;
        if (child.threadUrl) rememberSession(tasks.tasks, sessions, task, provider);
      } else if (["failed", "timed_out", "recoverable", "cancelled"].includes(metadata.state)
        && ["queued", "running", "interrupted_unknown"].includes(child.state)) {
        child.state = metadata.state;
        child.error = metadata.error;
      }

      if (metadata.error || metadata.state === "failed") {
        const logs = [
          child.retryLogs?.stderr,
          child.batchLogs?.stderr,
          path.join(task.runDir, "batch.stderr.log"),
        ].filter(Boolean);
        const stderr = (await Promise.all(logs.map((log) => readFile(log, "utf8").catch(() => "")))).join("\n");
        const classified = classifyProviderError({
          error: metadata.error,
          stderr,
          jobId: child.jobId,
          state: metadata.state,
          hasResponse: Boolean(metadata.responsePath),
        });
        child.errorCode = classified.errorCode;
        child.recoveryHint = classified.recoveryHint;
        child.retryAfterSeconds = classified.retryAfterSeconds;
        child.retryAfterAt = classified.retryAfterAt;
        child.retryAfterEstimated = classified.retryAfterEstimated;
        child.state = stateFromProviderError(child.state, classified);
      }
      if (child.state !== previousState || child.threadUrl !== previousThread
        || child.resultPath !== previousResult
        || (child.completionProof?.responseSha256 ?? null) !== previousProofHash) {
        child.revision = (child.revision ?? 0) + 1;
      }
    }

    if (!processAlive) {
      for (const child of Object.values(task.children ?? {})) {
        if (child.state === "queued" || child.state === "running") {
          child.state = "interrupted_unknown";
          child.error = "ask-bridge process is no longer running and no trusted terminal artifact was found. The prompt may already have been submitted; do not resend.";
          child.revision = (child.revision ?? 0) + 1;
        }
      }
    }
    task.state = summarizeTask(task).state;
    task.updatedAt = new Date().toISOString();
    return task;
  });
}
