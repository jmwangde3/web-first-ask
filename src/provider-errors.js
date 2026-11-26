import { matchRepoUnreadable } from "./repository.js";

const RATE_LIMIT_PATTERNS = [
  /\b429\b/i,
  /\brate[ -]?limit(?:ed|ing)?\b/i,
  /\btoo many requests\b/i,
  /\bplease wait\s+\d+\s*(?:s|seconds?|minutes?|hours?)?\b/i,
  /\bretry after\b/i,
  /\bretry-after\s*:/i,
];

const LOGIN_PATTERNS = [
  /\bnot logged in to (?:chatgpt|gemini|claude)\b/i,
  /\blogin required\b/i,
  /\bauthentication required\b/i,
  /\bsession (?:has )?expired\b/i,
  /\bauth(?:entication)? expired\b/i,
];

const CLOUDFLARE_PATTERNS = [
  /\bcloudflare\b/i,
  /\bturnstile\b/i,
  /\bcaptcha\b/i,
  /\bhuman verification\b/i,
];

function retryAfterSeconds(text) {
  const header = String(text).match(/retry-after\s*:\s*(\d+)/i);
  if (header) return Math.max(1, Math.min(86400, Number(header[1])));
  const dateHeader = String(text).match(/retry-after\s*:\s*([A-Z][a-z]{2},\s*\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i);
  if (dateHeader) {
    const delay = Math.ceil((Date.parse(dateHeader[1]) - Date.now()) / 1000);
    if (Number.isFinite(delay) && delay > 0) return Math.min(86400, delay);
  }
  const match = String(text).match(/(?:retry(?:\s+after|\s+in)?|try again in|available in)\s*[:=]?\s*(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "seconds").toLowerCase();
  const multiplier = /^(m|mins?|minutes?)$/.test(unit) ? 60
    : /^(h|hrs?|hours?)$/.test(unit) ? 3600
      : 1;
  return Math.max(1, Math.min(86400, amount * multiplier));
}

export function stderrForJob(stderr = "", jobId) {
  if (!jobId) return "";
  return String(stderr).split(/\r?\n/)
    .filter((line) => line.includes(jobId))
    .join("\n");
}

export function classifyProviderError({ error = "", stderr = "", jobId, state, hasResponse = false, answerText = null } = {}) {
  // F8 — REPO_UNREADABLE is a provider *answer*, not a failure: the turn
  // completed with a refusal to read the repository. It must be classified
  // before the completed-response guard below, which would otherwise return
  // a null errorCode for exactly this case. The strict sentinel match (same
  // matcher as src/repository.js) avoids quoted or explanatory false
  // positives; a bare token in error/stderr text is only a signal when the
  // turn did not complete with a response, so stale error text cannot
  // downgrade a finished answer.
  const answerMatch = answerText === null ? null : matchRepoUnreadable(answerText);
  if (answerMatch) {
    return {
      errorCode: "REPO_UNREADABLE",
      repoUnreadable: true,
      repoUnreadableEvidence: answerMatch,
      fallbackRecommended: true,
      recoveryHint: "Repository unreadable. Retry as a NEW turn with the repository bundled (inline bundle or attached archive) under a new request_id, continuing the same conversation; do not resend the original prompt.",
      retryAfterSeconds: null,
      retryAfterAt: null,
      retryAfterEstimated: false,
    };
  }
  if (state === "completed" && hasResponse) {
    return { errorCode: null, recoveryHint: null, retryAfterSeconds: null, retryAfterAt: null, retryAfterEstimated: false };
  }
  const text = [error, stderrForJob(stderr, jobId)].filter(Boolean).join("\n").trim();
  if (!text) return { errorCode: null, recoveryHint: null, retryAfterSeconds: null, retryAfterAt: null, retryAfterEstimated: false };

  if (/\bREPO_UNREADABLE\b/.test(text)) {
    return {
      errorCode: "REPO_UNREADABLE",
      repoUnreadable: true,
      repoUnreadableEvidence: { matched: "REPO_UNREADABLE", kind: "error-text" },
      fallbackRecommended: true,
      recoveryHint: "Repository unreadable. Retry as a NEW turn with the repository bundled (inline bundle or attached archive) under a new request_id, continuing the same conversation; do not resend the original prompt.",
      retryAfterSeconds: null,
      retryAfterAt: null,
      retryAfterEstimated: false,
    };
  }

  // ask-bridge can finish the answer and then fail to finalize metadata.json
  // (Windows "os error 5": a filter driver, AV scanner or a leftover handle on
  // the temp file). The answer is already on disk. Reporting the job as failed
  // loses a finished result and leaves a task that needs manual repair, so this
  // is a degraded success, not a failure.
  if (hasResponse && state !== "completed" && /failed to persist metadata\.json/i.test(text)) {
    return {
      errorCode: "METADATA_PERSIST_FAILED",
      degraded: true,
      recoveryHint: "The answer was written to response.md but ask-bridge could not finalize metadata.json. The result is kept and treated as complete but unverified; do not resend the request.",
      retryAfterSeconds: null,
      retryAfterAt: null,
      retryAfterEstimated: false,
    };
  }

  // This exact Gemini failure happens while waiting for the upload to appear,
  // i.e. before the prompt is submitted. Do not generalize it to every upload
  // error or every timeout: only this observed message is provably pre-submit.
  if (state !== "completed" && /Timed out waiting for Gemini to show attachment/i.test(String(error))) {
    return {
      errorCode: "ATTACHMENT_UPLOAD_TIMEOUT",
      recoveryHint: "Gemini timed out waiting for the attachment to appear, before the prompt was submitted. Retry once; if it repeats, send the same content as a zip/tar archive (archives upload natively and take seconds), or move the job to ChatGPT with --providers chatgpt. Inlining a large file into the prompt is the worst option: prompt text is what gets truncated.",
      retryAfterSeconds: null,
      retryAfterAt: null,
      retryAfterEstimated: false,
    };
  }

  if (CLOUDFLARE_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      errorCode: "CLOUDFLARE_BLOCKED",
      recoveryHint: "Complete the browser verification in the existing provider browser profile, then inspect the task before retrying. Do not resend an uncertain request.",
      retryAfterSeconds: null,
      retryAfterAt: null,
      retryAfterEstimated: false,
    };
  }
  if (LOGIN_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      errorCode: "LOGIN_REQUIRED",
      recoveryHint: "Run `wfa login --provider <provider>`, then inspect this task. Collect it if a response exists; otherwise resolve only after confirming the original request did not remain active.",
      retryAfterSeconds: null,
      retryAfterAt: null,
      retryAfterEstimated: false,
    };
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) {
    const seconds = retryAfterSeconds(text);
    const retryAt = new Date(Date.now() + (seconds ?? 60) * 1000).toISOString();
    return {
      errorCode: "RATE_LIMITED",
      retryAfterSeconds: seconds ?? 60,
      retryAfterAt: retryAt,
      retryAfterEstimated: seconds === null,
      recoveryHint: `Provider rate limit detected. Wait until ${retryAt}; inspect the existing task before deciding whether a new request is safe. WFA will not automatically resend.`,
    };
  }
  return {
    errorCode: "PROVIDER_ERROR",
    recoveryHint: "Inspect `wfa status <task-id>` and the per-job metadata before taking recovery action. Do not resend an uncertain request.",
    retryAfterSeconds: null,
    retryAfterAt: null,
    retryAfterEstimated: false,
  };
}
