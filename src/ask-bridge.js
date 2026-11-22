import { spawn } from "node:child_process";
import { open, readFile, readdir, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WfaError } from "./errors.js";
import { truncate } from "./util.js";

const LOG_ROTATE_BYTES = 64 * 1024 * 1024;
const LOG_KEEP_BYTES = 4 * 1024 * 1024;

function chromeConfigDir(env = process.env) {
  return env.ASK_BRIDGE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ask-bridge");
}

// ask-bridge appends to this log on every tool call, so its mtime is the only
// per-second evidence that the browser is still working. wfa's own batch output
// says nothing while a page generates.
export function chromeLogPath(env = process.env) {
  return env.ASK_BRIDGE_BROWSER_LOG || path.join(chromeConfigDir(env), "chrome-devtools-mcp.log");
}

async function findPreferences(root) {
  const result = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && result.length < 24) {
    const { dir, depth } = queue.shift();
    const direct = path.join(dir, "Preferences");
    if ((await stat(direct).catch(() => null))?.isFile()) result.push(direct);
    if (depth >= 3) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !["Cache", "Code Cache", "GPUCache", "node_modules"].includes(entry.name)) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
    if (queue.length > 128) queue.length = 128;
  }
  return result;
}

// No wrapper script is required. Only an exact `profile.exit_type: "Crashed"`
// entry is changed; malformed/unrecognized profiles are never rewritten.
export async function prepareChromeStartup({ apply = true, root = chromeConfigDir() } = {}) {
  const report = { root, inspectedProfiles: 0, crashedProfiles: [], repairedProfiles: [],
    logPath: path.join(root, "chrome-devtools-mcp.log"), logRotated: false, warnings: [] };
  for (const preferences of await findPreferences(root)) {
    report.inspectedProfiles += 1;
    try {
      const original = await readFile(preferences, "utf8");
      const data = JSON.parse(original);
      if (data?.profile?.exit_type !== "Crashed") continue;
      report.crashedProfiles.push(preferences);
      if (!apply) continue;
      data.profile.exit_type = "Normal";
      data.profile.exited_cleanly = true;
      const mode = (await stat(preferences)).mode & 0o777;
      const temporary = `${preferences}.wfa-${process.pid}-${Date.now()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(data), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporary, mode);
        await rename(temporary, preferences);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      report.repairedProfiles.push(preferences);
    } catch (error) {
      report.warnings.push(`Cannot inspect/repair ${preferences}: ${error.message}`);
    }
  }
  try {
    const info = await stat(report.logPath);
    if (info.isFile() && info.size > LOG_ROTATE_BYTES) {
      report.logBytesBefore = info.size;
      if (apply) {
        const file = await open(report.logPath, "r");
        let tail;
        try {
          const count = Math.min(LOG_KEEP_BYTES, info.size);
          tail = Buffer.alloc(count);
          const { bytesRead } = await file.read(tail, 0, count, info.size - count);
          tail = tail.subarray(0, bytesRead);
        } finally { await file.close(); }
        const temporary = `${report.logPath}.wfa-${process.pid}-${Date.now()}.tmp`;
        try {
          await writeFile(temporary, tail, { mode: 0o600, flag: "wx" });
          await rename(temporary, report.logPath);
          report.logRotated = true;
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") report.warnings.push(`Cannot inspect/rotate ${report.logPath}: ${error.message}`);
  }
  report.applied = report.repairedProfiles.length > 0 || report.logRotated;
  report.profileStatus = report.repairedProfiles.length ? "repaired"
    : report.crashedProfiles.length ? "crashed (not repaired)"
      : report.inspectedProfiles ? "healthy" : "not found";
  return report;
}

export async function spawnDetached(command, args, {
  cwd,
  env = process.env,
  stdoutPath,
  stderrPath,
} = {}) {
  if (!stdoutPath || !stderrPath) {
    throw new WfaError("DETACH_LOG_PATH_REQUIRED", "Detached execution needs task-scoped stdout/stderr log paths.");
  }
  if (args.includes("batch") || args.includes("login")) await prepareChromeStartup({ root: chromeConfigDir(env) });
  let stdout = null;
  let stderr = null;
  let child = null;
  try {
    stdout = await open(stdoutPath, "wx", 0o600);
    stderr = await open(stderrPath, "wx", 0o600);
    child = spawn(command, args, {
      cwd, env, detached: true, windowsHide: true,
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!Number.isInteger(child.pid) || child.pid <= 0) {
      throw new WfaError("DETACHED_SPAWN_UNCONFIRMED", "ask-bridge did not provide a valid launched PID.");
    }
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

export async function runProcess(command, args, {
  cwd,
  inherit = false,
  env = process.env,
  onSpawn,
  onStdout,
  onStderr,
  onStdoutLine,
  onStderrLine,
  input,
  timeoutMs,
  killGraceMs = 5000,
  drainGraceMs = 1000,
  abortSignal,
} = {}) {
  if (args.includes("batch") || args.includes("login")) await prepareChromeStartup({ root: chromeConfigDir(env) });
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let spawned = false;
    let exited = false;
    let processError = null;
    let timedOut = false;
    let aborted = false;
    let stdioDrainTimedOut = false;
    let timeoutHandle = null;
    let forceKillHandle = null;
    let watchdogHandle = null;
    let drainHandle = null;
    let spawnCallback = Promise.resolve();
    const pendingLine = { stdout: "", stderr: "" };
    const lineCallback = { stdout: onStdoutLine, stderr: onStderrLine };
    const emitLines = (stream, text, final = false) => {
      let pending = pendingLine[stream] + text;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        lineCallback[stream]?.(pending.slice(0, index).replace(/\r$/, ""));
        pending = pending.slice(index + 1);
      }
      if (pending.length > 16384) {
        lineCallback[stream]?.(pending);
        pending = "";
      }
      if (final && pending) {
        lineCallback[stream]?.(pending);
        pending = "";
      }
      pendingLine[stream] = pending;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(forceKillHandle);
      clearTimeout(watchdogHandle);
      clearTimeout(drainHandle);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({ ...result, processError, timedOut, aborted, stdioDrainTimedOut });
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
        if (!child.kill(signal) && !exited) processError ??= new Error(`Could not signal ask-bridge with ${signal}`);
      } catch (error) { processError ??= error; }
    };
    const beginShutdown = () => {
      if (exited || settled || forceKillHandle) return;
      signalChild("SIGTERM");
      forceKillHandle = setTimeout(() => {
        if (exited || settled) return;
        signalChild("SIGKILL");
        watchdogHandle = setTimeout(() => {
          if (exited || settled) return;
          processError ??= new Error("ask-bridge did not exit after the watchdog tried to stop it");
          child.unref();
          destroyPipes();
          void finishAfterSpawnCallback(null, null, true);
        }, 1000);
        watchdogHandle.unref?.();
      }, Math.max(0, killGraceMs));
      forceKillHandle.unref?.();
    };
    const onAbort = () => { aborted = true; beginShutdown(); };

    if (abortSignal?.aborted) {
      finish({ code: null, signal: null, stdout, stderr, spawnError: new Error("Process launch aborted") });
      return;
    }
    try {
      child = spawn(command, args, {
        cwd, env, windowsHide: !inherit,
        stdio: inherit ? (input === undefined ? "inherit" : ["pipe", "inherit", "inherit"])
          : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ code: null, signal: null, stdout, stderr, spawnError: error });
      return;
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    child.once("spawn", () => {
      spawned = true;
      if (input !== undefined && child.stdin) child.stdin.end(String(input), "utf8");
      spawnCallback = Promise.resolve().then(() => onSpawn?.(child.pid ?? null)).catch(() => {});
    });
    if (!inherit) {
      const stdoutDecoder = new TextDecoder("utf-8");
      const stderrDecoder = new TextDecoder("utf-8");
      child.stdout?.on("data", (chunk) => {
        const text = stdoutDecoder.decode(chunk, { stream: true });
        stdout = truncate(stdout + text, 200000);
        onStdout?.(stdout);
        emitLines("stdout", text);
      });
      child.stderr?.on("data", (chunk) => {
        const text = stderrDecoder.decode(chunk, { stream: true });
        stderr = truncate(stderr + text, 12000);
        onStderr?.(stderr);
        emitLines("stderr", text);
      });
      child.stdout?.once("close", () => emitLines("stdout", stdoutDecoder.decode(), true));
      child.stderr?.once("close", () => emitLines("stderr", stderrDecoder.decode(), true));
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => { timedOut = true; beginShutdown(); }, timeoutMs);
      timeoutHandle.unref?.();
    }
    child.on("error", (error) => {
      if (spawned) processError ??= error;
      else finish({ code: null, signal: null, stdout, stderr, spawnError: error, pid: child.pid ?? null });
    });
    child.once("exit", (code, signal) => {
      exited = true;
      clearTimeout(timeoutHandle); timeoutHandle = null;
      clearTimeout(forceKillHandle); forceKillHandle = null;
      clearTimeout(watchdogHandle); watchdogHandle = null;
      drainHandle = setTimeout(() => {
        stdioDrainTimedOut = true;
        destroyPipes();
        void finishAfterSpawnCallback(code, signal);
      }, Math.max(0, drainGraceMs));
      drainHandle.unref?.();
    });
    child.once("close", (code, signal) => {
      clearTimeout(drainHandle); drainHandle = null;
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
  return { command, version: (version.stdout || version.stderr).trim(), batchHelp: helpText };
}
