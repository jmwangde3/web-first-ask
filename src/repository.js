import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { WfaError } from "./errors.js";
import { collectTrackedSources } from "./repository-archive.js";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS } from "./constants.js";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await exec("git", args, {
    cwd, windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.trimEnd();
}

// Select entry points from repository metadata and tracked eligible paths,
// rather than using the source paths of web-first-ask itself.
export async function selectCoreEntries(root, eligible) {
  const available = new Set(eligible);
  const selected = [];
  const seen = new Set();

  const add = (candidate) => {
    if (typeof candidate !== "string" || !candidate) return;
    const raw = candidate.replace(/\\/g, "/");
    if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return;
    const normalized = path.posix.normalize(raw.replace(/^\.\//, ""));
    if (!normalized || normalized === "." || normalized === ".."
      || normalized.startsWith("../")) return;
    if (!available.has(normalized) || seen.has(normalized)) return;
    if (selected.length >= 8) return;
    seen.add(normalized);
    selected.push(normalized);
  };

  add("package.json");
  add("README.md");

  if (available.has("package.json")) {
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    } catch {
      // Invalid or unreadable package metadata must not break the inventory.
    }

    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
      add(manifest.main);

      if (typeof manifest.bin === "string") {
        add(manifest.bin);
      } else if (manifest.bin && typeof manifest.bin === "object") {
        for (const candidate of Object.values(manifest.bin)) add(candidate);
      }

      const visitExports = (entry) => {
        if (selected.length >= 8) return;
        if (typeof entry === "string") {
          add(entry);
        } else if (Array.isArray(entry)) {
          for (const value of entry) visitExports(value);
        } else if (entry && typeof entry === "object") {
          for (const value of Object.values(entry)) visitExports(value);
        }
      };
      visitExports(manifest.exports);
    }
  }

  for (const candidate of [
    "src/index.js", "index.js", "main.py",
    "Cargo.toml", "go.mod", "pyproject.toml",
  ]) {
    add(candidate);
  }

  return selected;
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

async function workingState(root, remote) {
  const status = await git(root, "status", "--porcelain=v1", "--untracked-files=normal").catch(() => null);
  const dirtyFiles = status === null ? null : status.split(/\r?\n/).filter(Boolean)
    .map((line) => line.slice(3));
  const refs = remote ? await git(root, "for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`).catch(() => "") : "";
  const unpushedCommits = refs
    ? Number(await git(root, "rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`).catch(() => "NaN"))
    : null;
  const pushVerified = Number.isInteger(unpushedCommits);
  const warnings = [];
  if (dirtyFiles === null) warnings.push("Could not inspect the local worktree; its contents may differ from the remote repository.");
  else if (dirtyFiles.length) warnings.push(`Local worktree has ${dirtyFiles.length} modified/untracked file(s) absent from the referenced commit.`);
  if (!pushVerified) warnings.push("Cannot verify that HEAD is available on the remote (no usable remote-tracking refs). Fetch/push before relying on the URL.");
  else if (unpushedCommits > 0) warnings.push(`${unpushedCommits} local commit(s) are not reachable from remote-tracking refs; push before relying on the URL.`);
  return {
    dirty: dirtyFiles === null ? null : dirtyFiles.length > 0,
    dirtyFiles: dirtyFiles?.slice(0, 100) ?? [],
    dirtyFileCount: dirtyFiles?.length ?? null,
    unpushedCommits: pushVerified ? unpushedCommits : null,
    pushVerified,
    safeToReference: warnings.length === 0,
    warnings,
  };
}

export async function resolveRepository({ cwd = process.cwd(), repoUrl, noRepo = false } = {}) {
  if (noRepo) return { available: false, reason: "disabled by --no-repo" };
  const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() => null);
  const branch = root ? await git(root, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "(detached)") : null;
  const commit = root ? await git(root, "rev-parse", "HEAD").catch(() => null) : null;
  const remotes = root ? (await git(root, "remote").catch(() => "")).split(/\r?\n/).filter(Boolean) : [];
  const chosen = remotes.includes("origin") ? "origin" : remotes[0];
  const localUrl = chosen ? normalizeRepoUrl(await git(root, "remote", "get-url", chosen).catch(() => "")) : null;
  if (repoUrl !== undefined && repoUrl !== null) {
    const url = normalizeRepoUrl(repoUrl);
    if (!url) throw new WfaError("INVALID_REPO_URL", "--repo-url must be a browsable Git remote URL.");
    const state = root ? await workingState(root, localUrl === url ? chosen : null)
      : { dirty: null, dirtyFiles: [], dirtyFileCount: null, unpushedCommits: null, pushVerified: false, safeToReference: false,
        warnings: ["This URL is an override outside a verified local Git tree; the remote state is unverified."] };
    return { available: true, source: "override", url, branch, commit, root, ...state };
  }
  if (!root) return { available: false, reason: "working directory is not a Git repository" };
  if (!chosen) return { available: false, reason: "Git repository has no remote" };
  if (!localUrl) return { available: false, reason: `remote ${chosen} is not a browsable repository URL` };
  return { available: true, source: chosen, url: localUrl, branch, commit, root, ...await workingState(root, chosen) };
}

export function repositoryBlock(repo) {
  if (!repo?.available) return "";
  const warning = repo.warnings?.length
    ? `\nLOCAL STATE WARNINGS:\n${repo.warnings.map((item) => `- ${item}`).join("\n")}\nDo not assume the remote contains uncommitted/unpushed local changes.\n`
    : "\n";
  return `REPOSITORY\nURL: ${repo.url}\nBranch: ${repo.branch || "unknown"}\nCommit: ${repo.commit || "unknown"}${warning}Read this repository directly at the branch and commit above. Do not wait for pasted files. If the repository is unreadable, reply with exactly REPO_UNREADABLE and nothing else.\nEND REPOSITORY`;
}

export function matchRepoUnreadable(answer) {
  const raw = String(answer ?? "").trim();
  if (!raw || raw.length > 200) return null;
  const text = raw.replace(/^```(?:text)?\s*\n?/i, "").replace(/\n?```\s*$/, "").replace(/^[`'"\s]+|[`'"\s]+$/g, "").trim();
  if (/^REPO_UNREADABLE[.!。！]?$/i.test(text)) return { matched: text, kind: "sentinel" };
  if (/^(?:Sorry[,.:]?\s*)?(?:I\s+)?(?:cannot|can't|could not|am unable to)\s+(?:access|read|open|retrieve|browse)\s+(?:the\s+|this\s+)?(?:GitHub\s+)?repositor(?:y|ies)\b[.!。！]?$/i.test(text)) return { matched: text, kind: "high-confidence-unreadable" };
  return null;
}

// Git reports the toplevel with forward slashes, and one directory can have
// several spellings on Windows: an 8.3 short name (`RUNNER~1`), a junction, a
// different drive-letter case. Comparing absolute strings therefore fails on
// some machines, and when it failed the bundle included nothing while still
// calling itself authoritative. Reduce every path to a repository-relative
// label through realpath before comparing.
function foldPath(value) {
  return process.platform === "win32" ? String(value).toLowerCase() : String(value);
}

async function canonicalLabel(value) {
  const absolute = path.resolve(value);
  const resolved = await realpath(absolute).catch(() => absolute);
  return resolved.replace(/\\/g, "/");
}

async function includeLabelsFor({ root, cwd, includes }) {
  const rootLabel = await canonicalLabel(root);
  const labels = [];
  for (const entry of includes) {
    const requested = String(entry);
    const target = await canonicalLabel(path.resolve(cwd, requested));
    const relative = path.posix.relative(rootLabel, target);
    const label = relative && !relative.startsWith("..") && !path.posix.isAbsolute(relative)
      ? relative
      : path.posix.normalize(requested.replace(/\\/g, "/"));
    labels.push(foldPath(label));
  }
  return labels;
}

export async function bundleRepository({ cwd = process.cwd(), excludes = [], includes = [], prompt = "", maxFileBytes = 65536,
  maxTotalBytes = 8 * 1024 * 1024, maxInlineBytes = 30 * 1024 } = {}) {
  // One tracked-source filter for both transports. They used to keep separate
  // rules, and the inline copy shipped .npmrc / credentials / id_ed25519 into
  // the prompt while the zip copy excluded them.
  const { root, selected: eligible, skipped } = await collectTrackedSources({ cwd, excludes });
  const selectedPaths = await includeLabelsFor({ root, cwd, includes });
  const matchesInclude = (entry) => selectedPaths.some((item) => {
    const label = foldPath(entry);
    return label === item || label.startsWith(`${item}/`);
  });
  const taskText = String(prompt);
  const mentioned = eligible.filter((item) => taskText.includes(item)
    || (taskText.includes(path.posix.basename(item)) && eligible.filter((entry) => path.posix.basename(entry) === path.posix.basename(item)).length === 1));
  // The inventory is cheap; full sources are not. Without a specified/mentioned
  // file, send the tree and ask for a narrow follow-up instead of streaming
  // unrelated repository files under an arbitrary byte budget.
  const priority = includes.length ? eligible.filter(matchesInclude) : mentioned;
  const tree = eligible.map((item) => `- ${item}`).join("\n");
  const core = await selectCoreEntries(root, eligible);
  const intro = `REPOSITORY SOURCE BUNDLE\nDIRECTORY TREE (tracked, eligible files):\n${tree}\n\nCORE ENTRY POINTS:\n${core.map((item) => `- ${item}`).join("\n") || "(none detected)"}\n\nThe sources included below are authoritative for this request. The tree is only an inventory; do not claim to have read unlisted source contents. Ask for exact additional paths if needed.\n`;
  let content = intro;
  let usedBytes = Buffer.byteLength(intro, "utf8");
  let sourceBytes = 0;
  let files = 0;
  for (const relative of priority) {
    const absolute = path.resolve(root, relative);
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) {
      skipped.push({ path: relative, reason: "not regular file or file-size cap" });
      continue;
    }
    const buffer = await readFile(absolute).catch(() => null);
    if (!buffer || buffer.includes(0)) {
      skipped.push({ path: relative, reason: "unreadable/binary" });
      continue;
    }
    let body;
    try { body = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { skipped.push({ path: relative, reason: "invalid UTF-8" }); continue; }
    const section = `\n===== FILE: ${relative} =====\n${body}\n===== END FILE: ${relative} =====\n`;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    const limit = includes.length ? maxTotalBytes : Math.min(maxTotalBytes, maxInlineBytes);
    if (sourceBytes + buffer.length > limit || usedBytes + sectionBytes > maxTotalBytes) {
      skipped.push({ path: relative, reason: "inline budget; use --file to select this source explicitly" });
      continue;
    }
    content += section;
    usedBytes += sectionBytes;
    sourceBytes += buffer.length;
    files += 1;
  }
  // Every requested path is allowed to be skipped for a stated reason, but if
  // none of them made it in there is nothing authoritative to send. Say so
  // instead of shipping an inventory that promises sources it does not hold.
  if (includes.length && files === 0) {
    const unmatched = includes.filter((entry) => !eligible.some(matchesInclude));
    const detail = unmatched.length
      ? `none of these paths is a tracked, non-excluded file under ${path.posix.normalize(String(root).replace(/\\/g, "/"))}: ${unmatched.join(", ")}`
      : `every requested path was skipped: ${skipped.filter((item) => priority.includes(item.path)).map((item) => `${item.path} (${item.reason})`).join(", ") || includes.join(", ")}`;
    throw new WfaError("BUNDLE_REPO_INCLUDE_UNMATCHED", `--bundle-repo could not inline any requested file: ${detail}. A path passed with --file must be relative to the repository root, not to the current directory.`);
  }
  return { content, stats: { files, bytes: usedBytes, skipped: skipped.length,
    listed: eligible.length, sourceBytes, coreEntryPoints: core }, skipped };
}

function shellQuote(value) {
  return `"${String(value ?? "").replace(/["\\]/g, "\\$&")}"`;
}

export function repositoryFallbackCommand(taskId, provider, workspace, kind = "ask") {
  const command = kind === "code" ? "code" : "ask";
  const flag = command === "code" ? "--requirement" : "--prompt";
  // The archive travels as a native attachment, so it is not subject to the
  // prompt truncation ceiling and does not need --exclude tuning to fit.
  const instruction = command === "code"
    ? "Extract the attached repository archive and use it with the original conversation to implement the request. Return complete FILE: path blocks for every changed file; no plans, diffs or omissions. Name the exact path of any file missing from the archive instead of guessing."
    : "Extract the attached repository archive and use it with the original conversation to answer the request. Name the exact path of any file missing from the archive instead of guessing.";
  return `wfa ${command} --workspace ${shellQuote(workspace)} --provider ${shellQuote(provider)} --followup ${shellQuote(taskId)} --bundle-repo=zip ${flag} ${shellQuote(instruction)}`;
}
