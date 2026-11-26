import path from "node:path";
import { classifyProviderError } from "../provider-errors.js";
import { decideRepoFallback, recordRepoFallback } from "../repo-fallback.js";
import { probeArchiveFallback, archiveRepository } from "../repository-archive.js";
import { bundleRepository } from "../repository.js";

// F8 — automatic REPO_UNREADABLE fallback for the CDP ask path.
//
// When a provider turn completes with the REPO_UNREADABLE sentinel (a
// provider answer, not a failure — see classifyProviderError), this submits
// exactly ONE follow-up turn through the broker: same conversation, a NEW
// request id from decideRepoFallback, bundled input (attached archive when
// available, inline bundle otherwise), never the original prompt. The
// fallback turn itself is never re-checked, so a second REPO_UNREADABLE
// cannot loop. The ask-bridge path is untouched: it still only records the
// manual fallback command (runner-stall.js).
//
// `prompt` (the original prompt text) is used only to select which tracked
// files the bundle prioritises; it is never sent in the fallback turn.

export async function maybeRepoFallback({
  turn,
  provider,
  prompt = "",
  parentRequestId,
  conversationId = null,
  workspace,
  mode = "background",
  settleMs,
  stallTimeoutMs,
  hardTimeoutMs,
  minIntervalMs,
  record,
  home,
  createTurn,
  waitForTurn,
  onProgress,
  deps = {},
  probeArchive = probeArchiveFallback,
  buildArchive = archiveRepository,
  buildBundle = bundleRepository,
} = {}) {
  const classified = classifyProviderError({
    answerText: typeof turn?.text === "string" ? turn.text : null,
    error: typeof turn?.reason === "string" ? turn.reason : "",
    state: turn?.state,
    hasResponse: Boolean(turn?.text),
  });
  if (classified.errorCode !== "REPO_UNREADABLE") {
    return { attempted: false };
  }

  const workspaceRoot = path.resolve(workspace || process.cwd());
  const probe = await probeArchive({ cwd: workspaceRoot });

  // The CDP ask path never ships a repo bundle (there is no --bundle-repo
  // flag on `wfa cdp ask`), so the failed turn cannot already have used one.
  // Inline size is only needed when no archive is available.
  let inlineBytes = null;
  let inlineBundle = null;
  if (!probe.available) {
    try {
      inlineBundle = await buildBundle({ cwd: workspaceRoot, prompt });
      inlineBytes = Buffer.byteLength(inlineBundle.content, "utf8");
    } catch {
      inlineBytes = null;
    }
  }

  const decision = decideRepoFallback({
    answerText: turn?.text ?? "",
    errorText: typeof turn?.reason === "string" ? turn.reason : "",
    provider,
    parentTaskId: turn?.id ?? null,
    parentRequestId,
    workspace: workspaceRoot,
    kind: "ask",
    repoAvailable: probe.available,
    bundleAlreadyUsed: false,
    fallbackAlreadyUsed: false,
    archiveAvailable: probe.available,
    inlineBytes,
  });
  if (decision.action !== "retry-with-bundle") {
    return { attempted: false, detected: true, decision };
  }

  // Record first: recordRepoFallback throws if a retry was already recorded
  // for this turn, so a second trigger cannot mint a second retry turn.
  const child = {};
  recordRepoFallback(child, decision);

  let fallbackPrompt = decision.instruction;
  let fallbackFiles = [];
  if (decision.transport === "zip") {
    const archive = await buildArchive({
      cwd: workspaceRoot,
      prompt,
      requestId: decision.newRequestId,
      outDir: path.join(workspaceRoot, ".wfa"),
    });
    fallbackFiles = [archive.file];
  } else {
    const bundle = inlineBundle ?? await buildBundle({ cwd: workspaceRoot, prompt });
    fallbackPrompt = `${decision.instruction}\n\n${bundle.content}`;
  }

  const created = await createTurn(record, {
    provider,
    prompt: fallbackPrompt,
    mode,
    requestId: decision.newRequestId,
    settleMs,
    stallTimeoutMs,
    hardTimeoutMs,
    ...(conversationId != null ? { conversationId } : {}),
    ...(fallbackFiles.length > 0 ? { files: fallbackFiles } : {}),
    ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
  });
  if (created?.status !== undefined && ![200, 202].includes(created.status)) {
    return {
      attempted: true,
      decision,
      record: child,
      fallbackTurn: null,
      error: created?.json ?? created,
    };
  }
  const fallbackTurnId = created?.json?.id;
  if (!fallbackTurnId) {
    return {
      attempted: true,
      decision,
      record: child,
      fallbackTurn: null,
      error: { code: "BROKER_ERROR", message: "Fallback turn was not created" },
    };
  }

  const fallbackTurn = await waitForTurn({
    record,
    turnId: fallbackTurnId,
    home,
    timeoutMs: hardTimeoutMs,
    ...(onProgress ? { onProgress } : {}),
    deps,
  });
  return { attempted: true, decision, record: child, fallbackTurn };
}
