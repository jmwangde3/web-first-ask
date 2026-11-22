import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.js";
import { WfaError } from "./errors.js";
import { isPidAlive, owningProcessAlive } from "./util.js";
import { readBatchMetadata } from "./metadata.js";
import { classifyProviderError } from "./provider-errors.js";
import { UPSTREAM_TERMINAL_STATES, detectSessionIsolationWarning, detectThreadMismatch, mapProviderErrorState, rememberSession, summarizeTask } from "./state.js";
import { createStallWatch, browserIdleMs, browserStillWorking } from "./stall-watch.js";
import { chromeLogPath } from "./ask-bridge.js";
import { matchRepoUnreadable, repositoryFallbackCommand } from "./repository.js";

// Both logs missing means the path is wrong, not that the batch was silent, so
// at least one file has to exist before an empty pair is treated as evidence.
// Empty logs are also not proof of "never submitted" on their own: a detached
// serial worker runs ask-bridge itself and writes provider output to per-job
// logs only after each job ends, so the pair stays empty for the whole run.
// Callers must combine this with per-job submission evidence (see refreshTask).
async function batchLogText(runDir) {
  if (!runDir) return null;
  const parts = [];
  let present = false;
  for (const name of ["batch.stdout.log", "batch.stderr.log"]) {
    const info = await lstat(path.join(runDir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    present = true;
    parts.push(await readFile(path.join(runDir, name), "utf8").catch(() => ""));
  }
  return present ? parts.join("\n") : null;
}

// A detached task runs its own batch process; the foreground guard that watches
// progress lines is not alive for it, so a quiet job is only visible to a
// refresh. This used to sit in PolicyStore.transaction, where every write of any
// task (including a heartbeat) could scan the whole ledger and SIGTERM another
// task's pid. Refresh is the place that actually asks "is this task still
// alive", so the check lives here now.
async function detachedStallEvidence(task) {
  // A serial worker has its own guarded per-job watchdog; killing the worker
  // from a stale aggregate log would strand its next, as-yet-unsent provider.
  if (task.serialWorker || !task.detached || !task.executionPending || !task.childPid
    || !Number.isInteger(task.stallTimeoutSeconds) || task.stallTimeoutSeconds === 0) return null;
  const logPath = path.join(task.runDir, "batch.stdout.log");
  const logInfo = await lstat(logPath).catch(() => null);
  const log = logInfo?.isFile() ? await readFile(logPath, "utf8").catch(() => "") : "";
  const evidence = {};
  for (const [provider, child] of Object.entries(task.children ?? {})) {
    if (["completed", "abandoned", "failed_before_start", "stalled", "repo_unreadable"].includes(child.state)) continue;
    const metadataPath = path.join(task.outputDir, child.jobId, "metadata.json");
    const info = await lstat(metadataPath).catch(() => null);
    let state = null;
    if (info?.isFile()) {
      try { state = JSON.parse(await readFile(metadataPath, "utf8")).state; } catch {}
    }
    if (UPSTREAM_TERMINAL_STATES.has(state)) continue;
    const relevantLines = log.split(/\r?\n/).filter((line) => line.includes(child.jobId));
    const lastLine = relevantLines.at(-1) ?? null;
    if (!["in_progress", "running"].includes(state) && !relevantLines.some((line) => /\brunning\b/i.test(line))) continue;
    let lastLife = Math.max(Date.parse(task.createdAt ?? "") || 0, info?.mtimeMs || 0,
      Date.parse(child.watchLastLifeAt ?? "") || 0);
    if (relevantLines.length > (child.watchProgressCount ?? relevantLines.length)) lastLife = Date.now();
    child.watchProgressCount = relevantLines.length;
    if (info?.mtimeMs !== (child.watchMetadataMtime ?? info?.mtimeMs)) lastLife = Date.now();
    child.watchMetadataMtime = info?.mtimeMs ?? null;
    child.watchLastLifeAt = new Date(lastLife).toISOString();
    const silentSeconds = Math.floor((Date.now() - lastLife) / 1000);
    if (silentSeconds >= task.stallTimeoutSeconds) {
      evidence[provider] = { silentSeconds, lastProgressLine: lastLine?.slice(0, 500) ?? null,
        metadataMtime: info?.mtimeMs ?? null };
    }
  }
  if (!Object.keys(evidence).length) return null;
  // Same veto as the per-job watchdog: the batch log staying quiet proves
  // nothing while ask-bridge's browser log is still being written.
  const idleMs = await browserIdleMs(chromeLogPath());
  if (browserStillWorking(idleMs)) return null;
  let killedPid = null;
  if (task.childPid !== process.pid) {
    try {
      process.kill(task.childPid, "SIGTERM");
      killedPid = task.childPid;
    } catch {}
  }
  return { stalls: evidence, killedPid };
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
  let vetoed = false;
  let lastBeatAt = Date.now();
  const browserLog = chromeLogPath();
  let resolveFallback;
  let afterKillTimer = null;
  const fallback = new Promise((resolve) => { resolveFallback = resolve; });
  const tick = async () => {
    if (stopped || stalled) return;
    if (Date.now() - lastBeatAt >= (options.heartbeatMs ?? 60000)) {
      lastBeatAt = Date.now();
      const active = watch.snapshot().filter((item) => item.active);
      if (active.length) {
        options.onStdoutLine?.(`[wfa] still waiting: ${active.map((item) => `${item.provider} quiet ${item.idleSeconds}s`).join(", ")} (stall limit ${timeoutSeconds}s). ask-bridge prints nothing while a page generates; if this line stops appearing, the run is gone.`);
      }
    }
    const evidence = await watch.check();
    if (!evidence || stopped) return;
    // ask-bridge emits no stdout and no metadata update while a page generates,
    // so silence alone is not a stall: a 400-line answer looks exactly like a
    // hung tab for five minutes. Check the browser log, which ask-bridge appends
    // to on every tool call, before killing work that may be nearly done.
    const idleMs = await browserIdleMs(browserLog);
    if (browserStillWorking(idleMs)) {
      if (!vetoed) {
        vetoed = true;
        const provider = Object.keys(evidence)[0];
        options.onStdoutLine?.(`[wfa] ${provider} has produced no output for ${evidence[provider].silentSeconds}s, but ask-bridge's browser log moved ${Math.round(idleMs / 1000)}s ago; still waiting instead of treating it as a stall`);
      }
      return;
    }
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

    const detectedStall = await detachedStallEvidence(task);
    const detachedStall = detectedStall?.stalls;
    if (detectedStall?.killedPid) {
      task.killedStalledPids ??= [];
      if (!task.killedStalledPids.includes(detectedStall.killedPid)) {
        task.killedStalledPids.push(detectedStall.killedPid);
      }
    }
    // Submission evidence is per job. A serial detached run starts one provider
    // after another; treating "some provider was submitted" as "every queued
    // provider may have been submitted" locked a provider that never ran.
    const sawSubmission = {};
    for (const [providerKey, child] of Object.entries(task.children ?? {})) {
      const provider = child.provider ?? providerKey;
      if (child.state === "abandoned") continue;
      // A child that already has a verified result still needs the repository
      // and session checks below, so it must not be skipped outright: only its
      // metadata read is skipped, because the artifact on disk is authoritative.
      const alreadyCompleted = child.state === "completed" && Boolean(child.resultPath);
      if (alreadyCompleted) sawSubmission[provider] = true;

      const metadata = alreadyCompleted
        ? {} : await readBatchMetadata(task.outputDir, child.jobId, provider, { runDir: task.runDir });
      // A terminal artifact, a conversation URL, or even a parsed metadata
      // file means ask-bridge got as far as this job. That is enough to refuse
      // the "never started" verdict below: a wrong "safe to resend" is worse
      // than an extra resolve.
      if (child.threadUrl || child.resultPath || child.completionProof
        || metadata.threadUrl || metadata.responsePath || metadata.metadata) {
        sawSubmission[provider] = true;
      }
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
        child.state = mapProviderErrorState(child.state, classified, Boolean(metadata.responsePath));
      }

      // REPO_UNREADABLE is a provider answer, not a failure: the conversation
      // exists and can be continued, but the code was written against a guessed
      // tree. Detect it once, after completion, when the result is on disk.
      if (!task.bundleRepo && task.repoReference && child.state === "completed"
        && child.resultPath && !child.repoChecked) {
        const body = await readFile(child.resultPath, "utf8").catch(() => "");
        const matched = matchRepoUnreadable(body);
        child.repoChecked = true;
        if (matched && (child.completionProof || child.collectionSource === "manual-confirmed-get")) {
          child.repoUnreadable = true;
          child.repoUnreadableEvidence = matched;
          child.repoFallbackCommand = repositoryFallbackCommand(taskId, provider, task.workspace, task.kind);
          child.recoveryHint = `Repository unreadable. Run: ${child.repoFallbackCommand}`;
          child.state = "repo_unreadable";
        }
      }
      // A completed child that was already judged unreadable must not lose that
      // verdict on the next refresh, when repoChecked is already true.
      if (child.repoUnreadable && child.state === "completed") child.state = "repo_unreadable";
      // A fresh task landing on the previous thread, or a continuation landing
      // on a different one, is a real signal about where the answer came from.
      // detectSessionIsolationWarning covers the legacy-record case on the
      // completion path; this covers everything refresh can observe.
      if (child.threadUrl && !child.threadMismatch) {
        const mismatch = detectThreadMismatch(task, provider, child.threadUrl);
        if (mismatch) child.threadMismatch = mismatch;
      }
      const stall = detachedStall?.[provider];
      if (stall && !["completed", "repo_unreadable", "abandoned", "stalled"].includes(child.state)) {
        child.state = "stalled";
        child.stall = stall;
        child.error = `No progress line or metadata update for ${stall.silentSeconds} seconds, and ask-bridge's browser log was silent for the same period. Submission may have occurred; check the conversation before resending. A long generation looks identical from here, so raise --stall-timeout if the answer was still being written.`;
        child.recoveryHint = `Run wfa collect ${taskId} --provider ${provider} or wfa resolve ${taskId} --provider ${provider} --confirm after checking the browser.`;
      }
      // A wrong thread URL must never stay in sessions.json, or the next
      // `--continue-session` run inherits the same mistake.
      if (child.threadMismatch || child.repoUnreadable) {
        const current = sessions.workspaces?.[task.workspace]?.[provider];
        if (current === child.threadUrl) {
          const original = task.sessionBaseline?.[provider] ?? null;
          if (original && original !== child.threadUrl) sessions.workspaces[task.workspace][provider] = original;
          else delete sessions.workspaces[task.workspace][provider];
        }
      }
      if (child.state !== previousState || child.threadUrl !== previousThread
        || child.resultPath !== previousResult
        || (child.completionProof?.responseSha256 ?? null) !== previousProofHash) {
        child.revision = (child.revision ?? 0) + 1;
      }
    }

    if (!processAlive) {
      // Empty logs are weak evidence: a detached serial worker keeps them at
      // zero bytes even after the prompt reached a page, because ask-bridge is
      // captured by the worker instead of writing to the batch logs. A job is
      // only "never started" when the detached batch printed nothing at all and
      // it has no submission artifact of its own. Any banner, even one that does
      // not name this job, means ask-bridge came up; then a resend is not safe.
      const batchLog = await batchLogText(task.runDir);
      for (const [providerKey, child] of Object.entries(task.children ?? {})) {
        const provider = child.provider ?? providerKey;
        if (child.state !== "queued" && child.state !== "running") continue;
        const neverStarted = task.detached === true && batchLog !== null
          && !batchLog.trim() && !sawSubmission[provider];
        child.state = neverStarted ? "failed_before_start" : "interrupted_unknown";
        child.error = neverStarted
          ? "The detached worker was killed before ask-bridge printed anything: the batch logs are empty and no metadata, thread URL, or result exists. Nothing reached a provider, so this job can be retried. The host that launched wfa clears background processes when its own task ends; run wfa in the foreground, or keep wfa itself in the background instead of using --detach."
          : "ask-bridge process is no longer running and no trusted terminal artifact was found. The prompt may already have been submitted; do not resend.";
        if (neverStarted) {
          // Not a provider failure: there is no provider verdict to classify,
          // and the generic "do not resend" hint contradicts a run that never
          // sent anything.
          child.errorCode = null;
          child.recoveryHint = null;
          child.retryAfterAt = null;
          child.retryAfterSeconds = null;
        }
        child.revision = (child.revision ?? 0) + 1;
      }
    }
    task.state = summarizeTask(task).state;
    task.updatedAt = new Date().toISOString();
    return task;
  });
}
