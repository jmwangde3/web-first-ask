import { mkdir, stat, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.js";
import { getPaths } from "./paths.js";
import { loadConfig } from "./config.js";
import { buildJobs, normalizeProviders, resolveAttachmentPaths, validateConcurrency } from "./jobs.js";
import { resolveAskBridge, runProcess, checkAskBridge } from "./ask-bridge.js";
import { readBatchMetadata } from "./metadata.js";
import { summarizeTask, workspaceHasBlockingTask } from "./state.js";
import { WfaError } from "./errors.js";
import { hashFile, isPidAlive, sha256, slug, uuid } from "./util.js";

async function validateFiles(paths, label) {
  const result = [];
  for (const item of paths) {
    const absolute = path.resolve(item);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new WfaError("ATTACHMENT_NOT_FOUND", `${label} is not a regular file: ${absolute}`);
    result.push(absolute);
  }
  return result;
}

async function makePayloadHash({ prompt, providers, workspace, files, images, options }) {
  const attachments = [];
  for (const file of [...files, ...images]) {
    attachments.push({ path: file, sha256: await hashFile(file) });
  }
  return sha256(JSON.stringify({ prompt, providers, workspace, attachments, options }));
}

function stateForParent(children) {
  return summarizeTask({ children }).state;
}

export async function executeTask(input, dependencies = {}) {
  const home = dependencies.home;
  const store = dependencies.store ?? new Store(home);
  const paths = getPaths(home);
  const config = dependencies.config ?? await loadConfig(home);
  const providers = normalizeProviders(input.providers, [input.provider ?? config.defaultProvider]);
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new WfaError("EMPTY_PROMPT", "Prompt must not be empty.");
  }
  const workspace = slug(input.workspace || path.basename(process.cwd()), "workspace");
  const timeoutSeconds = Number(input.timeoutSeconds ?? config.defaultTimeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > config.maxTimeoutSeconds) {
    throw new WfaError("INVALID_TIMEOUT", `timeout must be between 1 and ${config.maxTimeoutSeconds} seconds.`);
  }
  const concurrency = validateConcurrency(input.concurrency, providers.length, config.maxConcurrency);
  const files = await validateFiles(resolveAttachmentPaths(input.files ?? []), "Attachment");
  const images = await validateFiles(resolveAttachmentPaths(input.images ?? []), "Image");
  if (providers.includes("gemini") && images.length) {
    throw new WfaError("GEMINI_IMAGE_UNSUPPORTED", "Gemini image attachments are not supported by ask-bridge batch. Use files or remove Gemini from this request.");
  }
  const requestId = slug(input.requestId || uuid(), "request_id");
  const taskId = uuid();

  const modelByProvider = input.modelByProvider ?? {};
  if (input.model) {
    if (providers.length !== 1) {
      throw new WfaError("AMBIGUOUS_MODEL", "For multi-provider requests, use provider-specific model settings rather than one shared --model value.");
    }
    modelByProvider[providers[0]] = input.model;
  }

  const payloadHash = await makePayloadHash({
    prompt: input.prompt,
    providers,
    workspace,
    files,
    images,
    options: {
      kind: input.kind ?? "ask",
      timeoutSeconds,

      modelByProvider,
      fresh: Boolean(input.fresh),
      downloadImages: Boolean(input.downloadImages ?? config.downloadImages),
      concurrency,
    },
  });

  const priorSnapshot = await store.snapshot();
  const priorId = priorSnapshot.tasks.requestIndex?.[requestId];
  if (priorId) {
    const prior = priorSnapshot.tasks.tasks[priorId];
    if (!prior || prior.payloadHash !== payloadHash) {
      throw new WfaError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different payload. Use the original request_id only to recover the same request; use a new request_id for an intentional new task.");
    }
    return { task: prior, replayed: true };
  }

  const preflight = dependencies.skipPreflight ? null : await checkAskBridge(config);
  const command = preflight?.command ?? resolveAskBridge(config);

  const created = await store.transaction(async ({ tasks, sessions }) => {
    const priorId = tasks.requestIndex?.[requestId];
    if (priorId) {
      const prior = tasks.tasks[priorId];
      if (!prior || prior.payloadHash !== payloadHash) {
        throw new WfaError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different payload. Use the original request_id only to recover the same request; use a new request_id for an intentional new task.");
      }
      return { existing: prior };
    }

    const blocking = workspaceHasBlockingTask(tasks.tasks, workspace, providers);
    if (blocking) {
      throw new WfaError(
        "WORKSPACE_PROVIDER_LOCKED",
        `Workspace "${workspace}" already has unresolved ${blocking.provider} task ${blocking.taskId} (${blocking.state}). Do not send another prompt to this provider until you collect or explicitly abandon the previous task.`,
      );
    }

    const sessionMap = sessions.workspaces?.[workspace] ?? {};
    const jobs = buildJobs({
      taskId,
      providers,
      prompt: input.prompt,
      timeoutSeconds,
      sessions: sessionMap,
      fresh: Boolean(input.fresh),
      files,
      images,
      modelByProvider,

      downloadImages: Boolean(input.downloadImages ?? config.downloadImages),
    });
    const runDir = path.join(paths.runs, taskId);
    const outputDir = path.join(runDir, "ask-bridge-output");
    const inputFile = path.join(runDir, "jobs.jsonl");
    await mkdir(outputDir, { recursive: true });
    const jsonl = `${jobs.map((job) => JSON.stringify(job)).join("\n")}\n`;
    await writeFile(inputFile, jsonl, { encoding: "utf8", mode: 0o600 });
    try { await chmod(inputFile, 0o600); } catch {}

    const now = new Date().toISOString();
    const children = Object.fromEntries(providers.map((provider) => {
      const job = jobs.find((item) => item.provider === provider);
      return [provider, {
        provider,
        jobId: job.id,
        state: "queued",
        threadUrl: null,
        resultPath: null,
        error: null,
        childPid: null,
      }];
    }));
    const task = {
      taskId,
      requestId,
      payloadHash,
      kind: input.kind ?? "ask",
      workspace,
      providers,
      state: "preparing",
      createdAt: now,
      updatedAt: now,
      parentPid: process.pid,
      childPid: null,
      runDir,
      outputDir,
      inputFile,
      timeoutSeconds,
      concurrency,
      children,
      processExitCode: null,
    };
    tasks.tasks[taskId] = task;
    tasks.requestIndex ??= {};
    tasks.requestIndex[requestId] = taskId;
    return { task };
  });

  if (created.existing) {
    return { task: created.existing, replayed: true };
  }

  const task = created.task;
  input.onTaskCreated?.(task);
  const args = [
    "--backend", "browser",
    "batch",
    "--input", task.inputFile,
    "--concurrency", String(task.concurrency),
    "--output-dir", task.outputDir,
  ];

  await store.transaction(({ tasks }) => {
    const current = tasks.tasks[task.taskId];
    current.state = "running";
    current.updatedAt = new Date().toISOString();
  });

  const processResult = await (dependencies.runProcess ?? runProcess)(command, args, {
    cwd: process.cwd(),
    inherit: false,
    timeoutMs: (timeoutSeconds + 180) * 1000,
    onSpawn: async (pid) => {
      await store.transaction(({ tasks }) => {
        const current = tasks.tasks[task.taskId];
        current.childPid = pid ?? null;
        for (const child of Object.values(current.children)) child.childPid = pid ?? null;
        current.updatedAt = new Date().toISOString();
      });
    },
  });

  if (processResult.spawnError) {
    await store.transaction(({ tasks }) => {
      const current = tasks.tasks[task.taskId];
      current.state = "failed";
      current.processExitCode = null;
      current.error = `Could not start ask-bridge: ${processResult.spawnError.message}`;
      for (const child of Object.values(current.children)) {
        child.state = "failed_before_start";
        child.error = current.error;
      }
      current.updatedAt = new Date().toISOString();
    });
    const snapshot = await store.snapshot();
    return { task: snapshot.tasks.tasks[task.taskId], replayed: false };
  }

  await writeFile(path.join(task.runDir, "batch.stdout.log"), processResult.stdout ?? "", { encoding: "utf8", mode: 0o600 }).catch(() => {});
  await writeFile(path.join(task.runDir, "batch.stderr.log"), processResult.stderr ?? "", { encoding: "utf8", mode: 0o600 }).catch(() => {});

  const results = {};
  for (const [provider, child] of Object.entries(task.children)) {
    results[provider] = await readBatchMetadata(task.outputDir, child.jobId);
  }

  await store.transaction(({ tasks, sessions }) => {
    const current = tasks.tasks[task.taskId];
    current.processExitCode = processResult.code;
    current.processStdioDrainTimedOut = Boolean(processResult.stdioDrainTimedOut);
    current.processSignal = processResult.signal;
    current.processTimedOut = Boolean(processResult.timedOut);
    current.childPid = null;
    for (const [provider, result] of Object.entries(results)) {
      const child = current.children[provider];
      child.state = result.state;
      child.threadUrl = result.threadUrl;
      child.error = result.error;
      child.resultPath = result.responsePath;
      child.elapsedSeconds = result.elapsedSeconds;
      child.pageId = result.pageId;
      child.childPid = null;

      if (result.state === "completed" && result.threadUrl) {
        sessions.workspaces ??= {};
        sessions.workspaces[current.workspace] ??= {};
        sessions.workspaces[current.workspace][provider] = result.threadUrl;
      }
    }
    current.state = stateForParent(current.children);
    current.updatedAt = new Date().toISOString();
    if ((processResult.code !== 0 || processResult.timedOut) && !current.error) {
      current.processWarning = processResult.timedOut
        ? "The local ask-bridge process exceeded the safety watchdog and was stopped. Any provider without a completed metadata+response artifact remains unresolved; do not resend."
        : `ask-bridge batch exited with code ${processResult.code}${processResult.signal ? ` (${processResult.signal})` : ""}. Per-provider metadata is authoritative.`;
    }
  });

  const snapshot = await store.snapshot();
  return { task: snapshot.tasks.tasks[task.taskId], replayed: false };
}

export async function refreshTask(taskId, { home, store = new Store(home) } = {}) {
  return store.transaction(async ({ tasks, sessions }) => {
    const task = tasks.tasks[taskId];
    if (!task) throw new WfaError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    for (const child of Object.values(task.children)) {
      const metadata = await readBatchMetadata(task.outputDir, child.jobId);
      if (metadata.threadUrl && !child.threadUrl) child.threadUrl = metadata.threadUrl;
      if (metadata.state === "completed" && metadata.responsePath && child.state !== "abandoned") {
        child.state = "completed";
        child.threadUrl = metadata.threadUrl;
        child.resultPath = metadata.responsePath;
        child.error = null;
        sessions.workspaces ??= {};
        sessions.workspaces[task.workspace] ??= {};
        if (metadata.threadUrl) sessions.workspaces[task.workspace][child.provider] = metadata.threadUrl;
      } else if (["failed", "timed_out", "recoverable", "cancelled"].includes(metadata.state)
        && ["queued", "running", "interrupted_unknown"].includes(child.state)) {
        child.state = metadata.state;
        child.error = metadata.error;
      }
    }
    if (["preparing", "running"].includes(task.state)
      && ((task.childPid && !isPidAlive(task.childPid)) || (!task.childPid && !isPidAlive(task.parentPid)))) {
      for (const child of Object.values(task.children)) {
        if (child.state === "queued" || child.state === "running") {
          child.state = "interrupted_unknown";
          child.error = "ask-bridge process is no longer running. The prompt may already have been submitted; do not resend.";
        }
      }
    }
    task.state = stateForParent(task.children);
    task.updatedAt = new Date().toISOString();
    return task;
  });
}
