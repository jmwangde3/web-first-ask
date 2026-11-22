import { getHomeDir } from "../paths.js";
import { recoverBrowser } from "../browser/recovery.js";
import { runCdpTurn } from "../engines/cdp-engine.js";
import { WfaError } from "../errors.js";

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
      if (cachedRecovery?.key === cacheKey && cachedRecovery.rec?.action !== "RECOVERY_REQUIRED" &&
          cachedRecovery.rec?.chrome?.port && await isPortAlive(cachedRecovery.rec.chrome.port)) {
        return cachedRecovery.rec;
      }

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

  async function run(turn, signal) {
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

    try {
      if (turnController.signal.aborted) {
        return { status: "failed", reason: "cancelled", text: "" };
      }

      let rec;
      try {
        rec = await dedupedRecover({
          home: runnerHome,
          mode: effectiveMode,
          chromePath,
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

      const turnDeps = {
        ...deps,
        recoverBrowser: dedupedRecover,
      };

      const result = await runTurnFn({
        provider: turn.provider,
        prompt: turn.prompt,
        home: runnerHome,
        mode: effectiveMode,
        chromePath,
        settleMs,
        stallTimeoutMs,
        hardTimeoutMs,
        signal: turnController.signal,
        deps: turnDeps,
      });

      if (turnController.signal.aborted || result?.reason === "cancelled" || result?.reason === "CANCELLED") {
        return {
          status: "failed",
          reason: "cancelled",
          text: "",
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
