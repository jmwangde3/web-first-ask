import { lstat, mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.js";
import { getPaths } from "./paths.js";
import { loadConfig } from "./config.js";
import { buildJobs, normalizeProviders, resolveAttachmentPaths, validateConcurrency } from "./jobs.js";
import { resolveAskBridge, runProcess, checkAskBridge, spawnDetached } from "./ask-bridge.js";
import { readBatchMetadata } from "./metadata.js";
import { rememberSession, summarizeTask, workspaceHasBlockingTask, workspaceSessions } from "./state.js";
import { WfaError } from "./errors.js";
import { assertUpstreamAvailable } from "./maintenance.js";
import { hashFile, isPidAlive, sha256, slug, uuid } from "./util.js";
import {
  buildLineNumberedBundle,
  estimateTokens,
  prependBrief,
  resolveBriefText,
  scanSensitiveText,
  writeLineNumberedBundle,
} from "./bundle.js";
import { isSensitiveAttachmentPath, isTextSourceAttachment } from "./attachments.js";
import { classifyProviderError } from "./provider-errors.js";

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

async function makePayloadHash({ promptByProvider, providers, workspace, workspaceRoot, sessionFingerprint, files, images, options }) {
  const attachments = [];
  for (const file of [...files, ...images]) {
    attachments.push({ path: file, sha256: await hashFile(file) });
  }
  return sha256(JSON.stringify({ promptByProvider, providers, workspace, workspaceRoot, sessionFingerprint, attachments, options }));
}

function stateForParent(children) {
  return summarizeTask({ children }).state;
}

function stateFromProviderError(state, classified) {
  // An incomplete or timed-out browser operation may already have submitted
  // its prompt. Error text alone cannot turn that uncertainty into a safe
  // retryable outcome; retain the original unresolved state until reviewed.
  if (state !== "failed" && state !== "failed_before_start") return state;
  if (classified.errorCode === "RATE_LIMITED") return "rate_limited";
  if (classified.errorCode === "LOGIN_REQUIRED") return "login_required";
  if (classified.errorCode === "CLOUDFLARE_BLOCKED") return "cloudflare_blocked";
  return state;
}

async function readTextForScan(filePath) {
  try {
    const buffer = await readFile(filePath);
    if (buffer.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

async function resolveFollowup(snapshot, followupTaskId, providers, workspace, workspaceRoot) {
  if (!followupTaskId) return null;
  if (providers.length !== 1) {
    throw new WfaError("FOLLOWUP_PROVIDER_REQUIRED", "--followup requires exactly one provider. Select the same provider that produced the parent result.");
  }
  const parent = snapshot.tasks.tasks[followupTaskId];
  if (!parent) throw new WfaError("FOLLOWUP_NOT_FOUND", `Parent WFA task not found: ${followupTaskId}`);
  if (parent.workspace !== workspace || (parent.workspaceRoot && path.resolve(parent.workspaceRoot) !== workspaceRoot)) {
    throw new WfaError("FOLLOWUP_WORKSPACE_MISMATCH", `Parent task belongs to a different workspace identity. Use the same --workspace key and repository root.`);
  }
  const provider = providers[0];
  const child = parent.children?.[provider];
  if (!child || child.state !== "completed" || !child.threadUrl || !child.resultPath) {
    throw new WfaError("FOLLOWUP_NOT_READY", `Parent task ${followupTaskId} has no completed ${provider} response with a saved conversation URL.`);
  }
  const resultPath = path.resolve(child.resultPath);
  if (!parent.runDir || !pathInside(parent.runDir, resultPath)) {
    throw new WfaError("FOLLOWUP_RESULT_UNSAFE", "Parent resultPath is outside its task run directory.");
  }
  const parentUrl = new URL(child.threadUrl);
  const allowedHosts = {
    chatgpt: new Set(["chatgpt.com", "chat.openai.com"]),
    gemini: new Set(["gemini.google.com"]),
    claude: new Set(["claude.ai"]),
  };
  const conversationPaths = {
    chatgpt: /\/c\/[A-Za-z0-9_-]+(?:\/|$)/,
    gemini: /^\/app\/[A-Za-z0-9_-]+(?:\/|$)/,
    claude: /^\/chat\/[A-Za-z0-9_-]+(?:\/|$)/,
  };
  if (parentUrl.protocol !== "https:" || !allowedHosts[provider]?.has(parentUrl.hostname)
    || parentUrl.username || parentUrl.password || parentUrl.port
    || !conversationPaths[provider]?.test(parentUrl.pathname)) {
    throw new WfaError("FOLLOWUP_URL_UNSAFE", `Parent ${provider} URL must identify a saved HTTPS conversation, not a provider home or project shell.`);
  }
  const resultInfo = await lstat(resultPath).catch(() => null);
  if (!resultInfo?.isFile() || resultInfo.isSymbolicLink()) {
    throw new WfaError("FOLLOWUP_RESULT_MISSING", "Parent response file is missing, a symlink, or not a regular file.");
  }
  const body = await readFile(resultPath, "utf8").catch(() => "");
  if (!body.trim()) throw new WfaError("FOLLOWUP_RESULT_MISSING", "Parent response file is missing or empty.");
  return {
    taskId: followupTaskId,
    provider,
    jobId: child.jobId ?? null,
    threadUrl: child.threadUrl,
    resultPath,
  };
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function buildProviderPrompts(input, providers, sessionMap, briefText, followup) {
  const prompts = {};
  const explicitBrief = Boolean(input.briefFile);
  for (const provider of providers) {
    const needsNewSession = Boolean(input.fresh) || !sessionMap[provider];
    const inject = explicitBrief || (!input.noBrief && !followup && needsNewSession);
    prompts[provider] = prependBrief(input.prompt, inject ? briefText : "");
  }
  return prompts;
}

function relevantSessionFingerprint(sessionMap, providers, fresh) {
  return Object.fromEntries(providers.map((provider) => [
    provider,
    fresh ? null : (sessionMap[provider] ?? null),
  ]));
}

async function buildSensitiveFindings({ promptByProvider, files, images, briefText }) {
  const findings = [];
  const unscannedAttachments = [];
  for (const [provider, prompt] of Object.entries(promptByProvider)) {
    findings.push(...scanSensitiveText(prompt, `prompt:${provider}`));
  }
  if (briefText) findings.push(...scanSensitiveText(briefText, "brief"));
  for (const filePath of files) {
    if (isSensitiveAttachmentPath(filePath)) {
      findings.push({ source: filePath, line: 1, kind: "sensitive_filename" });
    }
    const text = await readTextForScan(filePath);
    if (text !== null) findings.push(...scanSensitiveText(text, filePath));
    else unscannedAttachments.push({
      path: filePath,
      reason: "binary or non-UTF-8 attachment; contents not inspected by text secret scanner",
    });
  }
  for (const filePath of images) {
    unscannedAttachments.push({
      path: filePath,
      reason: "image attachment; visual contents are not inspected by the text secret scanner",
    });
  }
  return { findings, unscannedAttachments };
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
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const timeoutSeconds = Number(input.timeoutSeconds ?? config.defaultTimeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > config.maxTimeoutSeconds) {
    throw new WfaError("INVALID_TIMEOUT", `timeout must be between 1 and ${config.maxTimeoutSeconds} seconds.`);
  }
  const concurrency = validateConcurrency(input.concurrency, providers.length, config.maxConcurrency);
  const files = await validateFiles(resolveAttachmentPaths(input.files ?? [], workspaceRoot), "Attachment");
  const images = await validateFiles(resolveAttachmentPaths(input.images ?? [], workspaceRoot), "Image");
  if (providers.includes("gemini") && images.length) {
    throw new WfaError("GEMINI_IMAGE_UNSUPPORTED", "Gemini image attachments are not supported by ask-bridge batch. Use --file for supported document formats or remove Gemini from this request.");
  }
  if (input.briefFile && input.noBrief) {
    throw new WfaError("BRIEF_OPTION_CONFLICT", "--brief-file cannot be combined with --no-brief.");
  }
  if (input.followupTaskId && input.fresh) {
    throw new WfaError("FOLLOWUP_FRESH_CONFLICT", "--followup cannot be combined with --new-session/--fresh.");
  }
  const mode = input.kind === "code" ? (input.mode ?? "full-file") : null;
  if (mode && !["full-file", "spec"].includes(mode)) {
    throw new WfaError("INVALID_CODE_MODE", 'Code mode must be "full-file" or "spec".');
  }

  const modelByProvider = { ...(input.modelByProvider ?? {}) };
  if (input.model) {
    if (providers.length !== 1) {
      throw new WfaError("AMBIGUOUS_MODEL", "For multi-provider requests, use provider-specific model settings rather than one shared --model value.");
    }
    modelByProvider[providers[0]] = input.model;
  }

  let snapshot = await store.snapshot();
  if (!input.dryRun) {
    // Reconcile the latest task for each selected workspace/provider before
    // checking locks. This clears stale executionPending flags after detached
    // ask-bridge exits, while preserving locks for live batch processes.
    const latestTaskIds = new Set();
    for (const provider of providers) {
      const latest = Object.values(snapshot.tasks.tasks).findLast((task) =>
        task.workspace === workspace && task.children?.[provider]);
      if (latest) latestTaskIds.add(latest.taskId);
    }
    for (const existingTaskId of latestTaskIds) {
      await refreshTask(existingTaskId, { home, store });
    }
    snapshot = await store.snapshot();
  }
  const followup = await resolveFollowup(snapshot, input.followupTaskId, providers, workspace, workspaceRoot);
  const sessionMap = workspaceSessions(snapshot.tasks.tasks, snapshot.sessions, workspace, providers);
  if (followup) sessionMap[followup.provider] = followup.threadUrl;

  const autoBriefNeeded = !input.noBrief && (Boolean(input.fresh) || providers.some((provider) => !sessionMap[provider]));
  const briefText = await resolveBriefText({
    briefFile: input.briefFile,
    cwd: workspaceRoot,
    shouldAutoInject: autoBriefNeeded,
  });
  const promptByProvider = buildProviderPrompts(input, providers, sessionMap, briefText, followup);
  const sessionFingerprint = relevantSessionFingerprint(sessionMap, providers, Boolean(input.fresh));
  const bundleLines = Boolean(input.bundleLines);
  const textFiles = bundleLines ? files.filter(isTextSourceAttachment) : [];
  const nativeFiles = bundleLines ? files.filter((filePath) => !isTextSourceAttachment(filePath)) : files;

  let bundlePreview = null;
  if (textFiles.length) bundlePreview = await buildLineNumberedBundle(textFiles, { cwd: workspaceRoot });
  const sensitiveScan = await buildSensitiveFindings({
    promptByProvider,
    files,
    images,
    briefText: Object.values(promptByProvider).some((value) => value !== input.prompt) ? briefText : "",
  });
  const sensitiveFindings = sensitiveScan.findings;
  const unscannedAttachments = sensitiveScan.unscannedAttachments;

  if (input.dryRun) {
    const promptBytes = Object.values(promptByProvider).reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
    const actualFileAttachments = bundleLines ? nativeFiles : files;
    const actualAttachmentPaths = [...actualFileAttachments, ...images];
    const attachmentBytes = (await Promise.all(actualAttachmentPaths.map(async (filePath) => (await stat(filePath)).size)))
      .reduce((sum, value) => sum + value, 0) + (bundlePreview?.bytes ?? 0);
    const providerAttachmentBytes = attachmentBytes * providers.length;
    const estimatedTokens = estimateTokens(Object.values(promptByProvider).join("\n")) + Math.ceil(providerAttachmentBytes / 4);
    return {
      dryRun: true,
      preview: {
        kind: input.kind ?? "ask",
        mode,
        workspace,
        workspaceRoot,
        providers,
        fresh: Boolean(input.fresh),
        followup: followup ? { taskId: followup.taskId, provider: followup.provider, parentJobId: followup.jobId } : null,
        briefIncludedProviders: providers.filter((provider) => promptByProvider[provider] !== input.prompt),
        briefBytes: Buffer.byteLength(briefText, "utf8"),
        promptBytes,
        filesCount: files.length,
        imagesCount: images.length,
        actualAttachmentCount: actualAttachmentPaths.length + (bundlePreview ? 1 : 0),
        attachmentBytes,
        providerAttachmentBytes,
        bundleLines,
        bundle: bundlePreview ? {
          files: bundlePreview.files,
          lines: bundlePreview.lines,
          bytes: bundlePreview.bytes,
          sha256: bundlePreview.sha256,
        } : null,
        estimatedTokens,
        tokenEstimate: "rough byte/4 heuristic; not provider tokenizer output",
        sensitiveFindings,
        unscannedAttachments,
        sendBlocked: sensitiveFindings.length > 0 && !input.allowSensitive,
      },
    };
  }
  if (sensitiveFindings.length && !input.allowSensitive) {
    const locations = sensitiveFindings.slice(0, 12).map((item) => `${item.source}:${item.line} (${item.kind})`).join(", ");
    throw new WfaError(
      "SENSITIVE_CONTENT_DETECTED",
      `Potential secrets were found at ${locations}${sensitiveFindings.length > 12 ? ", ..." : ""}. Remove them or explicitly confirm with --allow-sensitive. Matched values are never printed.`,
    );
  }

  const requestId = slug(input.requestId || uuid(), "request_id");
  const taskId = uuid();
  // Idempotency is keyed to the caller's immutable intent, not the current
  // provider session URL or an automatically injected first-turn brief. The
  // session changes after a successful request, but replaying that request ID
  // must still return the original task without sending a second message.
  const attachmentIdentities = [];
  for (const filePath of [...files, ...images]) {
    attachmentIdentities.push({ path: filePath, sha256: await hashFile(filePath) });
  }
  const intentHash = sha256(JSON.stringify({
    prompt: input.prompt,
    providers,
    workspace,
    workspaceRoot,
    attachments: attachmentIdentities,
    options: {
      kind: input.kind ?? "ask",
      mode,
      timeoutSeconds,
      modelByProvider,
      fresh: Boolean(input.fresh),
      followupTaskId: input.followupTaskId ?? null,
      bundleLines,
      noBrief: Boolean(input.noBrief),
      briefFile: input.briefFile ? path.resolve(workspaceRoot, input.briefFile) : null,
      // An explicitly selected brief is user-supplied input and must conflict
      // when its contents change. Auto-brief is dynamic session setup, not
      // caller input, so it must not invalidate a replay after first send.
      explicitBriefSha256: input.briefFile ? sha256(briefText) : null,
      downloadImages: Boolean(input.downloadImages ?? config.downloadImages),
      concurrency,
    },
  }));
  const payloadHash = await makePayloadHash({
    promptByProvider,
    providers,
    workspace,
    workspaceRoot,
    sessionFingerprint,
    files,
    images,
    options: {
      kind: input.kind ?? "ask",
      mode,
      timeoutSeconds,
      modelByProvider,
      fresh: Boolean(input.fresh),
      followup: followup ? { taskId: followup.taskId, provider: followup.provider, jobId: followup.jobId } : null,
      bundleLines,
      briefSha256: briefText ? sha256(briefText) : null,
      downloadImages: Boolean(input.downloadImages ?? config.downloadImages),
      concurrency,
    },
  });

  const priorId = snapshot.tasks.requestIndex?.[requestId];
  if (priorId) {
    const prior = snapshot.tasks.tasks[priorId];
    if (!prior || (prior.intentHash ? prior.intentHash !== intentHash : prior.payloadHash !== payloadHash)) {
      throw new WfaError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different payload. Use the original request_id only to recover the same request; use a new request_id for an intentional new task.");
    }
    return { task: prior, replayed: true };
  }

  const created = await store.transaction(async ({ tasks, sessions }) => {
    const priorId = tasks.requestIndex?.[requestId];
    if (priorId) {
      const prior = tasks.tasks[priorId];
      if (!prior || (prior.intentHash ? prior.intentHash !== intentHash : prior.payloadHash !== payloadHash)) {
        throw new WfaError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different payload. Use the original request_id only to recover the same request; use a new request_id for an intentional new task.");
      }
      return { existing: prior };
    }

    assertUpstreamAvailable(tasks);
    const blocking = workspaceHasBlockingTask(tasks.tasks, workspace, providers);
    if (blocking) {
      const reason = blocking.executionPending
        ? "The verified result may already be readable, but the owning ask-bridge process is still finishing cleanup. Wait for it to exit before starting another task."
        : `Do not send another prompt to this provider until you collect or explicitly abandon the previous task; rate-limit cooldowns remain enforced even after an early resolve.${blocking.cooldownUntil ? ` Cooldown remains active until ${blocking.cooldownUntil}.` : ""}`;
      throw new WfaError(
        "WORKSPACE_PROVIDER_LOCKED",
        `Workspace "${workspace}" is locked by ${blocking.provider} task ${blocking.taskId} (${blocking.state}). ${reason}`,
      );
    }

    const latestSessions = workspaceSessions(tasks.tasks, sessions, workspace, providers);
    if (followup) latestSessions[followup.provider] = followup.threadUrl;
    const latestPrompts = buildProviderPrompts(input, providers, latestSessions, briefText, followup);
    const latestSessionFingerprint = relevantSessionFingerprint(latestSessions, providers, Boolean(input.fresh));
    if (JSON.stringify(latestPrompts) !== JSON.stringify(promptByProvider)
      || JSON.stringify(latestSessionFingerprint) !== JSON.stringify(sessionFingerprint)) {
      throw new WfaError("SESSION_CHANGED_RETRY", "Workspace conversation state changed while preparing this request. Re-run the command; no provider request was sent.");
    }

    const preflight = dependencies.skipPreflight ? null : await checkAskBridge(config);
    const command = preflight?.command ?? resolveAskBridge(config);
    const runDir = path.join(paths.runs, taskId);
    const outputDir = path.join(runDir, "ask-bridge-output");
    const inputFile = path.join(runDir, "jobs.jsonl");
    await mkdir(outputDir, { recursive: true });

    let jobFiles = files;
    let bundleInfo = null;
    if (bundleLines && textFiles.length) {
      bundleInfo = await writeLineNumberedBundle(textFiles, { outDir: runDir, cwd: workspaceRoot });
      jobFiles = [...nativeFiles, bundleInfo.bundlePath];
    }

    const jobs = buildJobs({
      taskId,
      providers,
      prompt: input.prompt,
      promptByProvider,
      timeoutSeconds,
      sessions: latestSessions,
      fresh: Boolean(input.fresh),
      files: jobFiles,
      images,
      modelByProvider,
      downloadImages: Boolean(input.downloadImages ?? config.downloadImages),
    });
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
        revision: 0,
        threadUrl: null,
        resultPath: null,
        error: null,
        errorCode: null,
        recoveryHint: null,
        childPid: null,
      }];
    }));
    const task = {
      taskId,
      requestId,
      payloadHash,
      intentHash,
      kind: input.kind ?? "ask",
      mode,
      workspace,
      workspaceRoot,
      providers,
      state: "preparing",
      createdAt: now,
      updatedAt: now,
      parentPid: input.detach ? null : process.pid,
      childPid: null,
      detached: Boolean(input.detach),
      lineage: followup ? [...(tasks.tasks[followup.taskId]?.lineage ?? []), followup.taskId] : [],
      runDir,
      outputDir,
      inputFile,
      timeoutSeconds,
      concurrency,
      bundlePath: bundleInfo?.bundlePath ?? null,
      bundleSha256: bundleInfo?.sha256 ?? null,
      briefFile: input.briefFile ? path.resolve(workspaceRoot, input.briefFile) : (briefText ? path.join(workspaceRoot, ".wfa", "active-brief.md") : null),
      briefSha256: briefText ? sha256(briefText) : null,
      briefInjectedProviders: providers.filter((provider) => promptByProvider[provider] !== input.prompt),
      parentTaskId: followup?.taskId ?? null,
      parentProvider: followup?.provider ?? null,
      parentJobId: followup?.jobId ?? null,
      parentThreadUrl: followup?.threadUrl ?? null,
      parentResultPath: followup?.resultPath ?? null,
      children,
      processExitCode: null,
    };
    tasks.tasks[taskId] = task;
    tasks.requestIndex ??= {};
    tasks.requestIndex[requestId] = taskId;
    return { task, command };
  });

  if (created.existing) return { task: created.existing, replayed: true };

  const { task, command } = created;
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
    current.executionPending = true;
    for (const child of Object.values(current.children)) {
      if (child.state === "queued") {
        child.state = "running";
        child.revision = (child.revision ?? 0) + 1;
      }
    }
    current.updatedAt = new Date().toISOString();
  });

  if (input.detach) {
    let spawned;
    try {
      spawned = await (dependencies.spawnDetached ?? spawnDetached)(command, args, {
        cwd: workspaceRoot,
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
        current.error = `Could not start detached ask-bridge: ${error.message}`;
        current.processExitCode = null;
        current.childPid = null;
        current.executionPending = false;
        for (const child of Object.values(current.children)) {
          child.state = "failed_before_start";
          child.error = current.error;
          child.childPid = null;
          child.revision = (child.revision ?? 0) + 1;
        }
        current.updatedAt = new Date().toISOString();
      });
      const snapshot = await store.snapshot();
      return { task: snapshot.tasks.tasks[task.taskId], replayed: false, detached: false };
    }
    await store.transaction(({ tasks }) => {
      const current = tasks.tasks[task.taskId];
      current.childPid = spawned.pid;
      current.executionPending = true;
      for (const child of Object.values(current.children)) child.childPid = spawned.pid;
      current.updatedAt = new Date().toISOString();
    });
    const snapshot = await store.snapshot();
    return { task: snapshot.tasks.tasks[task.taskId], replayed: false, detached: true };
  }

  const processResult = await (dependencies.runProcess ?? runProcess)(command, args, {
    cwd: workspaceRoot,
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
      current.executionPending = false;
      current.error = `Could not start ask-bridge: ${processResult.spawnError.message}`;
      for (const child of Object.values(current.children)) {
        child.state = "failed_before_start";
        child.error = current.error;
        child.revision = (child.revision ?? 0) + 1;
      }
      current.updatedAt = new Date().toISOString();
    });
    const latest = await store.snapshot();
    return { task: latest.tasks.tasks[task.taskId], replayed: false };
  }

  await writeFile(path.join(task.runDir, "batch.stdout.log"), processResult.stdout ?? "", { encoding: "utf8", mode: 0o600 }).catch(() => {});
  await writeFile(path.join(task.runDir, "batch.stderr.log"), processResult.stderr ?? "", { encoding: "utf8", mode: 0o600 }).catch(() => {});

  const results = {};
  for (const [provider, child] of Object.entries(task.children)) {
    results[provider] = await readBatchMetadata(task.outputDir, child.jobId, provider, { runDir: task.runDir });
  }

  await store.transaction(({ tasks, sessions }) => {
    const current = tasks.tasks[task.taskId];
    current.processExitCode = processResult.code;
    current.executionPending = Boolean(processResult.childMayRun);
    current.processStdioDrainTimedOut = Boolean(processResult.stdioDrainTimedOut);
    current.processSignal = processResult.signal;
    current.processTimedOut = Boolean(processResult.timedOut);
    current.childPid = processResult.childMayRun ? processResult.pid : null;
    for (const [provider, result] of Object.entries(results)) {
      const child = current.children[provider];
      if (["completed", "abandoned", "failed_before_start"].includes(child.state)) continue;
      const previousState = child.state;
      const previousThread = child.threadUrl;
      const previousResult = child.resultPath;
      child.childPid = current.childPid;
      child.state = result.state;
      child.threadUrl = result.threadUrl ?? child.threadUrl;
      child.error = result.error;
      child.resultPath = result.responsePath ?? child.resultPath;
      if (result.trustedCompletion && result.completionProof) {
        child.completionProof = result.completionProof;
        child.collectionSource = "ask-bridge-batch-terminal";
        child.collectedAt = result.completionProof.verifiedAt;
      }
      child.elapsedSeconds = result.elapsedSeconds;
      child.pageId = result.pageId;
      const classified = classifyProviderError({
        error: result.error,
        stderr: processResult.stderr ?? "",
        jobId: child.jobId,
        state: result.state,
        hasResponse: Boolean(result.responsePath),
      });
      child.errorCode = classified.errorCode;
      child.recoveryHint = classified.recoveryHint;
      child.retryAfterSeconds = classified.retryAfterSeconds;
      child.retryAfterAt = classified.retryAfterAt;
      child.retryAfterEstimated = classified.retryAfterEstimated;
      child.state = stateFromProviderError(result.state, classified);
      if (child.state !== previousState || child.threadUrl !== previousThread || child.resultPath !== previousResult) {
        child.revision = (child.revision ?? 0) + 1;
      }
      if (result.trustedCompletion && result.state === "completed" && result.threadUrl) {
        rememberSession(tasks.tasks, sessions, current, provider);
      }
    }
    current.state = stateForParent(current.children);
    current.updatedAt = new Date().toISOString();
    if (processResult.processError) {
      current.processWarning = `ask-bridge failed after launch: ${processResult.processError.message}. Check unresolved providers before sending again.`;
    } else if (processResult.timedOut) {
      current.processWarning = "The local ask-bridge process exceeded the safety watchdog. Any provider without a completed metadata+response artifact remains unresolved; do not resend.";
    } else if (processResult.code !== 0) {
      current.processWarning = `ask-bridge batch exited with code ${processResult.code}${processResult.signal ? ` (${processResult.signal})` : ""}. Per-provider metadata is authoritative.`;
    }
  });

  const latest = await store.snapshot();
  return { task: latest.tasks.tasks[task.taskId], replayed: false };
}

export async function refreshTask(taskId, { home, store = new Store(home) } = {}) {
  return store.transaction(async ({ tasks, sessions }) => {
    const task = tasks.tasks[taskId];
    if (!task) throw new WfaError("TASK_NOT_FOUND", `Task not found: ${taskId}`);

    const processAlive = isPidAlive(task.childPid)
      || (task.processExitCode == null && ["preparing", "running"].includes(task.state) && isPidAlive(task.parentPid));
    if (processAlive) {
      // A per-job terminal result may be available while ask-bridge is still
      // closing that tab or finishing another provider in the same batch.
      // Results can be collected, but keep the workspace/provider lock until
      // the owning process exits.
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
        const stderr = await readFile(path.join(task.runDir, "batch.stderr.log"), "utf8").catch(() => "");
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
    task.state = stateForParent(task.children);
    task.updatedAt = new Date().toISOString();
    return task;
  });
}
