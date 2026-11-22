
import { execFile } from "node:child_process";
import { access, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const PROCESS_TIMEOUT_MS = 3000;

export async function resolveChromeExecutable(preferred) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  if (process.env.WFA_CHROME_PATH) candidates.push(process.env.WFA_CHROME_PATH);
  if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === "win32" ? ["chrome.exe"] : ["google-chrome", "chromium", "chrome"]) {
      candidates.push(path.join(dir, name));
    }
  }
  for (const candidate of candidates) {
    const fullPath = path.resolve(candidate);
    try {
      await access(fullPath, constants.X_OK);
      return fullPath;
    } catch {
      // Try the next supported location.
    }
  }
  const error = new Error("Chrome executable not found");
  error.code = "CHROME_NOT_FOUND";
  throw error;
}

export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function normalizeFsPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return path.resolve(value.trim().replace(/^"|"$/g, "")).replaceAll("\\", "/").toLowerCase();
}

function splitCommandLine(line) {
  const args = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      quoted = !quoted;
    } else if (/\s/.test(char) && !quoted) {
      if (current) args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quoted) return null;
  if (current) args.push(current);
  return args;
}

export function matchCommandLineUserDataDir(commandLine, profileDir) {
  if (typeof commandLine !== "string" || !commandLine.trim() || commandLine.length >= 32000) return "unknown";
  const expected = normalizeFsPath(profileDir);
  if (!expected) return "unknown";
  const args = splitCommandLine(commandLine);
  if (!args) return "unknown";
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (/^--user-data-dir=/i.test(arg)) {
      values.push(arg.slice(arg.indexOf("=") + 1));
    } else if (/^--user-data-dir$/i.test(arg)) {
      values.push(args[++i]);
    }
  }
  if (values.length === 0) return "mismatch";
  if (values.length !== 1 || !values[0]) return "unknown";
  const actual = normalizeFsPath(values[0]);
  return actual ? (actual === expected ? "match" : "mismatch") : "unknown";
}

async function runPowerShell(expression) {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ${expression}`,
    ], {
      windowsHide: true,
      encoding: "utf8",
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseProcesses(output) {
  if (output == null) return null;
  if (!output) return [];
  try {
    const items = JSON.parse(output);
    return (Array.isArray(items) ? items : [items]).filter(Boolean).map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId) || null,
      creationDate: item.CreationDate || null,
      executablePath: item.ExecutablePath || null,
      commandLine: item.CommandLine || null,
    })).filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0);
  } catch {
    return null;
  }
}

const projection = "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={if ($_.CreationDate) {$_.CreationDate.ToString('o')} else {$null}}} | ConvertTo-Json -Compress -Depth 3";

export async function queryProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const output = await runPowerShell(`Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop | ${projection}`);
  return parseProcesses(output)?.[0] ?? null;
}

export async function listProcessesByName(name) {
  if (typeof name !== "string" || !/^[\w.-]+$/.test(name)) return [];
  const safeName = name.replaceAll("'", "''");
  const output = await runPowerShell(`Get-CimInstance Win32_Process -Filter "Name='${safeName}'" -ErrorAction Stop | ${projection}`);
  return parseProcesses(output) ?? [];
}

export async function findProfileOwner(profileDir) {
  const matches = (await listProcessesByName("chrome.exe"))
    .filter((item) => matchCommandLineUserDataDir(item.commandLine, profileDir) === "match");
  // Chrome subprocesses can inherit --user-data-dir. Prefer browser processes
  // with no --type= switch before falling back to all matching processes.
  const browserProcesses = matches.filter((item) =>
    !/(?:^|\s)--type=/i.test(item.commandLine ?? ""));
  const candidates = (browserProcesses.length ? browserProcesses : matches)
    .sort((a, b) => {
      const first = Date.parse(a.creationDate);
      const second = Date.parse(b.creationDate);
      return (Number.isFinite(first) ? first : Infinity) - (Number.isFinite(second) ? second : Infinity);
    });
  if (!candidates.length) return null;
  return { ...candidates[0], ambiguous: candidates.length > 1 };
}

export async function probeProfileLock(profileDir) {
  let handle;
  try {
    handle = await open(path.join(profileDir, "lockfile"), "r+");
    return "free";
  } catch (error) {
    if (error?.code === "ENOENT") return "free";
    if (["EBUSY", "EPERM", "EACCES", "EAGAIN"].includes(error?.code) || error?.win32ErrorCode === 32) return "held";
    return "unknown";
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function getListeningPid(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const output = await runPowerShell(`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess | ConvertTo-Json -Compress`);
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    const pids = (Array.isArray(parsed) ? parsed : [parsed]).map(Number);
    return pids.length && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid === pids[0]) ? pids[0] : null;
  } catch {
    return null;
  }
}

export async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(100, deadline - Date.now()));
  }
  return true;
}

// Verify identity immediately before each termination action, including force.
// Injectable operations allow rejection paths to be tested without starting Chrome.
export async function terminateProcessAndWait(pid, {
  expectedCreationDate = null,
  profileDir = null,
  force = false,
  exec = execFileAsync,
  inspect = queryProcess,
  alive = isPidAlive,
  signal = process.kill,
  wait = waitForProcessExit,
  platform = process.platform,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("INVALID_KILL_PID");
  const verify = async () => {
    if (!expectedCreationDate && !profileDir) return true;
    const found = await inspect(pid);
    if (!found) return !alive(pid);
    const timeMatch = !expectedCreationDate || (Number.isFinite(Date.parse(found.creationDate)) &&
      Math.abs(Date.parse(found.creationDate) - Date.parse(expectedCreationDate)) <= 2000);
    const profileMatch = !profileDir || matchCommandLineUserDataDir(found.commandLine, profileDir) === "match";
    return timeMatch && profileMatch;
  };
  const reverify = async () => {
    let verified = false;
    try {
      verified = await verify();
    } catch {
      // Unable to inspect the target: fail closed rather than killing it.
    }
    if (verified) return;
    const error = new Error("KILL_REVERIFY_FAILED");
    error.code = "KILL_REVERIFY_FAILED";
    throw error;
  };
  if (!alive(pid)) return;
  if (!force) {
    await reverify();
    if (!alive(pid)) return;
    try {
      signal(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    if (await wait(pid, 3000)) return;
  }
  if (!alive(pid)) return;
  // This also covers force:true: never call taskkill/SIGKILL using only an
  // identity check performed before a potentially long SIGTERM wait.
  await reverify();
  if (!alive(pid)) return;
  if (platform === "win32") {
    try {
      await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 3000 });
    } catch {
      // Check the target's state even when taskkill returns a nonzero exit code.
    }
  } else {
    try {
      signal(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (!(await wait(pid, 3000))) throw new Error("CHROME_KILL_FAILED");
}
