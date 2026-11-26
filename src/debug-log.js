import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { getHomeDir } from "./paths.js";

export const DEFAULT_MAX_DEBUG_LOG_BYTES = 512 * 1024; // 512 KB (max ~1 MB with .1 backup)

export function isDebugEnabled(options = {}) {
  if (options["no-debug"] === true || options.debug === false) return false;
  if (options.debug === true) return true;
  const env = String(process.env.WFA_DEBUG ?? "").trim().toLowerCase();
  if (env === "0" || env === "false" || env === "off") return false;
  return true;
}

export function getDebugLogPath(home) {
  return path.join(home || getHomeDir(), "debug-issues.md");
}

function resolveMaxBytes(override) {
  const raw = Number(override ?? process.env.WFA_DEBUG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_DEBUG_LOG_BYTES;
}

function formatDetails(details) {
  if (details == null) return "";
  try {
    const raw = typeof details === "string" ? details : JSON.stringify(details);
    return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
  } catch {
    return "";
  }
}

export async function appendDebugIssue({
  home,
  command = "",
  status = "",
  errorCode = "",
  message = "",
  provider = "",
  taskId = "",
  conversationUrl = "",
  repro = "",
  details = null,
  maxBytes,
  timestamp = new Date().toISOString(),
} = {}) {
  const target = getDebugLogPath(home);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    const limit = resolveMaxBytes(maxBytes);
    let rotated = false;
    try {
      const info = await stat(target);
      if (info && info.size >= limit) {
        await rename(target, `${target}.1`);
        rotated = true;
      }
    } catch {}

    const header = `### ${timestamp} — ${errorCode || status || "issue"}`;
    const lines = [header];
    if (command) lines.push(`- **Command**: \`${command}\``);
    if (provider) lines.push(`- **Provider**: \`${provider}\``);
    if (status) lines.push(`- **Status**: \`${status}\``);
    if (errorCode) lines.push(`- **Error**: \`${errorCode}\``);
    if (taskId) lines.push(`- **Task ID**: \`${taskId}\``);
    if (conversationUrl) lines.push(`- **URL**: ${conversationUrl}`);
    if (message) lines.push(`- **Message**: ${String(message).replace(/\r?\n/g, " ").slice(0, 400)}`);
    if (repro) lines.push(`- **Repro**: ${String(repro).trim()}`);
    const det = formatDetails(details);
    if (det) lines.push(`- **Details**: \`${det}\``);
    lines.push("");
    await appendFile(target, `${lines.join("\n")}\n`, "utf8");
    return { logged: true, rotated, path: target };
  } catch {
    return { logged: false, rotated: false, path: target };
  }
}
