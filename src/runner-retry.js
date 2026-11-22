import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, spawnDetached, resolveAskBridge } from "./ask-bridge.js";
import { readBatchMetadata } from "./metadata.js";
import { classifyProviderError } from "./provider-errors.js";
import { detectSessionIsolationWarning, mapProviderErrorState, rememberSession, summarizeTask } from "./state.js";
import { guardedBatch, refreshTask } from "./runner-stall.js";
import { Store } from "./store.js";
import { loadConfig } from "./config.js";
import { geminiTaskModeNeeded, startGeminiTaskModeForTask } from "./gemini-mode.js";
import { DEFAULT_STALL_TIMEOUT_SECONDS } from "./constants.js";
import { WfaError } from "./errors.js";
import { startHeartbeat } from "./util.js";

const TAB_CLOSED = /list_pages failed|selected page has been closed/i;
const WORKER_PATH = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));

function argsFor(config, inputFile, outputDir, concurrency = 1) {
  return ["--backend", "browser", `--headless=${config.browserMode !== "headful"}`,
    "batch", "--input", inputFile, "--concurrency", String(concurrency), "--output-dir", outputDir];
}

async function saveResult({ store, task, provider, result, processResult, retry = false, logPaths }) {
  await store.transaction(({ tasks, sessions }) => {
    const current = tasks.tasks[task.taskId];
    const child = current.children[provider];
    if (["completed", "abandoned", "failed_before_start"].includes(child.state) && !retry) return;
    const previous = { state: child.state, thread: child.threadUrl, result: child.resultPath };
    const classified = classifyProviderError({
      error: result.error, stderr: processResult.stderr ?? "", jobId: child.jobId,
      state: result.state, hasResponse: Boolean(result.responsePath),
    });
    child.state = mapProviderErrorState(result.state, classified, Boolean(result.responsePath));
    child.threadUrl = result.threadUrl ?? child.threadUrl;
    child.error = result.error;
    child.resultPath = result.responsePath ?? child.resultPath;
    child.errorCode = classified.errorCode;
    child.degradedReason = classified.degraded ? classified.errorCode : null;
    child.recoveryHint = classified.recoveryHint;
    child.retryAfterSeconds = classified.retryAfterSeconds;
    child.retryAfterAt = classified.retryAfterAt;
    child.retryAfterEstimated = classified.retryAfterEstimated;
    child.elapsedSeconds = result.elapsedSeconds;
    child.pageId = result.pageId;
    child.childPid = processResult.childMayRun ? processResult.pid : null;
    // guardedBatch already vetoed silence against ask-bridge's browser log and
    // killed the batch; that verdict has to survive the metadata write, which
    // still says in_progress because no provider ever answered.
    const stall = processResult.stalled?.[provider];
    if (stall && !result.trustedCompletion
      && !["completed", "repo_unreadable", "abandoned"].includes(child.state)) {
      child.state = "stalled";
      child.stall = stall;
      child.error = `No progress line or metadata update for ${stall.silentSeconds} seconds, and ask-bridge's browser log was silent for the same period. Submission may have occurred; check the conversation before resending. A long generation looks identical from here, so raise --stall-timeout if the answer was still being written.`;
      child.recoveryHint = `Run wfa collect ${task.taskId} --provider ${provider} or wfa resolve ${task.taskId} --provider ${provider} --confirm after checking the browser.`;
    }
    if (retry) {
      child.retriedAsSingleBatch = true;
      child.retryLogs = logPaths;
      current.retryWarnings = [...(current.retryWarnings ?? []),
        `Retried ${provider} as a single batch because ask-bridge closed its tab before submission.`];
    } else if (logPaths) {
      child.batchLogs = logPaths;
    }
    if (result.trustedCompletion && result.completionProof) {
      child.completionProof = result.completionProof;
      child.collectionSource = "ask-bridge-batch-terminal";
      child.collectedAt = result.completionProof.verifiedAt;
      child.responseHeuristics = result.responseHeuristics ?? null;
    }
    if (result.trustedCompletion && result.state === "completed") {
      child.sessionIsolationWarning = detectSessionIsolationWarning(tasks.tasks, current, provider, result.threadUrl);
      if (result.threadUrl) rememberSession(tasks.tasks, sessions, current, provider);
    }
    if (child.state !== previous.state || child.threadUrl !== previous.thread || child.resultPath !== previous.result || retry) {
      child.revision = (child.revision ?? 0) + 1;
    }
    current.state = summarizeTask(current).state;
    current.processExitCode = processResult.code;
    current.processSignal = processResult.signal ?? null;
    current.processTimedOut = Boolean(processResult.timedOut);
    current.processStdioDrainTimedOut = Boolean(processResult.stdioDrainTimedOut);
    if (processResult.processError) current.processWarning = `ask-bridge failed after launch: ${processResult.processError.message}.`;
    else if (processResult.timedOut) current.processWarning = "ask-bridge exceeded its watchdog; inspect unresolved providers before any resend.";
    else if (processResult.code !== 0) current.processWarning = `ask-bridge batch exited with code ${processResult.code}${processResult.signal ? ` (${processResult.signal})` : ""}. Per-provider artifacts are authoritative.`;
    current.updatedAt = new Date().toISOString();
  });
}

async function runOne({ command, task, job, config, timeoutSeconds, store, run, input, retry = false }) {
  const provider = job.provider;
  const inputFile = path.join(task.runDir, retry ? `jobs-retry-${provider}.jsonl` : `jobs-single-${provider}.jsonl`);
  const logPaths = {
    stdout: path.join(task.runDir, `batch.stdout.${provider}${retry ? ".retry" : ""}.log`),
    stderr: path.join(task.runDir, `batch.stderr.${provider}${retry ? ".retry" : ""}.log`),
  };
  await writeFile(inputFile, `${JSON.stringify(job)}\n`, { encoding: "utf8", mode: 0o600 });
  await store.transaction(({ tasks }) => {
    const current = tasks.tasks[task.taskId];
    const child = current.children[provider];
    if (child.state === "queued" || child.state === "failed_before_start") child.state = "running";
    current.updatedAt = new Date().toISOString();
  });
  const result = await run(command, argsFor(config, inputFile, task.outputDir), {
    cwd: task.workspaceRoot, inherit: false,
    timeoutMs: (timeoutSeconds + 180) * 1000,
    onStdoutLine: (line) => input.onProgressLine?.("stdout", line),
    onStderrLine: (line) => input.onProgressLine?.("stderr", line),
    onSpawn: async (pid) => {
      await store.transaction(({ tasks }) => {
        const current = tasks.tasks[task.taskId];
        current.childPid = pid ?? null;
        current.children[provider].childPid = pid ?? null;
        current.updatedAt = new Date().toISOString();
      });
    },
  });
  await writeFile(logPaths.stdout, result.stdout ?? "", { encoding: "utf8", mode: 0o600 });
  await writeFile(logPaths.stderr, result.stderr ?? "", { encoding: "utf8", mode: 0o600 });
  if (!task.detached) {
    await appendFile(path.join(task.runDir, "batch.stdout.log"), result.stdout ?? "", "utf8").catch(() => {});
    await appendFile(path.join(task.runDir, "batch.stderr.log"), result.stderr ?? "", "utf8").catch(() => {});
  }
  if (result.spawnError) {
    const errorMessage = `Could not start ask-bridge: ${result.spawnError.message}`;
    await store.transaction(({ tasks }) => {
      const current = tasks.tasks[task.taskId];
      const child = current.children[provider];
      child.state = "failed_before_start";
      child.error = errorMessage;
      child.batchLogs = logPaths;
      child.revision = (child.revision ?? 0) + 1;
      current.childPid = null;
      current.state = summarizeTask(current).state;
      current.updatedAt = new Date().toISOString();
    });
    return { result: { state: "failed_before_start" }, processResult: result };
  }
  const metadata = await readBatchMetadata(task.outputDir, job.id, provider, { runDir: task.runDir });
  await saveResult({ store, task, provider, result: metadata, processResult: result, retry, logPaths });
  await store.transaction(({ tasks }) => {
    const current = tasks.tasks[task.taskId];
    current.childPid = result.childMayRun ? result.pid : null;
    if (!result.childMayRun) current.children[provider].childPid = null;
  });
  return { result: metadata, processResult: result };
}

// The Gemini landing mode is page state that only a live click can change, so
// whether it took effect is an observation, not a promise. Record what was
// actually seen on the task instead of reporting the run as clean.
async function recordGeminiMode(store, taskId, report) {
  if (!report) return;
  await store.transaction(({ tasks }) => {
    const current = tasks.tasks[taskId];
    if (!current) return;
    current.geminiModeReport = report;
    current.updatedAt = new Date().toISOString();
  });
}

/**
 * Run a batch with the Task-switch clicker attached when the task needs it.
 * The clicker can never throw, so it cannot turn a working run into a failure.
 */
async function withGeminiMode(task, store, log, execute) {
  const clicker = startGeminiTaskModeForTask(task, log);
  try {
    return await execute();
  } finally {
    await recordGeminiMode(store, task.taskId, await clicker?.stop());
  }
}

async function runSequential({ command, task, config, input, store, run, jobs, timeoutSeconds }) {
  let childMayRun = false;
  for (const job of jobs) {
    const { result, processResult } = await runOne({ command, task, job, config, timeoutSeconds, store, run, input });
    if (processResult.childMayRun || processResult.stalled) {
      childMayRun = Boolean(processResult.childMayRun);
      break; // A potentially submitted job is never automatically retried.
    }
    if (result.state === "failed" && TAB_CLOSED.test(String(result.error ?? ""))
      && !result.threadUrl && !result.responsePath) {
      input.onProgressLine?.("stdout", `[wfa] retrying ${job.provider} alone after pre-submit tab closure`);
      const retried = await runOne({ command, task, job, config, timeoutSeconds, store, run, input, retry: true });
      if (retried.processResult.childMayRun || retried.processResult.stalled) {
        childMayRun = Boolean(retried.processResult.childMayRun);
        break;
      }
    }
  }
  await store.transaction(({ tasks }) => {
    const current = tasks.tasks[task.taskId];
    current.childPid = childMayRun ? current.childPid : null;
    current.executionPending = childMayRun;
    for (const child of Object.values(current.children)) {
      if (child.state === "queued" || child.state === "running") {
        // If the batch process may still be alive it can still submit this job,
        // so "nothing was sent" is not proven; keep it locked until collected.
        child.state = childMayRun ? "interrupted_unknown" : "failed_before_start";
        child.error = childMayRun
          ? "A preceding batch may still be running; do not resend until its process exits."
          : "The preceding provider stopped before this job could be started. No prompt was sent.";
        if (childMayRun) child.childPid = current.childPid;
        child.revision = (child.revision ?? 0) + 1;
      }
    }
    current.state = summarizeTask(current).state;
    current.updatedAt = new Date().toISOString();
  });
}

async function runBatch({ command, task, config, input, store, run, jobs, timeoutSeconds }) {
  const result = await run(command, argsFor(config, task.inputFile, task.outputDir, task.concurrency), {
    cwd: task.workspaceRoot, inherit: false, timeoutMs: (timeoutSeconds + 180) * 1000,
    onStdoutLine: (line) => input.onProgressLine?.("stdout", line),
    onStderrLine: (line) => input.onProgressLine?.("stderr", line),
    onSpawn: async (pid) => {
      await store.transaction(({ tasks }) => {
        const current = tasks.tasks[task.taskId];
        current.childPid = pid ?? null;
        for (const child of Object.values(current.children)) child.childPid = pid ?? null;
        current.updatedAt = new Date().toISOString();
      });
    },
  });
  if (result.spawnError) {
    await store.transaction(({ tasks }) => {
      const current = tasks.tasks[task.taskId];
      current.state = "failed";
      current.processExitCode = null;
      current.executionPending = false;
      current.error = `Could not start ask-bridge: ${result.spawnError.message}`;
      for (const child of Object.values(current.children)) {
        child.state = "failed_before_start";
        child.error = current.error;
        child.revision = (child.revision ?? 0) + 1;
      }
      current.updatedAt = new Date().toISOString();
    });
    return;
  }
  await writeFile(path.join(task.runDir, "batch.stdout.log"), result.stdout ?? "", { encoding: "utf8", mode: 0o600 });
  await writeFile(path.join(task.runDir, "batch.stderr.log"), result.stderr ?? "", { encoding: "utf8", mode: 0o600 });
  for (const job of jobs) {
    const metadata = await readBatchMetadata(task.outputDir, job.id, job.provider, { runDir: task.runDir });
    await saveResult({ store, task, provider: job.provider, result: metadata, processResult: result });
  }
  await store.transaction(({ tasks }) => {
    const current = tasks.tasks[task.taskId];
    current.childPid = result.childMayRun ? result.pid : null;
    current.executionPending = Boolean(result.childMayRun);
    current.state = summarizeTask(current).state;
  });
  for (const job of jobs) {
    const metadata = await readBatchMetadata(task.outputDir, job.id, job.provider, { runDir: task.runDir });
    if (metadata.state !== "failed" || !TAB_CLOSED.test(String(metadata.error ?? ""))
      || metadata.threadUrl || metadata.responsePath) continue;
    input.onProgressLine?.("stdout", `[wfa] retrying ${job.provider} alone after pre-submit tab closure`);
    await runOne({ command, task, job, config, timeoutSeconds, store, run, input, retry: true });
  }
}

export async function executePreparedTask({ task, command, config, input, store, dependencies, createdJobs, workspaceRoot, timeoutSeconds }) {
  const serial = Boolean(input.sequentialBatches && task.concurrency === 1 && task.providers.length > 1);
  await store.transaction(({ tasks }) => {
    const current = tasks.tasks[task.taskId];
    current.state = "running";
    current.executionPending = true;
    current.serialWorker = Boolean(serial && input.detach);
    for (const child of Object.values(current.children)) {
      if (child.state === "queued" && (!serial || !input.detach)) {
        child.state = "running";
        child.revision = (child.revision ?? 0) + 1;
      }
    }
    current.updatedAt = new Date().toISOString();
  });

  if (input.detach) {
    const args = serial ? [WORKER_PATH, "__batch-worker", task.taskId, task.workerToken]
      : argsFor(config, task.inputFile, task.outputDir, task.concurrency);
    const spawnedCommand = serial ? process.execPath : command;
    let spawned;
    try {
      spawned = await (dependencies.spawnDetached ?? spawnDetached)(spawnedCommand, args, {
        cwd: workspaceRoot,
        env: serial ? { ...process.env, WFA_HOME: store.paths.home } : process.env,
        stdoutPath: path.join(task.runDir, "batch.stdout.log"),
        stderrPath: path.join(task.runDir, "batch.stderr.log"),
      });
      if (!Number.isInteger(spawned?.pid) || spawned.pid <= 0) {
        throw new WfaError("DETACHED_SPAWN_UNCONFIRMED", "The detached process has no verified PID.");
      }
    } catch (error) {
      await store.transaction(({ tasks }) => {
        const current = tasks.tasks[task.taskId];
        current.state = "failed";
        current.error = `Could not start detached worker: ${error.message}`;
        current.childPid = null;
        current.workerPid = null;
        current.executionPending = false;
        for (const child of Object.values(current.children)) {
          child.state = "failed_before_start";
          child.error = current.error;
          child.revision = (child.revision ?? 0) + 1;
        }
        current.updatedAt = new Date().toISOString();
      });
      const snapshot = await store.snapshot();
      return { task: snapshot.tasks.tasks[task.taskId], replayed: false, detached: false };
    }
    await store.transaction(({ tasks }) => {
      const current = tasks.tasks[task.taskId];
      if (serial) {
        current.workerPid = spawned.pid;
        // Recovery commands check parentPid; keep every queued provider locked
        // while the detached WFA coordinator is alive between two jobs.
        current.parentPid = spawned.pid;
      } else current.childPid = spawned.pid;
      current.executionPending = true;
      if (!serial) for (const child of Object.values(current.children)) child.childPid = spawned.pid;
      current.updatedAt = new Date().toISOString();
    });
    if (!serial) {
      // A detached plain batch is ask-bridge's own process: no coordinator
      // survives here to hold a debugging session open, so this mode cannot
      // press the switch and must not pretend it did.
      await recordGeminiMode(store, task.taskId, geminiTaskModeNeeded(task) ? {
        requested: "task", applied: false, clickedAt: null, pageUrl: null, clicks: 0,
        error: "detached batch has no coordinator process to press the Task switch; run without --detach or with --concurrency 1",
      } : null);
    }
    const snapshot = await store.snapshot();
    return { task: snapshot.tasks.tasks[task.taskId], replayed: false, detached: true };
  }

  const run = dependencies.runProcess ?? runProcess;
  await withGeminiMode(task, store, (line) => input.onProgressLine?.("stdout", line), async () => {
    if (serial) await runSequential({ command, task, config, input, store, run, jobs: createdJobs, timeoutSeconds });
    else await runBatch({ command, task, config, input, store, run, jobs: createdJobs, timeoutSeconds });
  });
  // The batch result is not the task result: repository readability, stall
  // promotion and session checks all live in refreshTask, and they used to run
  // inside the deleted PolicyStore transaction after every write. Refresh once
  // here so a foreground run returns the same task state a later `status` shows.
  const refreshed = await refreshTask(task.taskId, { home: store.paths.home, store });
  return { task: refreshed, replayed: false };
}

// A detached serial request must remain under WFA's control: the upstream
// executable cannot safely sequence two jobs in the same batch. This private
// child command has no user-facing CLI contract and exits on terminal state.
export async function runDetachedBatchWorker(taskId, workerToken, { home, store = new Store(home), config } = {}) {
  // Claim is atomic across processes. Even a second invocation with the right
  // token cannot resubmit a job that the first worker may already have sent.
  const task = await store.transaction(({ tasks }) => {
    const current = tasks.tasks[taskId];
    if (!current || !current.detached || !current.serialWorker
      || !current.workerToken || current.workerToken !== workerToken
      || current.workerClaimedAt) {
      throw new WfaError("INVALID_BATCH_WORKER", "Detached worker is missing, unauthorized, or already claimed; refusing duplicate submission.");
    }
    current.workerClaimedAt = new Date().toISOString();
    current.heartbeatAt = current.workerClaimedAt;
    current.updatedAt = current.workerClaimedAt;
    return current;
  });
  const settings = config ?? await loadConfig(home);
  const jobs = (await readFile(task.inputFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  if (jobs.length !== task.providers.length || jobs.some((job, i) => job.provider !== task.providers[i])) {
    throw new WfaError("INVALID_BATCH_WORKER", "Detached task input does not match the persisted provider list.");
  }
  const command = resolveAskBridge(settings);
  const run = (cmd, args, options) => guardedBatch(runProcess, cmd, args, options, store, task.stallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS);
  const heartbeat = startHeartbeat({ taskId, store });
  // The worker's own stdout is the detached task's batch log. Forwarding
  // provider lines keeps that log honest: otherwise it stays at zero bytes for
  // the whole run and an empty log looks like "nothing was ever submitted".
  const writeLine = (stream, line) => {
    const target = stream === "stderr" ? process.stderr : process.stdout;
    try { target.write(`${line}\n`); } catch {}
  };
  try {
    await withGeminiMode(task, store, (line) => writeLine("stdout", line), () => runSequential({
      command, task, config: settings, input: { onProgressLine: writeLine }, store, run, jobs, timeoutSeconds: task.timeoutSeconds,
    }));
    return 0;
  } finally {
    heartbeat.stop();
    await store.transaction(({ tasks }) => {
      const current = tasks.tasks[taskId];
      if (current) {
        current.workerPid = null;
        current.updatedAt = new Date().toISOString();
      }
    });
  }
}
