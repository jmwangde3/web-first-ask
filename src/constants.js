export const PROVIDERS = Object.freeze(["chatgpt", "gemini", "claude"]);

export const BLOCKING_STATES = new Set([
  "queued",
  "running",
  "failed",
  "timed_out",
  "recoverable",
  "interrupted_unknown",
  "rate_limited",
  "login_required",
  "cloudflare_blocked",
]);

export const DEFAULT_CONFIG = Object.freeze({
  askBridgePath: null,
  defaultProvider: "chatgpt",
  defaultTimeoutSeconds: 1200,
  maxTimeoutSeconds: 7200,
  defaultCompareProviders: ["chatgpt", "gemini"],
  maxConcurrency: 3,

  downloadImages: false,
});
