import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./util.js";

const TERMINAL_STATES = new Set(["completed", "failed", "timed_out", "recoverable", "cancelled"]);
const PROVIDERS = new Set(["chatgpt", "gemini", "claude"]);

function sameFileVersion(before, after) {
  return Boolean(before && after
    && before.isFile() && after.isFile()
    && !before.isSymbolicLink() && !after.isSymbolicLink()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs);
}

export function isSafeProviderConversationUrl(provider, value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const paths = {
      chatgpt: { hosts: new Set(["chatgpt.com", "chat.openai.com"]), path: /^\/c\/[A-Za-z0-9_-]+(?:\/|$)/ },
      gemini: { hosts: new Set(["gemini.google.com"]), path: /^\/app\/[A-Za-z0-9_-]+(?:\/|$)/ },
      claude: { hosts: new Set(["claude.ai"]), path: /^\/chat\/[A-Za-z0-9_-]+(?:\/|$)/ },
    };
    const rule = paths[provider];
    return Boolean(rule && rule.hosts.has(url.hostname) && rule.path.test(url.pathname));
  } catch {
    return false;
  }
}

function unknown(error, metadata = null, extra = {}) {
  return {
    state: "interrupted_unknown",
    threadUrl: null,
    error,
    responsePath: null,
    metadata,
    identityVerified: false,
    trustedCompletion: false,
    completionProof: null,
    ...extra,
  };
}

async function readStableRegularFile(filePath) {
  const before = await lstat(filePath).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) return null;
  let body;
  try {
    body = await readFile(filePath);
  } catch {
    return null;
  }
  const after = await lstat(filePath).catch(() => null);
  if (!sameFileVersion(before, after) || body.length !== after.size) return null;
  return { body, sha256: sha256(body), stat: after };
}

/**
 * Read one ask-bridge batch artifact. A completed result is trusted only when:
 * - the output/job directories and both artifacts are real, non-symlink paths;
 * - metadata identity exactly matches the expected job ID and provider;
 * - metadata.state is exactly "completed" with no contradictory error;
 * - response.md is a stable, non-empty UTF-8 regular file.
 *
 * ask-bridge writes response.md before atomically writing completed metadata.
 * Thus this is a per-job terminal proof; repeated response text is never used.
 */
export async function readBatchMetadata(outputDir, jobId, expectedProvider, { runDir } = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    return unknown("ask-bridge output directory is missing from the task ledger.");
  }
  if (typeof runDir !== "string" || !runDir.trim()) {
    return unknown("Task run directory identity is unavailable; refusing to trust ask-bridge output artifacts.");
  }
  if (typeof jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(jobId) || jobId.endsWith(".")) {
    return unknown("Invalid ask-bridge job ID; refusing to construct an artifact path.");
  }
  if (!PROVIDERS.has(expectedProvider)) {
    return unknown("Expected provider is missing or unsupported; refusing to trust batch metadata.");
  }

  const outputPath = path.resolve(outputDir);
  const runPath = path.resolve(runDir);
  const runInfo = await lstat(runPath).catch(() => null);
  if (!runInfo?.isDirectory() || runInfo.isSymbolicLink()
    || outputPath !== path.resolve(runPath, "ask-bridge-output")) {
    return unknown("Task run directory is missing, not a real directory, or the ask-bridge output path is not task-owned.");
  }
  const outputInfo = await lstat(outputPath).catch(() => null);
  if (!outputInfo?.isDirectory() || outputInfo.isSymbolicLink()) {
    return unknown("ask-bridge output directory is missing, not a directory, or a symbolic link.");
  }

  const jobDir = path.join(outputPath, jobId);
  const jobInfo = await lstat(jobDir).catch(() => null);
  if (!jobInfo?.isDirectory() || jobInfo.isSymbolicLink()) {
    return unknown("ask-bridge job directory is missing, not a directory, or a symbolic link.");
  }

  const metadataPath = path.join(jobDir, "metadata.json");
  const metadataFile = await readStableRegularFile(metadataPath);
  if (!metadataFile) return unknown("ask-bridge metadata.json is missing, unstable, or not a regular non-symlink file.");

  let metadata;
  let metadataText;
  try {
    metadataText = new TextDecoder("utf-8", { fatal: true }).decode(metadataFile.body);
    metadata = JSON.parse(metadataText);
  } catch {
    return unknown("ask-bridge metadata.json is not valid UTF-8 JSON.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return unknown("ask-bridge metadata.json must contain a JSON object.", metadata);
  }

  if (metadata.id !== jobId || metadata.provider !== expectedProvider) {
    return unknown(
      `ask-bridge metadata identity mismatch (expected ${jobId}/${expectedProvider}, received ${String(metadata.id)}/${String(metadata.provider)}).`,
      metadata,
      { identityVerified: false },
    );
  }

  const state = typeof metadata.state === "string" ? metadata.state.toLowerCase() : "unknown";
  const safeThreadUrl = isSafeProviderConversationUrl(expectedProvider, metadata.threadUrl) ? metadata.threadUrl : null;
  const threadUrlWarning = metadata.threadUrl && !safeThreadUrl
    ? "ask-bridge returned a URL that does not identify a supported provider conversation; it was not saved as a reusable session."
    : null;

  if (state === "in_progress") {
    return {
      state: "interrupted_unknown",
      threadUrl: safeThreadUrl,
      error: "The batch process has not written terminal metadata. The prompt may already have been submitted; do not resend.",
      responsePath: null,
      metadata,
      identityVerified: true,
      trustedCompletion: false,
      completionProof: null,
      threadUrlWarning,
    };
  }

  if (state === "completed") {
    if (typeof metadata.error === "string" && metadata.error.trim()) {
      return unknown("ask-bridge metadata contradicts completed state with a non-empty error field.", metadata, {
        identityVerified: true,
        threadUrl: safeThreadUrl,
        threadUrlWarning,
      });
    }
    const responsePath = path.join(jobDir, "response.md");
    const responseFile = await readStableRegularFile(responsePath);
    if (!responseFile || !responseFile.body.length) {
      return {
        state: "failed",
        threadUrl: safeThreadUrl,
        error: "ask-bridge marked the job completed but response.md is missing, unstable, empty, or not a regular non-symlink file.",
        responsePath: null,
        metadata,
        identityVerified: true,
        trustedCompletion: false,
        completionProof: null,
        threadUrlWarning,
      };
    }
    let responseText;
    try {
      responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseFile.body);
    } catch {
      return {
        state: "failed",
        threadUrl: safeThreadUrl,
        error: "ask-bridge marked the job completed but response.md is not valid UTF-8.",
        responsePath: null,
        metadata,
        identityVerified: true,
        trustedCompletion: false,
        completionProof: null,
        threadUrlWarning,
      };
    }
    if (!responseText.trim()) {
      return {
        state: "failed",
        threadUrl: safeThreadUrl,
        error: "ask-bridge marked the job completed but response.md contains no non-whitespace content.",
        responsePath: null,
        metadata,
        identityVerified: true,
        trustedCompletion: false,
        completionProof: null,
        threadUrlWarning,
      };
    }

    const verifiedAt = new Date().toISOString();
    const completionProof = {
      version: 1,
      source: "ask-bridge-batch-terminal",
      jobId,
      provider: expectedProvider,
      state: "completed",
      metadataSha256: metadataFile.sha256,
      responseSha256: responseFile.sha256,
      verifiedAt,
    };
    return {
      state: "completed",
      threadUrl: safeThreadUrl,
      error: null,
      responsePath,
      metadata,
      identityVerified: true,
      trustedCompletion: true,
      completionProof,
      elapsedSeconds: Number.isFinite(metadata.elapsedSeconds) ? metadata.elapsedSeconds : null,
      pageId: Number.isInteger(metadata.pageId) ? metadata.pageId : null,
      threadUrlWarning,
    };
  }

  if (TERMINAL_STATES.has(state)) {
    return {
      state,
      threadUrl: safeThreadUrl,
      error: metadata.error ?? null,
      responsePath: null,
      metadata,
      identityVerified: true,
      trustedCompletion: false,
      completionProof: null,
      elapsedSeconds: Number.isFinite(metadata.elapsedSeconds) ? metadata.elapsedSeconds : null,
      pageId: Number.isInteger(metadata.pageId) ? metadata.pageId : null,
      threadUrlWarning,
    };
  }

  return unknown(`Unknown ask-bridge state: ${state}`, metadata, {
    identityVerified: true,
    threadUrl: safeThreadUrl,
    threadUrlWarning,
  });
}

export async function verifyStoredCompletion(outputDir, child, provider, runDir) {
  const proof = child?.completionProof;
  if (!proof) return { verified: false, legacy: true };
  if (proof.version !== 1 || proof.source !== "ask-bridge-batch-terminal"
    || proof.jobId !== child.jobId || proof.provider !== provider || proof.state !== "completed") {
    return { verified: false, error: "Stored completion proof identity or schema is invalid." };
  }
  const current = await readBatchMetadata(outputDir, child.jobId, provider, { runDir });
  if (!current.trustedCompletion || current.completionProof?.metadataSha256 !== proof.metadataSha256
    || current.completionProof?.responseSha256 !== proof.responseSha256) {
    return { verified: false, error: current.error ?? "ask-bridge terminal artifacts changed after completion was recorded." };
  }
  return { verified: true, result: current };
}
