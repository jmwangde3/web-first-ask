export const PROVIDERS = Object.freeze(["chatgpt", "gemini", "claude"]);

export const BLOCKING_STATES = new Set([
  "queued",
  "running",
  "failed",
  "timed_out",
  "recoverable",
  "interrupted_unknown",
  "stalled",
  "repo_unreadable",
  "rate_limited",
  "login_required",
  "cloudflare_blocked",
]);

export const DEFAULT_CONFIG = Object.freeze({
  askBridgePath: null,
  browserMode: "headless",
  // Kept for commands that need exactly one provider (`wfa login`).
  defaultProvider: "chatgpt",
  // Every ask/code request goes to both providers unless the caller narrows it.
  defaultProviders: ["chatgpt", "gemini"],
  // Serial by default; concurrent browser tabs interfere on known setups.
  defaultConcurrency: 1,
  defaultTimeoutSeconds: 1200,
  maxTimeoutSeconds: 7200,
  defaultCompareProviders: ["chatgpt", "gemini"],
  maxConcurrency: 3,
  geminiMode: "chat",

  downloadImages: false,
});
