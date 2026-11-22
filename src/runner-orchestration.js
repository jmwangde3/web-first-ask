import { lstat, mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.js";
import { getPaths } from "./paths.js";
import { loadConfig } from "./config.js";
import { buildJobs, normalizeProviders, resolveAttachmentPaths, validateConcurrency } from "./jobs.js";
import { resolveAskBridge, checkAskBridge, runProcess } from "./ask-bridge.js";
import { workspaceHasBlockingTask, workspaceSessions } from "./state.js";
import { WfaError } from "./errors.js";
import { assertUpstreamAvailable } from "./maintenance.js";
import { validateGeminiMode } from "./config.js";
import { hashFile, sha256, slug, startHeartbeat, uuid } from "./util.js";
import {
  buildLineNumberedBundle, estimateTokens, prependBrief, resolveBriefText,
  scanSensitiveText, writeLineNumberedBundle,
} from "./bundle.js";
import { isArchiveAttachment, isSensitiveAttachmentPath, isTextSourceAttachment } from "./attachments.js";
import { refreshTask, guardedBatch } from "./runner-stall.js";
import { executePreparedTask } from "./runner-retry.js";
import { bundleRepository, repositoryBlock, resolveRepository } from "./repository.js";
import { archiveRepository, repositoryArchiveBlock } from "./repository-archive.js";
import { DEFAULT_STALL_TIMEOUT_SECONDS } from "./constants.js";

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
  for (const file of [...files, ...images]) attachments.push({ path: file, sha256: await hashFile(file) });
  return sha256(JSON.stringify({ promptByProvider, providers, workspace, workspaceRoot, sessionFingerprint, attachments, options }));
}

async function readTextForScan(filePath) {
  try {
    const buffer = await readFile(filePath);
    if (buffer.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch { return null; }
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveFollowup(snapshot, followupTaskId, providers, workspace, workspaceRoot) {
  if (!followupTaskId) return null;
  if (providers.length !== 1) {
    throw new WfaError("FOLLOWUP_PROVIDER_REQUIRED", "--followup requires exactly one provider. Select the same provider that produced the parent result.");
  }
  const parent = snapshot.tasks.tasks[followupTaskId];
  if (!parent) throw new WfaError("FOLLOWUP_NOT_FOUND", `Parent WFA task not found: ${followupTaskId}`);
  if (parent.workspace !== workspace || (parent.workspaceRoot && path.resolve(parent.workspaceRoot) !== workspaceRoot)) {
    throw new WfaError("FOLLOWUP_WORKSPACE_MISMATCH", "Parent task belongs to a different workspace identity. Use the same --workspace key and repository root.");
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
    chatgpt: new Set(["chatgpt.com", "chat.openai.com"]), gemini: new Set(["gemini.google.com"]), claude: new Set(["claude.ai"]),
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
  return { taskId: followupTaskId, provider, jobId: child.jobId ?? null,
    threadUrl: child.threadUrl, resultPath };
}

function buildProviderPrompts(input, providers, sessionMap, briefText, followup, sessionPolicy) {
  const prompts = {};
  const explicitBrief = Boolean(input.briefFile);
  for (const provider of providers) {
    const needsNewSession = sessionPolicy === "fresh" || !sessionMap[provider];
    const inject = explicitBrief || (!input.noBrief && !followup && needsNewSession);
    prompts[provider] = prependBrief(input.prompt, inject ? briefText : "");
  }
  return prompts;
}

function relevantSessionFingerprint(sessionMap, providers, fresh) {
  return Object.fromEntries(providers.map((provider) => [provider, fresh ? null : (sessionMap[provider] ?? null)]));
}

async function buildSensitiveFindings({ promptByProvider, files, images, briefText, archiveScan }) {
  const findings = [];
  const unscannedAttachments = [];
  for (const [provider, prompt] of Object.entries(promptByProvider)) findings.push(...scanSensitiveText(prompt, `prompt:${provider}`));
  if (briefText) findings.push(...scanSensitiveText(briefText, "brief"));
  findings.push(...(archiveScan?.findings ?? []));
  for (const filePath of files) {
    // Archive entries were scanned while they were packed, so the zip itself is
    // not an opaque blob any more. Report only the entries that stayed binary.
    if (archiveScan?.file && path.resolve(filePath) === path.resolve(archiveScan.file)) {
      const missed = archiveScan.totalFiles - archiveScan.scannedFiles;
      if (missed > 0) unscannedAttachments.push({ path: filePath,
        reason: `${missed} non-text entr${missed === 1 ? "y" : "ies"} inside the archive were not inspected by the text secret scanner` });
      continue;
    }
    if (isSensitiveAttachmentPath(filePath)) findings.push({ source: filePath, line: 1, kind: "sensitive_filename" });
    const text = await readTextForScan(filePath);
    if (text !== null) findings.push(...scanSensitiveText(text, filePath));
    else unscannedAttachments.push({ path: filePath,
      reason: "binary or non-UTF-8 attachment; contents not inspected by text secret scanner" });
  }
  for (const filePath of images) unscannedAttachments.push({ path: filePath,
    reason: "image attachment; visual contents are not inspected by the text secret scanner" });
  return { findings, unscannedAttachments };
}

function splitAttachmentFiles(attachments, limitBytes) {
  const groups = [];
  let current = { group: 1, files: [], bytes: 0 };
  for (const { filePath, bytes } of attachments) {
    if (bytes > limitBytes) {
      if (current.files.length) groups.push(current);
      groups.push({ group: groups.length + 1, files: [filePath], bytes, oversizeFile: true });
      current = { group: groups.length + 1, files: [], bytes: 0 };
      continue;
    }
    if (current.files.length && current.bytes + bytes > limitBytes) {
      groups.push(current);
      current = { group: groups.length + 1, files: [], bytes: 0 };
    }
    current.files.push(filePath);
    current.bytes += bytes;
  }
  if (current.files.length) groups.push(current);
  return groups;
}

function withGeminiInline(prompts, inlineBody, inline) {
  if (!inlineBody || !inline) return prompts;
  return { ...prompts,
    gemini: `${prompts.gemini}\n\n## Inlined attachments (${inline.files} file(s), ${inline.bytes} bytes; ask-bridge cannot upload attachments to Gemini)\n\n${inlineBody}` };
}

// A follow-up used to borrow its parent through a Store subclass that rewrote
// the parent state inside every transaction. The only thing that needs the
// rewrite is the check below, so it is an explicit, in-memory view instead.
function applyFollowupView(snapshot, allowUnreadableFollowup) {
  const { taskId, provider } = allowUnreadableFollowup ?? {};
  if (!taskId || !provider) return;
  const child = snapshot.tasks.tasks[taskId]?.children?.[provider];
  if (child?.state === "repo_unreadable" && child.repoUnreadable
    && (child.completionProof || child.collectionSource === "manual-confirmed-get") && !child.threadMismatch) {
    child.state = "completed";
  }
}

async function prepareRequest(input, dependencies = {}) {
  const home = dependencies.home;
  const store = dependencies.store ?? new Store(home);
  const paths = getPaths(home);
  const config = dependencies.config ?? await loadConfig(home);
  const providers = normalizeProviders(input.providers, input.provider ? [input.provider] : config.defaultProviders);
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new WfaError("EMPTY_PROMPT", "Prompt must not be empty.");
  const workspace = slug(input.workspace || path.basename(process.cwd()), "workspace");
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const timeoutSeconds = Number(input.timeoutSeconds ?? config.defaultTimeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > config.maxTimeoutSeconds) {
    throw new WfaError("INVALID_TIMEOUT", `timeout must be between 1 and ${config.maxTimeoutSeconds} seconds.`);
  }
  const concurrency = validateConcurrency(input.concurrency ?? config.defaultConcurrency, providers.length, config.maxConcurrency);
  const files = await validateFiles(resolveAttachmentPaths(input.files ?? [], workspaceRoot), "Attachment");
  const images = await validateFiles(resolveAttachmentPaths(input.images ?? [], workspaceRoot), "Image");
  if (providers.includes("gemini") && images.length) {
    throw new WfaError("GEMINI_IMAGE_UNSUPPORTED", "Gemini image attachments are not supported by ask-bridge batch. Use --file for supported document formats or remove Gemini from this request.");
  }
  if (input.briefFile && input.noBrief) throw new WfaError("BRIEF_OPTION_CONFLICT", "--brief-file cannot be combined with --no-brief.");
  if (input.followupTaskId && input.fresh) throw new WfaError("FOLLOWUP_FRESH_CONFLICT", "--followup cannot be combined with --new-session/--fresh.");
  const mode = input.kind === "code" ? (input.mode ?? "full-file") : null;
  if (mode && !["full-file", "spec"].includes(mode)) throw new WfaError("INVALID_CODE_MODE", 'Code mode must be "full-file" or "spec".');

  const modelByProvider = { ...(input.modelByProvider ?? {}) };
  if (input.model) {
    if (providers.length !== 1) throw new WfaError("AMBIGUOUS_MODEL", "For multi-provider requests, use provider-specific model settings rather than one shared --model value.");
    modelByProvider[providers[0]] = input.model;
  }
  let snapshot = await store.snapshot();
  applyFollowupView(snapshot, input.allowUnreadableFollowup);
  if (!input.dryRun) {
    const latestTaskIds = new Set();
    for (const provider of providers) {
      const latest = Object.values(snapshot.tasks.tasks).findLast((task) => task.workspace === workspace && task.children?.[provider]);
      if (latest) latestTaskIds.add(latest.taskId);
    }
    for (const existingTaskId of latestTaskIds) await refreshTask(existingTaskId, { home, store });
    snapshot = await store.snapshot();
    applyFollowupView(snapshot, input.allowUnreadableFollowup);
  }
  const followup = await resolveFollowup(snapshot, input.followupTaskId, providers, workspace, workspaceRoot);
  const sessionMap = workspaceSessions(snapshot.tasks.tasks, snapshot.sessions, workspace, providers);
  if (followup) sessionMap[followup.provider] = followup.threadUrl;
  // New session is the documented default; --followup and --continue-session
  // are the two ways to inherit the conversations the ledger already knows.
  const sessionPolicy = input.sessionPolicy
    ?? (input.followupTaskId || input.continueSession ? "continue" : "fresh");
  const autoBriefNeeded = !input.noBrief
    && (sessionPolicy === "fresh" || providers.some((provider) => !sessionMap[provider]));
  const briefText = await resolveBriefText({ briefFile: input.briefFile, cwd: workspaceRoot, shouldAutoInject: autoBriefNeeded });
  const bundleLines = Boolean(input.bundleLines);
  const textFiles = bundleLines ? files.filter(isTextSourceAttachment) : [];
  const nativeFiles = bundleLines ? files.filter((filePath) => !isTextSourceAttachment(filePath)) : files;
  let bundlePreview = null;
  if (textFiles.length) bundlePreview = await buildLineNumberedBundle(textFiles, { cwd: workspaceRoot });

  const filesByProvider = {};
  let geminiInline = null;
  let geminiInlineBody = null;
  let geminiAttachmentBlocked = false;
  if (providers.includes("gemini") && files.length && !input.allowGeminiAttachments) {
    let body = null;
    if (bundleLines) body = bundlePreview?.content ?? null;
    else if (files.every((filePath) => isTextSourceAttachment(filePath))) {
      const sections = [];
      for (const filePath of files) sections.push(`===== FILE: ${filePath} =====\n${await readFile(filePath, "utf8")}`);
      body = sections.join("\n\n");
    }
    if (body === null) {
      // Archives upload natively on both providers and are not checked by name,
      // so known issue U1 does not apply to them. Binary documents are still
      // blocked: ask-bridge would report them as never attached (U1).
      if (!files.every((filePath) => isArchiveAttachment(filePath))) {
        geminiAttachmentBlocked = true;
        if (!input.dryRun) {
          throw new WfaError("GEMINI_ATTACHMENT_UNSUPPORTED", "Gemini cannot receive this attachment in batch mode: ask-bridge confirms an attachment by matching the whole filename against the page text, so an ordinary name is reported as never attached, and a binary or native document cannot be inlined. Inline the content yourself, drop Gemini with --providers chatgpt, or force the upload with --allow-gemini-attachments and a filename stem of 20 characters or fewer.");
        }
      }
    } else {
      geminiInlineBody = body;
      geminiInline = { files: files.length, bytes: Buffer.byteLength(body, "utf8") };
      filesByProvider.gemini = [];
    }
  }
  const basePrompts = buildProviderPrompts(input, providers, sessionMap, briefText, followup, sessionPolicy);
  const promptByProvider = withGeminiInline(basePrompts, geminiInlineBody, geminiInline);
  const sessionFingerprint = relevantSessionFingerprint(sessionMap, providers, sessionPolicy === "fresh");
  const sensitiveScan = await buildSensitiveFindings({ promptByProvider, files, images,
    archiveScan: input.archiveScan,
    briefText: Object.values(basePrompts).some((value) => value !== input.prompt) ? briefText : "" });
  const sensitiveFindings = sensitiveScan.findings;
  const unscannedAttachments = sensitiveScan.unscannedAttachments;

  const PROMPT_SIZE_WARN_BYTES = 40 * 1024;
  const attachmentStats = await Promise.all(files.map(async (filePath) => ({
    filePath: path.relative(workspaceRoot, filePath) || filePath, bytes: (await stat(filePath)).size,
  })));
  const attachmentBytes = attachmentStats.reduce((sum, item) => sum + item.bytes, 0);
  const promptBytesByProvider = Object.fromEntries(providers.map((provider) =>
    [provider, Buffer.byteLength(promptByProvider[provider] ?? "", "utf8")]));
  const promptRiskProviders = providers.filter((provider) => promptBytesByProvider[provider] > PROMPT_SIZE_WARN_BYTES);
  const promptSizeRisk = {
    thresholdBytes: PROMPT_SIZE_WARN_BYTES,
    exceedsThreshold: promptRiskProviders.length > 0,
    providers: promptRiskProviders,
    promptBytesByProvider,
    // Archives upload natively and are never inlined, so including one in the
    // "forced inline fallback" plan would describe a split that cannot happen.
    splitPlan: splitAttachmentFiles(attachmentStats.filter((item) => !isArchiveAttachment(item.filePath)), PROMPT_SIZE_WARN_BYTES),
    splitPlanNote: "Reference grouping only. Attachments upload natively and are not cut at 40 KiB; these groups describe what a forced inline fallback would look like. Prompt text is never split automatically.",
    message: promptRiskProviders.length
      ? `Prompt text exceeds ${PROMPT_SIZE_WARN_BYTES / 1024} KiB for: ${promptRiskProviders.join(", ")}. ask-bridge can truncate long prompt text around 44 KiB, so the provider may answer from a partial prompt. Attachments are unaffected because they travel outside the prompt.`
      : null,
  };
  if (input.dryRun) {
    const promptBytes = Object.values(promptBytesByProvider).reduce((sum, value) => sum + value, 0);
    const actualFileAttachments = bundleLines ? nativeFiles : files;
    const actualAttachmentPaths = [...actualFileAttachments, ...images];
    const transportAttachmentBytes = (await Promise.all(actualAttachmentPaths.map(async (filePath) => (await stat(filePath)).size)))
      .reduce((sum, value) => sum + value, 0) + (bundlePreview?.bytes ?? 0);
    const attachmentSendingProviders = providers.length - (geminiInline ? 1 : 0);
    const providerAttachmentBytes = transportAttachmentBytes * attachmentSendingProviders;
    const estimatedTokens = estimateTokens(Object.values(promptByProvider).join("\n")) + Math.ceil(providerAttachmentBytes / 4);
    return { dryRun: true, preview: {
      kind: input.kind ?? "ask", mode, workspace, workspaceRoot, providers, concurrency,
      fresh: Boolean(input.fresh),
      followup: followup ? { taskId: followup.taskId, provider: followup.provider, parentJobId: followup.jobId } : null,
      briefIncludedProviders: providers.filter((provider) => basePrompts[provider] !== input.prompt),
      briefBytes: Buffer.byteLength(briefText, "utf8"), promptBytes, promptBytesByProvider,
      promptSizeRisk, filesCount: files.length, imagesCount: images.length,
      actualAttachmentCount: actualAttachmentPaths.length + (bundlePreview ? 1 : 0),
      attachmentBytes, transportAttachmentBytes, providerAttachmentBytes,
      geminiInline, geminiAttachmentBlocked, bundleLines,
      bundle: bundlePreview ? { files: bundlePreview.files, lines: bundlePreview.lines,
        bytes: bundlePreview.bytes, sha256: bundlePreview.sha256 } : null,
      estimatedTokens, tokenEstimate: "rough byte/4 heuristic; not provider tokenizer output",
      sensitiveFindings, unscannedAttachments,
      sendBlocked: sensitiveFindings.length > 0 && !input.allowSensitive,
      sizeBlocked: promptSizeRisk.exceedsThreshold && !input.allowOversize,
      blockReasons: [
        ...(sensitiveFindings.length > 0 && !input.allowSensitive ? ["SENSITIVE_CONTENT_DETECTED"] : []),
        ...(promptSizeRisk.exceedsThreshold && !input.allowOversize ? ["PROMPT_OVERSIZE"] : []),
        ...(geminiAttachmentBlocked ? ["GEMINI_ATTACHMENT_UNSUPPORTED"] : []),
      ],
      blocked: (sensitiveFindings.length > 0 && !input.allowSensitive)
        || (promptSizeRisk.exceedsThreshold && !input.allowOversize) || geminiAttachmentBlocked,
    } };
  }
  if (promptSizeRisk.exceedsThreshold && !input.allowOversize) {
    const sizes = promptRiskProviders.map((provider) => `${provider}=${promptBytesByProvider[provider]} bytes`).join(", ");
    const inlineNote = geminiInline
      ? ` Gemini's prompt includes ${geminiInline.bytes} bytes of inlined attachments because binary documents cannot be uploaded; send them as a zip or use --providers chatgpt.` : "";
    throw new WfaError("PROMPT_OVERSIZE",
      `Prompt exceeds ${PROMPT_SIZE_WARN_BYTES} bytes (${sizes}).${inlineNote} Only the prompt text is capped: attachments upload natively and are not truncated. Rewrite or split the prompt body, switch --bundle-repo to --bundle-repo=zip, or pass --allow-oversize to send anyway. --dry-run prints a file-level splitPlan; prompt text is never split automatically.`);
  }
  if (sensitiveFindings.length && !input.allowSensitive) {
    const locations = sensitiveFindings.slice(0, 12).map((item) => `${item.source}:${item.line} (${item.kind})`).join(", ");
    throw new WfaError("SENSITIVE_CONTENT_DETECTED", `Potential secrets were found at ${locations}${sensitiveFindings.length > 12 ? ", ..." : ""}. Remove them or explicitly confirm with --allow-sensitive. Matched values are never printed.`);
  }
  const requestId = slug(input.requestId || uuid(), "request_id");
  const taskId = uuid();
  const attachmentIdentities = [];
  for (const filePath of [...files, ...images]) attachmentIdentities.push({ path: filePath, sha256: await hashFile(filePath) });
  const intentHash = sha256(JSON.stringify({
    prompt: input.prompt, providers, workspace, workspaceRoot,
    // Identity comes from the bytes, not from the scratch path: a re-archived
    // repository mints a different file name for the same sources, and the old
    // path-inclusive hash turned that replay into IDEMPOTENCY_CONFLICT.
    attachments: attachmentIdentities.map((item) => item.sha256),
    options: {
      kind: input.kind ?? "ask", mode, timeoutSeconds, modelByProvider,
      // The session policy is deliberately not part of the identity: replaying
      // request_id with --continue-session must recover the original task, and
      // the default run must not look like a different request from it.
      followupTaskId: input.followupTaskId ?? null,
      bundleLines, noBrief: Boolean(input.noBrief),
      briefFile: input.briefFile ? path.resolve(workspaceRoot, input.briefFile) : null,
      explicitBriefSha256: input.briefFile ? sha256(briefText) : null,
      downloadImages: Boolean(input.downloadImages ?? config.downloadImages), concurrency,
    },
  }));
  const payloadHash = await makePayloadHash({
    promptByProvider, providers, workspace, workspaceRoot, sessionFingerprint, files, images,
    options: {
      kind: input.kind ?? "ask", mode, timeoutSeconds, modelByProvider,
      fresh: Boolean(input.fresh),
      followup: followup ? { taskId: followup.taskId, provider: followup.provider, jobId: followup.jobId } : null,
      bundleLines, briefSha256: briefText ? sha256(briefText) : null,
      downloadImages: Boolean(input.downloadImages ?? config.downloadImages), concurrency,
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

  // Ask-bridge availability is an external probe that can take a second. It
  // used to run inside the task-store lock, which made every other session wait
  // for it; nothing in the idempotency check depends on the result.
  const preflight = dependencies.skipPreflight ? null : await checkAskBridge(config);
  // A follow-up may be authorized to continue a repository-unreadable parent.
  // The deleted PolicyStore used to make that decision inside every write
  // transaction; executeTask resolves it once and passes it down, so the lock
  // check here and the snapshot the prompt is built from agree.
  const allowUnreadableFollowup = input.allowUnreadableFollowup ?? null;
  let createdJobs = [];
  const created = await store.transaction(async ({ tasks, sessions }) => {
    const previousId = tasks.requestIndex?.[requestId];
    if (previousId) {
      const previous = tasks.tasks[previousId];
      if (!previous || (previous.intentHash ? previous.intentHash !== intentHash : previous.payloadHash !== payloadHash)) {
        throw new WfaError("IDEMPOTENCY_CONFLICT", "This request_id was already used with a different payload. Use the original request_id only to recover the same request; use a new request_id for an intentional new task.");
      }
      return { existing: previous };
    }
    assertUpstreamAvailable(tasks);
    const blocking = workspaceHasBlockingTask(tasks.tasks, workspace, providers, null, allowUnreadableFollowup);
    if (blocking) {
      const reason = blocking.executionPending
        ? `The owning ask-bridge process is still finishing cleanup. Run \`wfa wait ${blocking.taskId}\`, then retry after it exits.`
        : `Inspect it with \`wfa status ${blocking.taskId}\`. If the original generation is no longer active and cannot be collected, run \`wfa resolve ${blocking.taskId} --provider ${blocking.provider} --confirm\`. --new-session does not bypass a request that may already have been submitted; only failures proven to happen before submission (tab/load errors, send-button failures, attachment-upload timeouts) release the lock automatically.${blocking.cooldownUntil ? ` Cooldown remains active until ${blocking.cooldownUntil}.` : ""}`;
      throw new WfaError("WORKSPACE_PROVIDER_LOCKED",
        `Workspace "${workspace}" is locked by ${blocking.provider} task ${blocking.taskId} (${blocking.state}). ${reason}`);
    }
    const latestSessions = workspaceSessions(tasks.tasks, sessions, workspace, providers);
    if (followup) latestSessions[followup.provider] = followup.threadUrl;
    const latestPrompts = withGeminiInline(buildProviderPrompts(input, providers, latestSessions, briefText, followup, sessionPolicy), geminiInlineBody, geminiInline);
    const latestSessionFingerprint = relevantSessionFingerprint(latestSessions, providers, sessionPolicy === "fresh");
    if (JSON.stringify(latestPrompts) !== JSON.stringify(promptByProvider)
      || JSON.stringify(latestSessionFingerprint) !== JSON.stringify(sessionFingerprint)) {
      throw new WfaError("SESSION_CHANGED_RETRY", "Workspace conversation state changed while preparing this request. Re-run the command; no provider request was sent.");
    }
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
      taskId, providers, prompt: input.prompt, promptByProvider, timeoutSeconds,
      sessions: latestSessions, fresh: sessionPolicy === "fresh", files: jobFiles,
      filesByProvider, images, modelByProvider,
      allowGeminiAttachments: Boolean(input.allowGeminiAttachments),
      downloadImages: Boolean(input.downloadImages ?? config.downloadImages),
    });
    createdJobs = jobs;
    await writeFile(inputFile, `${jobs.map((job) => JSON.stringify(job)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    try { await chmod(inputFile, 0o600); } catch {}
    const now = new Date().toISOString();
    const children = Object.fromEntries(providers.map((provider) => {
      const job = jobs.find((item) => item.provider === provider);
      return [provider, {
        provider, jobId: job.id, state: "queued", revision: 0,
        threadUrl: null, resultPath: null, error: null, errorCode: null,
        recoveryHint: null, childPid: null,
      }];
    }));
    const sessionBaseline = workspaceSessions(
      Object.fromEntries(Object.entries(tasks.tasks).filter(([key]) => key !== taskId)),
      sessions, workspace, providers,
    );
    if (followup) sessionBaseline[followup.provider] = followup.threadUrl;
    const task = {
      taskId, requestId, payloadHash, intentHash, kind: input.kind ?? "ask", mode,
      workspace, workspaceRoot, providers, fresh: Boolean(input.fresh),
      state: "preparing", createdAt: now, updatedAt: now, heartbeatAt: input.detach ? null : now,
      attachmentCount: files.length + images.length,
      parentPid: input.detach ? null : process.pid,
      childPid: null, detached: Boolean(input.detach),
      // Fields the old PolicyStore injected through a mutable side channel.
      sessionPolicy,
      sessionBaseline,
      stallTimeoutSeconds: input.stallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS,
      bundleRepo: Boolean(input.bundleRepoShipped),
      repoReference: input.repoReference ?? null,
      lineage: followup ? [...(tasks.tasks[followup.taskId]?.lineage ?? []), followup.taskId] : [],
      runDir, outputDir, inputFile, timeoutSeconds, concurrency,
      bundlePath: bundleInfo?.bundlePath ?? null, bundleSha256: bundleInfo?.sha256 ?? null,
      briefFile: input.briefFile ? path.resolve(workspaceRoot, input.briefFile)
        : (briefText ? path.join(workspaceRoot, ".wfa", "active-brief.md") : null),
      briefSha256: briefText ? sha256(briefText) : null,
      briefInjectedProviders: providers.filter((provider) => basePrompts[provider] !== input.prompt),
      parentTaskId: followup?.taskId ?? null, parentProvider: followup?.provider ?? null,
      parentJobId: followup?.jobId ?? null, parentThreadUrl: followup?.threadUrl ?? null,
      parentResultPath: followup?.resultPath ?? null,
      geminiMode: validateGeminiMode(input.geminiMode ?? config.geminiMode ?? "chat"),
      children, processExitCode: null,
      // A detached worker can claim this token at most once. The token is not
      // exposed in task summaries and cannot be supplied by a normal CLI job.
      workerToken: input.detach && concurrency === 1 && providers.length > 1 ? uuid() : null,
      workerClaimedAt: null,
    };
    tasks.tasks[taskId] = task;
    tasks.requestIndex ??= {};
    tasks.requestIndex[requestId] = taskId;
    return { task, command };
  });
  if (created.existing) return { task: created.existing, replayed: true };
  const { task, command } = created;
  input.onTaskCreated?.(task);
  // The heartbeat proves this process is still the owner of the task, so a
  // recycled pid cannot keep the task locked after the owner has gone away.
  const heartbeat = startHeartbeat({ taskId: task.taskId, store });
  try {
    return await executePreparedTask({ task, command, config, input, store, dependencies,
      createdJobs, workspaceRoot, timeoutSeconds });
  } finally {
    heartbeat.stop();
  }
}

function positiveInteger(value, label, allowZero = false) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new WfaError("ARGUMENT_ERROR", `${label} must be ${allowZero ? "a nonnegative" : "a positive"} integer.`);
  }
  return number;
}

// The single public entry. It used to live in managed-runner.js, a second
// module that wrapped this one and could be bypassed through runner.js, so the
// same CLI options were validated in two places and behaved differently.
export async function executeTask(input, dependencies = {}) {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const repository = input.repository ?? await resolveRepository({
    cwd: workspaceRoot, repoUrl: input.repoUrl, noRepo: input.noRepo,
  });
  if (input.kind === "code" && !input.files?.length && !repository.available && !input.bundleRepo) {
    throw new WfaError("ARGUMENT_ERROR", `wfa code requires --file/--dir or a repository reference (${repository.reason}).`);
  }
  if (input.bundleRepo && input.noRepo) {
    throw new WfaError("ARGUMENT_ERROR", "--bundle-repo cannot be combined with --no-repo.");
  }
  // Checked before `fresh` is derived from sessionPolicy below, which would
  // otherwise hide the conflict.
  if (input.followupTaskId && input.fresh) {
    throw new WfaError("FOLLOWUP_FRESH_CONFLICT", "--followup cannot be combined with --new-session/--fresh.");
  }
  if (input.continueSession && input.fresh) {
    throw new WfaError("ARGUMENT_ERROR", "--continue-session cannot be combined with --new-session/--fresh.");
  }
  const stallTimeoutSeconds = positiveInteger(input.stallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS, "--stall-timeout", true);
  const sessionPolicy = input.followupTaskId || input.continueSession ? "continue" : "fresh";
  const bundleMode = input.bundleRepoMode === "zip" ? "zip" : "inline";
  const home = dependencies.home;
  const store = dependencies.store ?? new Store(home);
  const bundle = input.bundleRepo && bundleMode === "inline" ? await bundleRepository({
    cwd: workspaceRoot, excludes: input.repoExcludes ?? [], includes: input.files ?? [], prompt: input.prompt,
  }) : null;
  // A zip attachment carries the same sources as the inline bundle but travels
  // as a native upload, so prompt truncation cannot corrupt it.
  const archive = input.bundleRepo && bundleMode === "zip" ? await archiveRepository({
    cwd: workspaceRoot, excludes: input.repoExcludes ?? [], prompt: input.prompt,
    outDir: path.join(getPaths(home).home, "archives"), requestId: input.requestId ?? null,
  }) : null;
  if (bundle && !bundle.stats.listed) {
    throw new WfaError("BUNDLE_REPO_EMPTY", "--bundle-repo found no eligible tracked files. Select paths with --file or adjust --exclude.");
  }
  // Decided before prepareRequest because its transaction has to let this
  // follow-up past the very lock its unreadable parent holds.
  let allowUnreadableFollowup = null;
  if (input.followupTaskId) {
    const intentSnapshot = await store.snapshot();
    const followupProvider = input.providers?.length === 1 ? input.providers[0] : input.provider;
    if (followupProvider
      && intentSnapshot.tasks.tasks[input.followupTaskId]?.children?.[followupProvider]?.repoUnreadable) {
      allowUnreadableFollowup = { taskId: input.followupTaskId, provider: followupProvider };
    }
  }
  let prompt = input.prompt;
  const shipsRepository = repository.available && !bundle && !archive;
  // The inline bundle and the remote-reading contract are mutually exclusive.
  // In particular do not ask a bundled follow-up to return REPO_UNREADABLE.
  if (shipsRepository) prompt = `${repositoryBlock(repository)}\n\n${prompt}`;
  if (bundle) prompt += `\n\n${bundle.content}\nEND SOURCE BUNDLE`;
  if (archive) prompt += `\n\n${repositoryArchiveBlock(archive, repository)}\n`;
  try {
    const result = await prepareRequest({
      ...input, prompt, workspaceRoot,
      // `fresh` stays the caller's explicit flag; the session the run actually
      // uses comes from sessionPolicy below, so a default ask does not look
      // like a brand-new request to every provider.
      fresh: Boolean(input.fresh),
      noBrief: Boolean(input.noBrief || (shipsRepository && !input.briefFile)),
      files: bundle ? [] : (archive ? [...(input.files ?? []), archive.file] : input.files),
      bundleLines: bundle || archive ? false : input.bundleLines,
      // Zip entries are scanned while they are packed; hand the findings to the
      // same gate the inline bundle goes through.
      archiveScan: archive ? {
        file: archive.file,
        findings: archive.secretFindings ?? [],
        scannedFiles: archive.scannedFiles ?? 0,
        totalFiles: archive.stats.files,
      } : null,
      // One provider per batch is the production default so a tab closed by one
      // job cannot take another provider's page with it. Tests and library
      // callers that pass no workspaceRoot keep both jobs in one batch.
      sequentialBatches: Boolean(input.sequentialBatches ?? (Boolean(input.workspaceRoot) && repository.available)),
      sessionPolicy,
      allowUnreadableFollowup,
      stallTimeoutSeconds,
      bundleRepoShipped: Boolean(bundle) || Boolean(archive),
      repoReference: shipsRepository ? {
        url: repository.url, branch: repository.branch, commit: repository.commit,
        warnings: repository.warnings ?? [],
      } : null,
    }, {
      ...dependencies, store,
      runProcess: (...args) => guardedBatch(dependencies.runProcess ?? runProcess, ...args, store, stallTimeoutSeconds),
    });
    if (result.dryRun) {
      result.preview.repository = repository;
      result.preview.repositoryWarnings = repository.warnings ?? [];
      result.preview.bundleRepo = bundle?.stats ?? null;
      result.preview.repositoryArchive = archive?.stats ?? null;
      result.preview.sessionPolicy = sessionPolicy;
      result.preview.stallTimeoutSeconds = stallTimeoutSeconds;
    }
    return result;
  } catch (error) {
    if (bundle && error.code === "PROMPT_OVERSIZE") {
      throw new WfaError("PROMPT_OVERSIZE", `${error.message} For a whole-repository request prefer --bundle-repo=zip, which attaches the sources instead of inlining them; otherwise narrow the bundle with --file <path> and --exclude 'docs/**'. Do not rely on --allow-oversize because upstream truncates prompt text.`);
    }
    throw error;
  }
}
