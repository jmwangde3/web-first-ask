export const PROVIDERS = Object.freeze(["chatgpt", "gemini", "claude"]);

// ask-bridge writes nothing at all while a page generates — no progress line and
// no metadata update — so the watchdog only sees silence. Five minutes sits
// inside the normal range for a few hundred lines of code, which made wfa kill
// healthy long answers and lose them. Fifteen minutes with the browser-log veto
// in runner-stall leaves room for a real generation and still recovers a dead
// tab long before --timeout.
export const DEFAULT_STALL_TIMEOUT_SECONDS = 900;

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
