import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { WfaError } from "./errors.js";

const exec = promisify(execFile);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache", "vendor", "target", ".venv", "__pycache__"]);
const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|class|pyc|woff2?|ttf|otf|mp[34]|avi|mov|sqlite|db|lock)$/i;

async function git(cwd, ...args) {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true, timeout: 5000, maxBuffer: 12 * 1024 * 1024 });
  return stdout.trim();
}

export function normalizeRepoUrl(remote) {
  const value = String(remote ?? "").trim();
  if (!value) return null;
  let url;
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([^\s]+)$/.exec(value);
  if (scp && !value.includes("://") && !/^[A-Za-z]:[\\/]/.test(value)) {
    url = new URL(`https://${scp[1]}/${scp[2]}`);
  } else {
    try { url = new URL(value); } catch { return null; }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    url = new URL(`https://${url.host}${url.pathname}`);
  }
  if (!url.hostname || (url.port && url.port !== "443")) return null;
  url.username = "";
  url.password = "";
  url.port = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  if (url.pathname.split("/").filter(Boolean).length < 2) return null;
  return url.toString().replace(/\/$/, "");
}

export async function resolveRepository({ cwd = process.cwd(), repoUrl, noRepo = false } = {}) {
  if (noRepo) return { available: false, reason: "disabled by --no-repo" };
  let root = null;
  try { root = await git(cwd, "rev-parse", "--show-toplevel"); } catch {}
  let branch = null;
  let commit = null;
  if (root) {
    branch = await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "(detached)");
    commit = await git(cwd, "rev-parse", "HEAD").catch(() => null);
  }
  if (repoUrl !== undefined && repoUrl !== null) {
    const url = normalizeRepoUrl(repoUrl);
    if (!url) throw new WfaError("INVALID_REPO_URL", "--repo-url must be a browsable Git remote URL.");
    return { available: true, source: "override", url, branch, commit, root };
  }
  if (!root) return { available: false, reason: "working directory is not a Git repository" };
  const remotes = (await git(cwd, "remote").catch(() => "")).split(/\r?\n/).filter(Boolean);
  const chosen = remotes.includes("origin") ? "origin" : remotes[0];
  if (!chosen) return { available: false, reason: "Git repository has no remote" };
  const url = normalizeRepoUrl(await git(cwd, "remote", "get-url", chosen).catch(() => ""));
  if (!url) return { available: false, reason: `remote ${chosen} is not a browsable repository URL` };
  return { available: true, source: chosen, url, branch, commit, root };
}

export function repositoryBlock(repo) {
  if (!repo?.available) return "";
  return `REPOSITORY\nURL: ${repo.url}\nBranch: ${repo.branch || "unknown"}\nCommit: ${repo.commit || "unknown"}\nRead this repository directly at the branch and commit above. Do not wait for pasted files. If the repository is unreadable, reply with exactly REPO_UNREADABLE and nothing else.\nEND REPOSITORY`;
}

export function matchRepoUnreadable(answer) {
  const raw = String(answer ?? "").trim();
  if (!raw || raw.length > 200) return null;
  const text = raw.replace(/^```(?:text)?\s*\n?/i, "").replace(/\n?```\s*$/, "").replace(/^[`'"\s]+|[`'"\s]+$/g, "").trim();
  if (/^REPO_UNREADABLE[.!。！]?$/i.test(text)) return { matched: text, kind: "sentinel" };
  if (/^(?:Sorry[,.:]?\s*)?(?:I\s+)?(?:cannot|can't|could not|am unable to)\s+(?:access|read|open|retrieve|browse)\s+(?:the\s+|this\s+)?(?:GitHub\s+)?repositor(?:y|ies)\b[.!。！]?$/i.test(text)) return { matched: text, kind: "high-confidence-unreadable" };
  return null;
}

function matchesExclude(file, patterns) {
  return patterns.some((pattern) => {
    const p = String(pattern).replace(/\\/g, "/").replace(/^!/, "");
    if (!p) return false;
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
    return new RegExp(`^(?:${escaped})(?:$|/)`).test(file) || (!p.includes("/") && new RegExp(`(?:^|/)${escaped}$`).test(file));
  });
}

export async function bundleRepository({ cwd = process.cwd(), excludes = [], includes = [], maxFileBytes = 65536, maxTotalBytes = 8 * 1024 * 1024 } = {}) {
  const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() => null);
  if (!root) throw new WfaError("BUNDLE_REPO_NOT_GIT", "--bundle-repo requires a Git working tree. Use --file <path> instead.");
  const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--exclude-standard"], {
    cwd: root, windowsHide: true, timeout: 10000, encoding: "buffer", maxBuffer: 12 * 1024 * 1024,
  });
  const paths = Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
  const selected = includes.map((entry) => path.resolve(cwd, entry));
  const sections = [];
  const skipped = [];
  let sourceBytes = 0;
  for (const relative of paths) {
    const label = relative.replace(/\\/g, "/");
    if (label.split("/").some((part) => SKIP_DIRS.has(part)) || SKIP_EXT.test(label)
      || /(?:^|\/)(?:\.env(?:\.|$)|id_rsa|[^/]*\.min\.(?:js|css)$)/i.test(label)
      || matchesExclude(label, excludes)) {
      skipped.push({ path: label, reason: "excluded/generated/binary filename" });
      continue;
    }
    const absolute = path.resolve(root, relative);
    if (selected.length && !selected.some((entry) => absolute === entry || absolute.startsWith(entry + path.sep))) continue;
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.size > maxFileBytes || sourceBytes + info.size > maxTotalBytes) {
      skipped.push({ path: label, reason: !info?.isFile() ? "not a regular file" : "size cap" });
      continue;
    }
    const buffer = await readFile(absolute).catch(() => null);
    if (!buffer || buffer.includes(0)) {
      skipped.push({ path: label, reason: "unreadable/binary" });
      continue;
    }
    let body;
    try { body = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { skipped.push({ path: label, reason: "invalid UTF-8" }); continue; }
    sourceBytes += buffer.length;
    sections.push(`===== FILE: ${label} =====\n${body}\n===== END FILE: ${label} =====`);
  }
  const content = sections.join("\n\n");
  return { content, stats: { files: sections.length, bytes: Buffer.byteLength(content, "utf8"), skipped: skipped.length }, skipped };
}

export function repositoryFallbackCommand(taskId, provider, workspace) {
  return `wfa ask --workspace ${workspace} --provider ${provider} --followup ${taskId} --bundle-repo --prompt "The repository could not be accessed. Use the inlined sources to answer the original request."`;
}
