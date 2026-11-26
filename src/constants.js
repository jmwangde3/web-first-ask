export const PROVIDERS = Object.freeze(["chatgpt", "gemini", "claude"]);

export const PROMPT_SIZE_WARN_BYTES = 40 * 1024;

// The upstream ask-bridge truncation risk described by WFA.
// Changing this constant does not change the external ask-bridge program.
export const ASK_BRIDGE_PROMPT_TRUNCATION_BYTES = 44 * 1024;

// The browser log can remain active during long generations. Two minutes
// without browser activity is the existing quiet-window threshold.
export const BROWSER_QUIET_WINDOW_SECONDS = 120;

// Shared budgets for Git subprocesses used by repository discovery,
// tracked-file selection and repository archive preparation.
export const GIT_TIMEOUT_MS = 10000;
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

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
  // With geminiMode below, the default pair is "gemini in Task mode + chatgpt".
  defaultProviders: ["gemini", "chatgpt"],
  // Dual-provider parallel by default; pass `--concurrency 1` for explicit serial fallback.
  defaultConcurrency: 2,
  defaultTimeoutSeconds: 1200,
  maxTimeoutSeconds: 7200,
  // Same pair and same order as defaultProviders: compare must not silently
  // prefer a different first provider than ask/code.
  defaultCompareProviders: ["gemini", "chatgpt"],
  maxConcurrency: 3,
  // Task is the default here: the clicker records what actually happened in
  // geminiModeReport, so a run that stayed on Chat is visible in `wfa status`
  // instead of quietly answering from the weaker mode. `--gemini-mode chat`
  // still selects Chat for one request.
  geminiMode: "task",

  // F6 (coordinator wiring): human-like pacing between CDP actions.
  // Defaults match the hard-coded behaviour: 1-2s per action, 4-6s per
  // batch, randomised. Set enabled:false (or WFA_NO_PACE=1) to disable.
  pace: {
    enabled: true,
    casualMinMs: 1000,
    casualMaxMs: 2000,
    batchMinMs: 4000,
    batchMaxMs: 6000,
  },

  downloadImages: false,
});

