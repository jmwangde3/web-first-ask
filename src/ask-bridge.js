import { spawn } from "node:child_process";
import { WfaError } from "./errors.js";
import { truncate } from "./util.js";

export function resolveAskBridge(config = {}, env = process.env) {
  return env.ASK_BRIDGE_BIN || config.askBridgePath || (process.platform === "win32" ? "ask-bridge.exe" : "ask-bridge");
}

export function runProcess(command, args, {
  cwd,
  inherit = false,
  env = process.env,
  onSpawn,
  timeoutMs,
  killGraceMs = 5000,
  drainGraceMs = 1000,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let stdioDrainTimedOut = false;
    let timeoutHandle = null;
    let forceKillHandle = null;
    let drainHandle = null;
    let spawnCallback = Promise.resolve();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (drainHandle) clearTimeout(drainHandle);
      resolve({ ...result, timedOut, stdioDrainTimedOut });
    };

    const finishAfterSpawnCallback = async (code, signal) => {
      await spawnCallback;
      finish({ code, signal, stdout, stderr, spawnError: null, pid: child.pid ?? null });
    };

    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: !inherit,
        stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ code: null, signal: null, stdout, stderr, spawnError: error });
      return;
    }

    child.once("spawn", () => {
      spawnCallback = Promise.resolve(onSpawn?.(child.pid ?? null)).catch(() => {});
    });

    if (!inherit) {
      child.stdout?.on("data", (chunk) => {
        stdout = truncate(stdout + chunk.toString("utf8"), 200000);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = truncate(stderr + chunk.toString("utf8"), 12000);
      });
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillHandle = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      }, timeoutMs);
    }

    child.once("error", (error) => {
      finish({ code: null, signal: null, stdout, stderr, spawnError: error, pid: child.pid ?? null });
    });

    child.once("exit", (code, signal) => {
      // The main process has exited. Do not let inherited handles in a
      // descendant keep this CLI waiting forever for the later "close" event.
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
        forceKillHandle = null;
      }

      drainHandle = setTimeout(() => {
        stdioDrainTimedOut = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finishAfterSpawnCallback(code, signal);
      }, Math.max(0, drainGraceMs));
    });

    child.once("close", (code, signal) => {
      // Normally close follows exit after stdout/stderr are fully drained.
      // If it arrives within the grace period, preserve the complete output.
      if (drainHandle) {
        clearTimeout(drainHandle);
        drainHandle = null;
      }
      void finishAfterSpawnCallback(code, signal);
    });
  });
}

export async function checkAskBridge(config = {}) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supportedNode = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23;
  if (!supportedNode) {
    throw new WfaError("NODE_VERSION", `ask-bridge requires Node.js ^20.19.0, ^22.12.0 or >=23.0.0; found ${process.versions.node}.`);
  }
  const command = resolveAskBridge(config);
  const version = await runProcess(command, ["--version"], { timeoutMs: 15000 });
  if (version.spawnError || version.code !== 0) {
    throw new WfaError("ASK_BRIDGE_NOT_FOUND", `Cannot execute ask-bridge. Install it using the official instructions or set ASK_BRIDGE_BIN. ${version.spawnError?.message ?? version.stderr}`);
  }
  const rootHelp = await runProcess(command, ["--help"], { timeoutMs: 15000 });
  const rootHelpText = `${rootHelp.stdout}\n${rootHelp.stderr}`;
  if (rootHelp.spawnError || rootHelp.code !== 0 || !rootHelpText.includes("--backend")) {
    throw new WfaError("ASK_BRIDGE_BACKEND_UNAVAILABLE", "The installed ask-bridge does not expose the required --backend browser override. Update ask-bridge before using web-first-ask.");
  }
  const batchHelp = await runProcess(command, ["--backend", "browser", "batch", "--help"], { timeoutMs: 15000 });
  const helpText = `${batchHelp.stdout}\n${batchHelp.stderr}`;
  const requiredOptions = ["--input", "--concurrency", "--output-dir"];
  const missingOptions = requiredOptions.filter((option) => !helpText.includes(option));
  if (batchHelp.spawnError || batchHelp.code !== 0 || !/batch/i.test(helpText) || missingOptions.length) {
    throw new WfaError("ASK_BRIDGE_BATCH_UNAVAILABLE", `The installed ask-bridge does not expose the required batch interface. Missing: ${missingOptions.join(", ") || "batch command"}. Update ask-bridge before using web-first-ask.`);
  }
  return {
    command,
    version: (version.stdout || version.stderr).trim(),
    batchHelp: helpText,
  };
}
