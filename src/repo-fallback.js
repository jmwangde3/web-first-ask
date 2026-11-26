import { WfaError } from "./errors.js";
import { sha256 } from "./util.js";
import { matchRepoUnreadable, repositoryFallbackCommand } from "./repository.js";
import { selectRepoFallbackTransport } from "./bundle.js";
import { probeArchiveFallback } from "./repository-archive.js";

// F8 — GitHub read failure fallback.
//
// When a provider cannot read the referenced repository it answers
// REPO_UNREADABLE (see matchRepoUnreadable in src/repository.js). The run
// used to stop there with a manual fallback command. This module decides
// whether an automatic fallback retry is safe and, if so, describes the NEW
// turn that must be submitted: same conversation, bundled input (inline
// bundle or attached archive), a fresh request_id derived from the parent
// turn (N1 request_id idempotency shape — a new submission with different
// input gets a new id, and re-deciding the same parent yields the same id
// so the retry can be re-driven without minting a duplicate turn).
//
// This is a decision + record-keeping module only. It does not submit
// anything: the engine that owns the turn (ask-bridge path in
// src/runner-stall.js, which today terminates the run at `repo_unreadable`,
// or the CDP path in src/engines/, which does not detect the sentinel yet)
// must call decideRepoFallback when it observes the signal and submit the
// described turn itself, e.g. via executeTask with followupTaskId set to
// the parent task and --bundle-repo (zip) or --bundle-repo (inline).
// Never auto-resend the failed prompt: the retry input is bundled sources,
// not the original prompt text.

const FALLBACK_INSTRUCTIONS = {
  zip: "Extract the attached repository archive and use it with the original conversation to answer the request. Name the exact path of any file missing from the archive instead of guessing.",
  inline: "Use the inlined repository sources with the original conversation to answer the request. Name the exact path of any file missing from the bundle instead of guessing.",
};

function fallbackRequestId({ parentTaskId, parentRequestId, transport, provider }) {
  return `repo-fallback-${sha256(`${parentTaskId ?? ""}:${parentRequestId ?? ""}:${transport}:${provider ?? ""}`).slice(0, 24)}`;
}

// Pure decision function. `signal` is everything the caller observed:
//   answerText / errorText — provider output to match the sentinel against
//   provider, parentTaskId, parentRequestId, workspace, kind — the parent turn
//   repoAvailable — the turn referenced a repository that exists locally
//   bundleAlreadyUsed — the failed turn already shipped bundled sources
//   fallbackAlreadyUsed — a fallback retry was already recorded for this turn
//   archiveAvailable, inlineBytes — transports the retry can use
export function decideRepoFallback({
  answerText = "", errorText = "", provider, parentTaskId, parentRequestId,
  workspace, kind = "ask", repoAvailable = false, bundleAlreadyUsed = false,
  fallbackAlreadyUsed = false, archiveAvailable = false, inlineBytes = null,
} = {}) {
  const answerMatch = matchRepoUnreadable(answerText);
  const errorMatch = !answerMatch && /\bREPO_UNREADABLE\b/.test(String(errorText ?? ""))
    ? { matched: "REPO_UNREADABLE", kind: "error-text" } : null;
  const evidence = answerMatch ?? errorMatch;
  if (!evidence) {
    return { action: "none", repoUnreadable: false, reason: "no-repo-unreadable-signal", evidence: null };
  }
  if (!repoAvailable) {
    return { action: "none", repoUnreadable: true, reason: "no-local-repository", evidence,
      detail: "The provider could not read the repository, but there is no local copy to bundle." };
  }
  if (fallbackAlreadyUsed) {
    return { action: "none", repoUnreadable: true, reason: "fallback-already-attempted", evidence,
      detail: "A bundled fallback retry was already recorded for this turn; do not loop." };
  }
  if (bundleAlreadyUsed) {
    return { action: "none", repoUnreadable: true, reason: "bundle-already-sent", evidence,
      detail: "The failed turn already shipped bundled sources; resending the same input is not a new submission." };
  }
  const picked = selectRepoFallbackTransport({ inlineBytes, archiveAvailable });
  if (picked.transport === "none") {
    return { action: "none", repoUnreadable: true, reason: "no-fallback-transport", evidence, detail: picked.reason };
  }
  const transport = picked.transport;
  const newRequestId = fallbackRequestId({ parentTaskId, parentRequestId, transport, provider });
  return {
    action: "retry-with-bundle",
    repoUnreadable: true,
    evidence,
    transport,
    transportReason: picked.reason,
    provider,
    followupTaskId: parentTaskId,
    parentTaskId,
    parentRequestId: parentRequestId ?? null,
    newRequestId,
    workspace,
    kind,
    // The retry is a NEW submission: same conversation (followup), different
    // input (bundled sources). The original prompt text is never re-sent.
    instruction: FALLBACK_INSTRUCTIONS[transport],
    command: parentTaskId && provider && workspace
      ? repositoryFallbackCommand(parentTaskId, provider, workspace, kind) : null,
  };
}

// Record that a fallback retry was decided, on the parent turn's child
// record. The parent keeps its `repo_unreadable` verdict; the retry is a
// separate turn identified by newRequestId. Throws instead of recording
// twice, so a second trigger cannot mint a second retry.
export function recordRepoFallback(child, decision, { now = new Date() } = {}) {
  if (!child || typeof child !== "object") throw new WfaError("INVALID_ARGUMENT", "recordRepoFallback requires the parent turn's child record.");
  if (!decision || decision.action !== "retry-with-bundle") {
    throw new WfaError("REPO_FALLBACK_NOT_APPLICABLE", `No fallback retry to record: ${decision?.reason ?? "no decision"}.`);
  }
  if (child.repoFallbackUsed) {
    throw new WfaError("REPO_FALLBACK_ALREADY_RECORDED", `A bundled fallback retry was already recorded for this turn (request ${child.repoFallback?.newRequestId ?? "unknown"}).`);
  }
  child.repoFallbackUsed = true;
  child.repoFallback = {
    transport: decision.transport,
    newRequestId: decision.newRequestId,
    followupTaskId: decision.followupTaskId,
    parentTaskId: decision.parentTaskId,
    provider: decision.provider,
    attemptedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    action: decision.action,
  };
  child.recoveryHint = `Repository unreadable. Bundled fallback retry recorded (${decision.transport}, new request ${decision.newRequestId}); submit it as a new turn continuing this conversation. Do not resend the original prompt.`;
  return child;
}

// Async planner: probes the archive transport for a local checkout, then
// decides. `inlineBytes` is the caller's estimate of the inline bundle size
// (null when unknown); pass archiveAvailable explicitly to skip the probe.
export async function planRepoFallback({ cwd = process.cwd(), excludes = [], ...signal } = {}) {
  const probe = signal.archiveAvailable === undefined
    ? await probeArchiveFallback({ cwd, excludes })
    : { available: signal.archiveAvailable, transport: "zip", files: null, reason: null };
  const decision = decideRepoFallback({ ...signal, archiveAvailable: probe.available });
  return { ...decision, probe };
}
