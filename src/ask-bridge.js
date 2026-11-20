import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { WfaError } from "./errors.js";
import { truncate } from "./util.js";

export async function spawnDetached(command, args, {
  cwd,
  env = process.env,
  stdoutPath,
  stderrPath,
} = {}) {
  if (!stdoutPath || !stderrPath) {
    throw new WfaError("DETACH_LOG_PATH_REQUIRED", "Detached execution needs task-scoped stdout/stderr log paths.");
  }
  let stdout = null;
  let stderr = null;
  let child = null;
  try {
    stdout = await open(stdoutPath, "wx", 0o600);
    stderr = await open(stderrPath, "wx", 0o600);
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!Number.isInteger(child.pid) || child.pid <= 0) {
      throw new WfaError("DETACHED_SPAWN_UNCONFIRMED", "ask-bridge did not provide a valid launched PID.");
    }
    // The detached child owns the saved task logs; errors after the confirmed
    // spawn are visible as incomplete metadata, not a signal to resend.
    child.on("error", () => {});
    child.unref();
    return { pid: child.pid };
  } finally {
    await stdout?.close().catch(() => {});
    await stderr?.close().catch(() => {});
  }
}

export function resolveAskBridge(config = {}, env = process.env) {
  return env.ASK_BRIDGE_BIN || config.askBridgePath || (process.platform === "win32" ? "ask-bridge.exe" : "ask-bridge");
}

export function runProcess(command, args, {
  cwd,
  inherit = false,
  env = process.env,
  onSpawn,
  onStdout,
  input,
  timeoutMs,
  killGraceMs = 5000,
  drainGraceMs = 1000,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let spawned = false;
    let exited = false;
    let processError = null;
    let timedOut = false;
    let stdioDrainTimedOut = false;
    let timeoutHandle = null;
    let forceKillHandle = null;
    let watchdogHandle = null;
    let drainHandle = null;
    let spawnCallback = Promise.resolve();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (watchdogHandle) clearTimeout(watchdogHandle);
      if (drainHandle) clearTimeout(drainHandle);
      resolve({ ...result, processError, timedOut, stdioDrainTimedOut });
    };

    const destroyPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finishAfterSpawnCallback = async (code, signal, childMayRun = false) => {
      await spawnCallback;
      finish({ code, signal, stdout, stderr, spawnError: null, pid: child.pid ?? null, childMayRun });
    };

    const signalChild = (signal) => {
      try {
        if (!child.kill(signal) && !exited) {
          processError ??= new Error(`Could not signal ask-bridge with ${signal}`);
        }
      } catch (error) {
        processError ??= error;
      }
    };

    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: !inherit,
        stdio: inherit ? (input === undefined ? "inherit" : ["pipe", "inherit", "inherit"]) : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ code: null, signal: null, stdout, stderr, spawnError: error });
      return;
    }

    child.once("spawn", () => {
      spawned = true;
      if (input !== undefined && child.stdin) child.stdin.end(String(input), "utf8");
      spawnCallback = Promise.resolve().then(() => onSpawn?.(child.pid ?? null)).catch(() => {});
    });

    if (!inherit) {
      child.stdout?.on("data", (chunk) => {
        stdout = truncate(stdout + chunk.toString("utf8"), 200000);
        onStdout?.(stdout);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = truncate(stderr + chunk.toString("utf8"), 12000);
      });
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        signalChild("SIGTERM");
        forceKillHandle = setTimeout(() => {
          if (exited) return;
          signalChild("SIGKILL");
          watchdogHandle = setTimeout(() => {
            if (exited) return;
            processError ??= new Error("ask-bridge did not exit after the watchdog tried to stop it");
            child.unref();
            destroyPipes();
            void finishAfterSpawnCallback(null, null, true);
          }, 1000);
        }, killGraceMs);
      }, timeoutMs);
    }

    child.on("error", (error) => {
      if (spawned) {
        processError ??= error;
      } else {
        finish({ code: null, signal: null, stdout, stderr, spawnError: error, pid: child.pid ?? null });
      }
    });

    child.once("exit", (code, signal) => {
      exited = true;
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
      if (watchdogHandle) {
        clearTimeout(watchdogHandle);
        watchdogHandle = null;
      }

      drainHandle = setTimeout(() => {
        stdioDrainTimedOut = true;
        destroyPipes();
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
