
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { queryProcess, resolveChromeExecutable, terminateProcessAndWait } from "./proc.js";

export async function readDevToolsActivePort(profileDir, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    try {
      const content = await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
      const lines = content.trim().split(/\r?\n/);
      const port = Number(lines[0]);
      const wsPath = lines[1]?.trim();
      if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[^\s]+$/.test(wsPath ?? "")) {
        return { port, wsPath };
      }
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(100, deadline - Date.now()));
  }
}

export async function cdpProbe(port, { timeoutMs = 1500, attempts = 3 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "INVALID_CDP_PORT" };
  let error = "CDP_UNREACHABLE";
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const result = await response.json();
      const socketUrl = typeof result.webSocketDebuggerUrl === "string"
        ? new URL(result.webSocketDebuggerUrl) : null;
      if (typeof result.Browser !== "string" || !/^(?:Headless)?Chrome\//i.test(result.Browser) ||
          socketUrl?.protocol !== "ws:" ||
          !["127.0.0.1", "localhost"].includes(socketUrl.hostname) ||
          Number(socketUrl.port) !== port ||
          !/^\/devtools\/browser\/[^/]+$/.test(socketUrl.pathname)) {
        throw new Error("INVALID_CDP_RESPONSE");
      }
      return { ok: true, browser: result.Browser, webSocketDebuggerUrl: result.webSocketDebuggerUrl };
    } catch (cause) {
      error = cause?.message ?? String(cause);
    } finally {
      clearTimeout(timer);
    }
    if (i + 1 < attempts) await sleep(100);
  }
  return { ok: false, error };
}

export function buildChromeArgs({ userDataDir, mode = "headless" } = {}) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    // ChatGPT stores its session in a non-persistent cookie (oai-asli). Chrome only keeps
    // such cookies across restarts when started with this switch; without it the profile
    // looks logged out after any exit, including a crash.
    "--restore-last-session",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // Cloudflare fingerprints the automation switch itself: both headless and a
    // plain headful launch land on the interstitial. Keep it in every mode.
    "--disable-blink-features=AutomationControlled",
    // Suppress the "Chrome didn't shut down correctly" crash-restore bubble.
    // Both switches are kept: Chrome silently ignores unknown/inapplicable ones,
    // so this is a zero-risk fallback across builds (verified on this machine).
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    // WebRTC must not leak the real/local IP via non-proxied UDP candidates.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
  if (mode === "headless") args.push("--headless=new");
  if (mode === "background" || mode === "headful") args.push("--window-size=1440,1200", "--window-position=-2000,-2000");
  if (mode === "visible") args.push("--window-size=1440,1200", "--window-position=100,100");
  return args;
}

export async function launchChrome({ profileDir, mode = "headless", chromePath, timeoutMs = 20000, deps = {} } = {}) {
  if (!profileDir) throw new Error("PROFILE_DIR_REQUIRED");
  if (!["headless", "headful", "background", "visible"].includes(mode)) throw new Error("INVALID_BROWSER_MODE");
  const resolveExecutable = deps.resolveChromeExecutable || resolveChromeExecutable;
  const queryProcessFn = deps.queryProcess || queryProcess;
  const readActivePortFn = deps.readDevToolsActivePort || readDevToolsActivePort;
  const cdpProbeFn = deps.cdpProbe || cdpProbe;
  const terminateProcessFn = deps.terminateProcessAndWait || terminateProcessAndWait;
  const executable = await resolveExecutable(chromePath);
  const userDataDir = path.resolve(profileDir);
  await mkdir(userDataDir, { recursive: true });
  // Avoid accepting an old port file from a previously terminated Chrome.
  await rm(path.join(userDataDir, "DevToolsActivePort"), { force: true });
  const args = buildChromeArgs({ userDataDir, mode });

  let child;
  let pid = null;
  const spawnFn = deps.spawn || spawn;
  try {
    child = spawnFn(executable, args, { detached: true, stdio: "ignore", windowsHide: mode === "headless" });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    pid = child.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("CHROME_NO_PID");
    child.unref();
    const deadline = Date.now() + Math.max(timeoutMs, 15000);
    let info = null;
    while (Date.now() < deadline && !info) {
      info = await queryProcessFn(pid);
      if (!info?.creationDate || !info?.executablePath) {
        info = null;
        await sleep(100);
      }
    }
    if (!info) throw new Error("CHROME_PROCESS_METADATA_UNAVAILABLE");
    const active = await readActivePortFn(userDataDir, { timeoutMs: Math.max(0, deadline - Date.now()) });
    if (!active) throw new Error("CHROME_ACTIVE_PORT_TIMEOUT");
    const cdp = await cdpProbeFn(active.port);
    if (!cdp.ok) throw new Error(`CHROME_CDP_FAILED:${cdp.error}`);
    return {
      pid,
      creationDate: info.creationDate,
      executablePath: info.executablePath,
      actualDebugPort: active.port,
      wsPath: active.wsPath,
      userDataDir,
    };
  } catch (cause) {
    if (Number.isSafeInteger(pid) && pid > 0) {
      await terminateProcessFn(pid).catch(() => {});
    }
    const error = new Error(`Chrome startup failed: ${cause?.message ?? String(cause)}`, { cause });
    error.code = "CHROME_START_FAILED";
    throw error;
  }
}
