import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { getHomeDir } from "../paths.js";
import { getBrowserPaths, getWfaVersion } from "./paths.js";
import { archiveLock, readLock, writeLockAtomic } from "./lock.js";
import { cdpProbe, launchChrome, readDevToolsActivePort } from "./launch.js";
import {
  findProfileOwner, getListeningPid, isPidAlive, matchCommandLineUserDataDir,
  normalizeFsPath, probeProfileLock, queryProcess, terminateProcessAndWait,
} from "./proc.js";

function newEvidence(lockResult, hasUncollectedWork) {
  return {
    lockStatus: lockResult?.status ?? "corrupt",
    phase: lockResult?.status === "ok" ? (lockResult.lock?.phase ?? null) : null,
    pidAlive: null,
    creationDiffMs: null,
    commandLineMatch: null,
    executablePathMatch: null,
    profileLock: null,
    profileOwnerPid: null,
    activePort: null,
    listeningPid: null,
    cdp: null,
    hasUncollectedWork: typeof hasUncollectedWork === "boolean" ? hasUncollectedWork : true,
    assumedUncollectedWork: typeof hasUncollectedWork !== "boolean",
  };
}

function identity(processInfo, lock, profileDir) {
  const actual = Date.parse(processInfo?.creationDate);
  const recorded = Date.parse(lock?.chromeStartedAt);
  const creationDiffMs = Number.isFinite(actual) && Number.isFinite(recorded)
    ? Math.abs(actual - recorded) : null;
  const commandLineMatch = matchCommandLineUserDataDir(processInfo?.commandLine, profileDir);
  const executablePathMatch = normalizeFsPath(processInfo?.executablePath) != null &&
    normalizeFsPath(lock?.chromePath) != null
    ? normalizeFsPath(processInfo.executablePath) === normalizeFsPath(lock.chromePath) : null;
  return {
    creationDiffMs, commandLineMatch, executablePathMatch,
    valid: creationDiffMs !== null && creationDiffMs <= 2000 &&
      commandLineMatch === "match" && executablePathMatch === true,
  };
}

function result(action, reason, evidence, lock, killPid = null) {
  return { action, reason, killPid, evidence, lock };
}

// Probes are awaited in decision-table order. No time, file or random inputs are read here.
export async function decideBrowserRecovery(input = {}) {
  const lockResult = input.lock ?? { status: "corrupt", lock: null };
  const lock = lockResult.lock ?? null;
  const evidence = newEvidence(lockResult, input.hasUncollectedWork);
  const probes = input.probes ?? {};
  const call = async (name, ...args) => {
    try {
      if (typeof probes[name] !== "function") throw new TypeError(`Missing probe: ${name}`);
      return { value: await probes[name](...args) };
    } catch (error) {
      return { failure: result("RECOVERY_REQUIRED", `probe_${name}_failed`, {
        ...evidence, probeError: error?.message ?? String(error),
      }, lock) };
    }
  };
  const profile = async () => {
    const state = await call("probeProfileLock", input.profileDir);
    if (state.failure) return state;
    evidence.profileLock = state.value;
    const found = await call("findProfileOwner", input.profileDir);
    if (found.failure) return found;
    evidence.profileOwnerPid = found.value?.pid ?? null;
    evidence.profileOwnerAmbiguous = found.value?.ambiguous === true;
    return { owner: found.value };
  };
  const free = (owner) => !owner && (evidence.profileLock === "free" || evidence.profileLock === "unknown");
  const inspectCdp = async () => {
    const found = await call("readDevToolsActivePort", input.profileDir, { timeoutMs: 3000 });
    if (found.failure) return found;
    const active = found.value;
    evidence.activePort = active?.port ?? null;
    if (!active) {
      evidence.cdp = { ok: false, error: "ACTIVE_PORT_MISSING" };
      return { connected: false };
    }
    const checked = await call("cdpProbe", active.port, { timeoutMs: 1500, attempts: 3 });
    if (checked.failure) return checked;
    evidence.cdp = checked.value;
    return { connected: evidence.cdp?.ok === true };
  };

  if (lockResult.status === "corrupt" || !["ok", "missing"].includes(lockResult.status)) {
    return result("RECOVERY_REQUIRED", "lock_corrupt", evidence, lock);
  }
  if (lockResult.status === "missing") {
    const found = await profile();
    if (found.failure) return found.failure;
    return free(found.owner)
      ? result("SAFE_START", "no_lock_profile_free", evidence, lock)
      : result("RECOVERY_REQUIRED", "no_lock_profile_held", evidence, lock);
  }
  if (!lock || !["launching", "ready"].includes(evidence.phase)) {
    return result("RECOVERY_REQUIRED", "lock_corrupt", evidence, lock);
  }
  if (evidence.phase === "launching") {
    const found = await profile();
    if (found.failure) return found.failure;
    const owner = found.owner;
    if (free(owner)) return result("SAFE_START", "launch_abandoned_profile_free", evidence, lock);
    if (owner) {
      const alive = await call("isPidAlive", owner.pid);
      if (alive.failure) return alive.failure;
      evidence.pidAlive = alive.value;
      evidence.commandLineMatch = matchCommandLineUserDataDir(owner.commandLine, input.profileDir);
      const created = Date.parse(owner.creationDate);
      const brokerStart = Date.parse(lock.brokerStartedAt);
      evidence.creationDiffMs = Number.isFinite(created) && Number.isFinite(brokerStart)
        ? created - brokerStart : null;
      if (evidence.pidAlive && evidence.commandLineMatch === "match" &&
          evidence.creationDiffMs !== null && evidence.creationDiffMs >= -2000) {
        const cdp = await inspectCdp();
        if (cdp.failure) return cdp.failure;
        if (cdp.connected) {
          const listening = await call("getListeningPid", evidence.activePort);
          if (listening.failure) return listening.failure;
          evidence.listeningPid = listening.value;
          if (evidence.listeningPid != null && evidence.listeningPid !== owner.pid) {
            return result("RECOVERY_REQUIRED", "port_owner_mismatch", evidence, lock);
          }
          return result("ADOPT", "launch_phase_verified", evidence, lock);
        }
      }
    }
    return result("RECOVERY_REQUIRED", "launch_phase_unverified", evidence, lock);
  }

  const alive = await call("isPidAlive", lock.chromePid);
  if (alive.failure) return alive.failure;
  evidence.pidAlive = alive.value;
  if (!evidence.pidAlive) {
    const found = await profile();
    if (found.failure) return found.failure;
    return free(found.owner)
      ? result("SAFE_START", "lock_pid_dead_profile_free", evidence, lock)
      : result("RECOVERY_REQUIRED", "lock_pid_dead_profile_held", evidence, lock);
  }
  const queried = await call("queryProcess", lock.chromePid);
  if (queried.failure) return queried.failure;
  const processInfo = queried.value;
  if (!processInfo) return result("RECOVERY_REQUIRED", "process_query_failed", evidence, lock);
  const checked = identity(processInfo, lock, input.profileDir);
  evidence.creationDiffMs = checked.creationDiffMs;
  evidence.commandLineMatch = checked.commandLineMatch;
  evidence.executablePathMatch = checked.executablePathMatch;
  if (!checked.valid) {
    const found = await profile();
    if (found.failure) return found.failure;
    return free(found.owner)
      ? result("SAFE_START", "identity_mismatch_profile_free", evidence, lock)
      : result("RECOVERY_REQUIRED", "identity_mismatch_profile_held", evidence, lock);
  }
  const cdp = await inspectCdp();
  if (cdp.failure) return cdp.failure;
  if (!cdp.connected) {
    return evidence.hasUncollectedWork
      ? result("RECOVERY_REQUIRED", "cdp_unreachable_has_work", evidence, lock)
      : result("SAFE_START", "cdp_unreachable_no_work", evidence, lock, lock.chromePid);
  }
  const listening = await call("getListeningPid", evidence.activePort);
  if (listening.failure) return listening.failure;
  evidence.listeningPid = listening.value;
  if (evidence.listeningPid != null && evidence.listeningPid !== lock.chromePid) {
    return result("RECOVERY_REQUIRED", "port_owner_mismatch", evidence, lock);
  }
  return result("ADOPT", "verified", evidence, lock);
}

function invalidArgument(message) {
  const error = new TypeError(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

export async function recoverBrowser(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgument("Browser recovery options must be an object");
  }
  const {
    home = getHomeDir(), hasUncollectedWork, mode = "headless", chromePath, probes = {},
  } = options;
  if (typeof home !== "string" || !home || !["headless", "headful"].includes(mode) ||
      (chromePath != null && typeof chromePath !== "string") ||
      !probes || typeof probes !== "object" || Array.isArray(probes)) {
    throw invalidArgument("Invalid browser recovery arguments");
  }
  const paths = getBrowserPaths(home);
  const tools = {
    readLock, writeLockAtomic, archiveLock, isPidAlive, queryProcess, findProfileOwner,
    probeProfileLock, getListeningPid, readDevToolsActivePort, cdpProbe, launchChrome,
    terminateProcessAndWait,
    ...probes,
  };
  let current = { status: "corrupt", lock: null };
  let evidence = newEvidence(current, hasUncollectedWork);
  const required = (reason, extra = {}) => ({ action: "RECOVERY_REQUIRED", reason,
    evidence: { ...evidence, ...extra }, paths, chrome: null });
  try {
    current = await tools.readLock(paths.lock);
    evidence = newEvidence(current, hasUncollectedWork);
    const decision = await decideBrowserRecovery({
      lock: current, profileDir: paths.profileDir, hasUncollectedWork,
      probes: tools,
    });
    evidence = decision.evidence;
    if (decision.action === "RECOVERY_REQUIRED") return required(decision.reason);

    const broker = {
      brokerPid: process.pid, brokerInstanceId: randomUUID(), brokerStartedAt: new Date().toISOString(),
    };
    if (decision.action === "ADOPT") {
      const active = await tools.readDevToolsActivePort(paths.profileDir, { timeoutMs: 3000 });
      if (!active) return required("adopt_missing_active_port");
      let owner = null;
      if (evidence.phase === "launching") {
        owner = await tools.findProfileOwner(paths.profileDir);
        if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
            !owner.creationDate || !owner.executablePath ||
            owner.pid !== evidence.profileOwnerPid ||
            matchCommandLineUserDataDir(owner.commandLine, paths.profileDir) !== "match" ||
            !(await tools.isPidAlive(owner.pid))) return required("adopt_owner_lost");
      }
      const updated = {
        ...current.lock, ...broker, phase: "ready",
        chromePid: owner?.pid ?? current.lock.chromePid,
        chromeStartedAt: owner?.creationDate ?? current.lock.chromeStartedAt,
        chromePath: owner?.executablePath ?? current.lock.chromePath,
        actualDebugPort: active.port,
      };
      if (!Number.isSafeInteger(updated.chromePid) || updated.chromePid <= 0 ||
          !updated.chromeStartedAt || !updated.chromePath) return required("adopt_owner_lost");
      await tools.writeLockAtomic(paths.lock, updated);
      return { action: "ADOPT", reason: decision.reason, evidence, paths,
        chrome: { pid: updated.chromePid, port: active.port, wsPath: active.wsPath, userDataDir: paths.profileDir } };
    }

    if (decision.killPid != null) {
      const second = await tools.queryProcess(decision.killPid);
      const verified = second && identity(second, current.lock, paths.profileDir).valid;
      if (!verified) return required("kill_reverify_failed");
      try {
        await tools.terminateProcessAndWait(decision.killPid, {
          expectedCreationDate: current.lock.chromeStartedAt, profileDir: paths.profileDir,
        });
      } catch (error) {
        return required(error?.message === "KILL_REVERIFY_FAILED" || error?.code === "KILL_REVERIFY_FAILED"
          ? "kill_reverify_failed" : "kill_failed", { killError: error?.message ?? String(error) });
      }

      // Profile lockfile release has its own 3-second window after the process exits.
      const deadline = performance.now() + 3000;
      while (true) {
        let status;
        try {
          if (typeof tools.probeProfileLock !== "function") throw new TypeError("Missing probe: probeProfileLock");
          status = await tools.probeProfileLock(paths.profileDir);
        } catch (error) {
          return required("probe_probeProfileLock_failed", { probeError: error?.message ?? String(error) });
        }
        evidence.profileLock = status;
        if (status === "free") break;
        if (status !== "held") return required("profile_lock_unknown");
        const remaining = deadline - performance.now();
        if (remaining <= 0) return required("profile_lock_timeout");
        await sleep(Math.min(100, remaining));
      }
    }
    if (current.status === "ok") await tools.archiveLock(paths.lock);
    const launching = {
      schema: 1, phase: "launching", ...broker, chromeLaunchId: randomUUID(),
      chromePid: null, chromeStartedAt: null, chromePath: chromePath ?? process.env.WFA_CHROME_PATH ?? null,
      userDataDir: path.resolve(paths.profileDir), requestedDebugPort: 0,
      actualDebugPort: null, wfaVersion: getWfaVersion(),
    };
    await tools.writeLockAtomic(paths.lock, launching);
    const started = await tools.launchChrome({ profileDir: paths.profileDir, mode, chromePath, timeoutMs: 20000 });
    const ready = {
      ...launching, phase: "ready", chromePid: started.pid,
      chromeStartedAt: started.creationDate, chromePath: started.executablePath,
      actualDebugPort: started.actualDebugPort,
    };
    await tools.writeLockAtomic(paths.lock, ready);
    return { action: "SAFE_START", reason: decision.reason, evidence, paths,
      chrome: { pid: started.pid, port: started.actualDebugPort, wsPath: started.wsPath,
        userDataDir: started.userDataDir } };
  } catch (error) {
    return required(error?.code ?? "browser_recovery_failed", {
      error: error?.message ?? String(error),
      ...(error?.probeError ? { probeError: error.probeError } : {}),
    });
  }
}
