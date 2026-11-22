import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.js";
import { matchRepoUnreadable, repositoryFallbackCommand } from "./repository.js";
import { summarizeTask, workspaceSessions } from "./state.js";
import { browserIdleMs, browserStillWorking } from "./stall-watch.js";
import { chromeLogPath } from "./ask-bridge.js";

async function detectDetachedStall(task) {
  // A serial worker has its own guarded per-job watchdog; killing the worker
  // from a stale aggregate log would strand its next, as-yet-unsent provider.
  if (task.serialWorker || !task.detached || !task.executionPending || !task.childPid
    || !Number.isInteger(task.stallTimeoutSeconds) || task.stallTimeoutSeconds === 0) return null;
  const logPath = path.join(task.runDir, "batch.stdout.log");
  const logInfo = await stat(logPath).catch(() => null);
  const log = logInfo?.isFile() ? await readFile(logPath, "utf8").catch(() => "") : "";
  const evidence = {};
  for (const [provider, child] of Object.entries(task.children ?? {})) {
    if (["completed", "abandoned", "failed_before_start", "stalled", "repo_unreadable"].includes(child.state)) continue;
    const metadataPath = path.join(task.outputDir, child.jobId, "metadata.json");
    const info = await stat(metadataPath).catch(() => null);
    let state = null;
    if (info?.isFile()) {
      try { state = JSON.parse(await readFile(metadataPath, "utf8")).state; } catch {}
    }
    if (["completed", "failed", "timed_out", "recoverable", "cancelled"].includes(state)) continue;
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
  if (task.childPid !== process.pid) {
    try { process.kill(task.childPid, "SIGTERM"); } catch {}
  }
  return evidence;
}

export class PolicyStore extends Store {
  constructor(home) {
    super(home);
    this.intent = null;
    this.stalls = new Map();
    this.allowUnreadableFollowup = null;
  }

  async snapshot() {
    const snapshot = await super.snapshot();
    if (this.allowUnreadableFollowup) {
      const parent = snapshot.tasks.tasks[this.allowUnreadableFollowup.taskId];
      const child = parent?.children?.[this.allowUnreadableFollowup.provider];
      if (child?.repoUnreadable && child.state === "repo_unreadable" && (child.completionProof || child.collectionSource === "manual-confirmed-get") && !child.threadMismatch) {
        child.state = "completed";
      }
    }
    return snapshot;
  }

  async transaction(callback) {
    return super.transaction(async (state) => {
      const before = new Set(Object.keys(state.tasks.tasks));
      let borrowed = null;
      if (this.allowUnreadableFollowup) {
        const { taskId, provider } = this.allowUnreadableFollowup;
        const child = state.tasks.tasks[taskId]?.children?.[provider];
        if (child?.state === "repo_unreadable" && child.repoUnreadable
          && (child.completionProof || child.collectionSource === "manual-confirmed-get") && !child.threadMismatch) {
          borrowed = child;
          child.state = "completed";
        }
      }
      let result;
      try { result = await callback(state); }
      finally { if (borrowed) borrowed.state = "repo_unreadable"; }
      for (const [id, task] of Object.entries(state.tasks.tasks)) {
        if (!before.has(id) && this.intent && task.state === "preparing") {
          task.sessionPolicy = this.intent.sessionPolicy;
          task.sessionBaseline = workspaceSessions(
            Object.fromEntries(Object.entries(state.tasks.tasks).filter(([key]) => key !== id)),
            state.sessions, task.workspace, task.providers,
          );
          if (this.intent.followupTaskId) {
            const parent = state.tasks.tasks[this.intent.followupTaskId];
            for (const provider of task.providers) {
              if (parent?.children?.[provider]?.threadUrl) task.sessionBaseline[provider] = parent.children[provider].threadUrl;
            }
          }
          task.stallTimeoutSeconds = this.intent.stallTimeoutSeconds;
          task.bundleRepo = Boolean(this.intent.bundleRepo);
          task.repoReference = !task.bundleRepo && this.intent.repository?.available ? {
            url: this.intent.repository.url, branch: this.intent.repository.branch, commit: this.intent.repository.commit,
            warnings: this.intent.repository.warnings ?? [],
          } : null;
        }
        if (!task.children) continue;
        const detachedStall = await detectDetachedStall(task);
        if (detachedStall) this.stalls.set(id, { ...(this.stalls.get(id) ?? {}), ...detachedStall });
        let changed = false;
        for (const [provider, child] of Object.entries(task.children)) {
          if (!task.bundleRepo && task.repoReference && child.state === "completed" && child.resultPath && !child.repoChecked) {
            const body = await readFile(child.resultPath, "utf8").catch(() => "");
            const matched = matchRepoUnreadable(body);
            child.repoChecked = true;
            if (matched && (child.completionProof || child.collectionSource === "manual-confirmed-get")) {
              child.repoUnreadable = true;
              child.repoUnreadableEvidence = matched;
              child.repoFallbackCommand = repositoryFallbackCommand(id, provider, task.workspace, task.kind);
              child.recoveryHint = `Repository unreadable. Run: ${child.repoFallbackCommand}`;
            }
          }
          if (child.threadUrl && task.sessionBaseline) {
            const expected = task.sessionBaseline[provider] ?? null;
            if (task.sessionPolicy === "fresh" && expected === child.threadUrl) {
              child.threadMismatch = {
                expected: "a new conversation (not the previous workspace thread)", actual: child.threadUrl,
              };
            } else if (task.sessionPolicy === "continue" && expected && expected !== child.threadUrl) {
              child.threadMismatch = { expected, actual: child.threadUrl };
            }
          }
          const stall = this.stalls.get(id)?.[provider];
          if (stall && child.state !== "completed" && child.state !== "repo_unreadable" && child.state !== "abandoned") {
            child.state = "stalled";
            child.stall = stall;
            child.error = `No progress line or metadata update for ${stall.silentSeconds} seconds, and ask-bridge's browser log was silent for the same period. Submission may have occurred; check the conversation before resending. A long generation looks identical from here, so raise --stall-timeout if the answer was still being written.`;
            child.recoveryHint = `Run wfa collect ${id} --provider ${provider} or wfa resolve ${id} --provider ${provider} --confirm after checking the browser.`;
            changed = true;
          } else if (child.repoUnreadable && child.state === "completed") {
            child.state = "repo_unreadable";
            changed = true;
          }
          if (child.threadMismatch || child.repoUnreadable) {
            const currentSession = state.sessions.workspaces?.[task.workspace]?.[provider];
            if (currentSession === child.threadUrl) {
              const original = task.sessionBaseline?.[provider] ?? null;
              if (original && original !== child.threadUrl) state.sessions.workspaces[task.workspace][provider] = original;
              else delete state.sessions.workspaces[task.workspace][provider];
            }
          }
        }
        if (changed) task.state = summarizeTask(task).state;
      }
      return result;
    });
  }
}
