import { getHomeDir } from "../paths.js";
import { recoverBrowser } from "../browser/recovery.js";
import { runCdpTurn } from "../engines/cdp-engine.js";
import { WfaError } from "../errors.js";
import * as defaultJournal from "./journal.js";

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export function createCdpRunner({
  home,
  mode = "background",
  chromePath,
  settleMs = 4000,
  stallTimeoutMs = 180000,
  hardTimeoutMs = 900000,
  deps = {},
} = {}) {
  if (!["background", "visible", "headless"].includes(mode)) {
    throw new WfaError("INVALID_ARGUMENT", `Invalid runner mode: ${mode}. Must be background, visible, or headless.`);
  }

  const runnerMode = mode;
  const runnerHome = home || getHomeDir();
  const runTurnFn = deps.runCdpTurn || runCdpTurn;
  const realRecover = deps.recoverBrowser || recoverBrowser;
  const fetchFn = deps.fetch || globalThis.fetch;

  let lastChrome = null;
  let cachedRecovery = null;
  let recoveryMutex = Promise.resolve();

  const turnControllers = new Map();

  async function isPortAlive(port) {
    if (!port) return false;
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return Boolean(res && (res.ok || res.status === 200));
    } catch {
      return false;
    }
  }

  async function dedupedRecover(opts = {}) {
    const current = recoveryMutex;
    let release;
    recoveryMutex = new Promise((resolve) => { release = resolve; });

    try {
      await current;
    } catch {}

    try {
      const cacheKey = `${opts.home || runnerHome}::${opts.mode || runnerMode}`;
      const checkPidAlive = deps.isPidAlive || deps.probes?.isPidAlive || isPidAlive;
      if (cachedRecovery?.key === cacheKey && cachedRecovery.rec?.action !== "RECOVERY_REQUIRED" &&
          cachedRecovery.rec?.chrome?.pid && checkPidAlive(cachedRecovery.rec.chrome.pid) &&
          cachedRecovery.rec?.chrome?.port && await isPortAlive(cachedRecovery.rec.chrome.port)) {
        return cachedRecovery.rec;
      }
      cachedRecovery = null;
      lastChrome = null;

      const recFn = opts.recoverBrowser || realRecover;
      const rec = await recFn({
        home: opts.home || runnerHome,
        mode: opts.mode || runnerMode,
        chromePath: opts.chromePath || chromePath,
        probes: deps.probes,
      });

      cachedRecovery = { key: cacheKey, rec };
      if (rec?.chrome?.pid && rec?.chrome?.port) {
        lastChrome = {
          pid: rec.chrome.pid,
          port: rec.chrome.port,
          mode: opts.mode || runnerMode,
        };
      } else {
        lastChrome = null;
      }
      return rec;
    } finally {
      release();
    }
  }

  async function recover(opts = {}) {
    try {
      return await dedupedRecover(opts);
    } catch (err) {
      return {
        action: "RECOVERY_REQUIRED",
        reason: String(err?.code ?? "recovery_failed").toLowerCase(),
        evidence: err,
      };
    }
  }

  function cancel(turnId) {
    if (!turnId) return;
    const ctrl = turnControllers.get(turnId);
    if (ctrl) {
      ctrl.abort();
    }
  }

  async function run(turn, signal, { onProgress } = {}) {
    if (signal?.aborted) {
      return { status: "failed", reason: "cancelled", text: "" };
    }

    const turnId = turn?.id;
    const turnController = new AbortController();
    if (turnId) {
      turnControllers.set(turnId, turnController);
    }

    const onAbort = () => {
      turnController.abort();
    };
    if (signal) {
      if (signal.aborted) {
        turnController.abort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const effectiveMode = ["background", "visible", "headless"].includes(turn?.mode)
      ? turn.mode
      : runnerMode;
    const effectiveChromePath = turn?.chromePath ?? chromePath;
    const effectiveSettleMs = turn?.settleMs ?? settleMs;
    const effectiveStallTimeoutMs = turn?.stallTimeoutMs ?? stallTimeoutMs;
    const effectiveHardTimeoutMs = turn?.hardTimeoutMs ?? hardTimeoutMs;

    try {
      if (turnController.signal.aborted) {
        return { status: "failed", reason: "cancelled", text: "" };
      }

      let rec;
      try {
        rec = await dedupedRecover({
          home: runnerHome,
          mode: effectiveMode,
          chromePath: effectiveChromePath,
        });
      } catch (err) {
        return {
          status: "failed",
          reason: String(err?.code ?? "recovery_failed").toLowerCase(),
          text: "",
        };
      }

      if (rec?.action === "RECOVERY_REQUIRED") {
        return {
          status: "needs_human",
          text: "",
          reason: rec.reason,
          evidence: rec.evidence,
        };
      }

      if (turnController.signal.aborted) {
        return { status: "failed", reason: "cancelled", text: "" };
      }

      const journal = deps.journal || defaultJournal;
      const turnDeps = {
        ...deps,
        recoverBrowser: dedupedRecover,
        onSendIntent: ({ provider, prompt }) => journal.recordCommit(runnerHome, {
          turnId,
          provider,
          promptSha256: journal.hashPrompt(prompt),
          conversationId: turn.conversationId,
        }),
        onSendAborted: () => journal.clearCommit(runnerHome, turnId),
      };

      const onWait = typeof onProgress === "function"
        ? (remainingMs) => {
            if (Number.isFinite(remainingMs) && remainingMs > 0) {
              onProgress({ cooldownWaitMs: remainingMs, cooldownWaitAt: Date.now() });
            }
          }
        : undefined;

      const result = await runTurnFn({
        provider: turn.provider,
        prompt: turn.prompt,
        home: runnerHome,
        mode: effectiveMode,
        chromePath: effectiveChromePath,
        settleMs: effectiveSettleMs,
        stallTimeoutMs: effectiveStallTimeoutMs,
        hardTimeoutMs: effectiveHardTimeoutMs,
        ...(typeof turn?.conversationId === "string" && turn.conversationId.trim()
          ? { conversationId: turn.conversationId }
          : {}),
        ...(Array.isArray(turn?.files) && turn.files.length > 0 ? { files: turn.files } : {}),
        ...(turn?.minIntervalMs != null ? { minIntervalMs: turn.minIntervalMs } : {}),
        ...(onWait ? { onWait } : {}),
        onProgress: (patch) => {
          if (patch && typeof patch === "object" && typeof onProgress === "function") {
            onProgress(patch);
          }
        },
        signal: turnController.signal,
        deps: turnDeps,
      });

      if (turnController.signal.aborted || result?.reason === "cancelled" || result?.reason === "CANCELLED") {
        return {
          status: "failed",
          reason: "cancelled",
          text: "",
          ...(result?.conversationUrl != null ? { conversationUrl: result.conversationUrl } : {}),
          ...(result?.targetId != null ? { targetId: result.targetId } : {}),
          ...(result?.sendCommittedAt != null ? { sendCommittedAt: result.sendCommittedAt } : {}),
        };
      }

      return result;
    } catch (err) {
      if (turnController.signal.aborted || err?.code === "CANCELLED") {
        return {
          status: "failed",
          reason: "cancelled",
          text: "",
          ...(err?.sendCommittedAt != null ? { sendCommittedAt: err.sendCommittedAt } : {}),
        };
      }
      return {
        status: "failed",
        reason: String(err?.code ?? err?.message ?? "unknown_error").toLowerCase(),
        text: "",
        ...(err?.sendCommittedAt != null ? { sendCommittedAt: err.sendCommittedAt } : {}),
      };
    } finally {
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {}
      }
      if (turnId) {
        turnControllers.delete(turnId);
      }
    }
  }

  return {
    run,
    cancel,
    recover,
    get chrome() {
      return lastChrome;
    },
  };
}
