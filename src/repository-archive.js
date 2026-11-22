import { execFile } from "node:child_process";
import { promisify, TextDecoder } from "node:util";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { WfaError } from "./errors.js";
import { scanSensitiveText } from "./bundle.js";
import { sha256, uuid } from "./util.js";

const exec = promisify(execFile);

// Kept in sync with repository.js: the archive must ship exactly the files the
// inline bundle would have shipped, so a task cannot see a different repository
// depending on which transport it used.
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache", "vendor", "target", ".venv", "__pycache__"]);
const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|class|pyc|woff2?|ttf|otf|mp[34]|avi|mov|sqlite|db|bin|dat|lock)$/i;
const SENSITIVE = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials|secrets\.json|service-account\.json|[^/]*\.(?:pem|key|p12|pfx|keystore))/i;
const MAX_ENTRIES = 60000;
// The archive is an attachment, so the attachment ceiling is the real limit.
// Failing here names the actual problem; the upload would otherwise reject the
// file after the task was created.
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
// An archive younger than this may still be uploading. Pruning by count alone
// could delete the file a live task is about to send.
const PRUNE_MIN_AGE_MS = 10 * 60 * 1000;

async function git(cwd, ...args) {
  const { stdout } = await exec("git", args, {
    cwd, windowsHide: true, timeout: 10000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.from(stdout).toString("utf8").trimEnd();
}

// The archive is a transport, not an exemption: the inline bundle's text is
// scanned for secrets, so its zipped equivalent is scanned here. Binary entries
// are skipped and reported as unscanned instead of silently passing.
function scanEntry(name, data) {
  if (data.includes(0)) return null;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return null; }
  return scanSensitiveText(text, name);
}

function matchesExclude(file, patterns) {
  return patterns.some((pattern) => {
    const p = String(pattern).replace(/\\/g, "/").replace(/^!/, "");
    if (!p) return false;
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
    return new RegExp(`^(?:${escaped})(?:$|/)`).test(file)
      || (!p.includes("/") && new RegExp(`(?:^|/)${escaped}$`).test(file));
  });
}

export async function collectTrackedSources({ cwd = process.cwd(), excludes = [] } = {}) {
  const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() => null);
  if (!root) throw new WfaError("BUNDLE_REPO_NOT_GIT", "--bundle-repo requires a Git working tree. Use --file <path> instead.");
  const tracked = (await git(root, "ls-files", "-z", "--cached", "--exclude-standard")).split("\0").filter(Boolean);
  const skipped = [];
  const selected = [];
  for (const relative of tracked) {
    const label = relative.replace(/\\/g, "/");
    let reason = null;
    if (label.split("/").some((part) => SKIP_DIRS.has(part))) reason = "build/cache directory";
    else if (SKIP_EXT.test(label)) reason = "binary or generated filename";
    else if (SENSITIVE.test(label)) reason = "sensitive filename";
    else if (matchesExclude(label, excludes)) reason = "matched --exclude";
    if (reason) skipped.push({ path: label, reason });
    else selected.push(relative);
  }
  return { root, selected, skipped };
}

// A fixed DOS stamp (1980-01-01 00:00) keeps the archive byte-identical for
// identical sources, so the file name can be derived from its content and one
// request can be replayed with the same request_id (see the intent hash in
// runner-orchestration.js). Entry mtimes carried no meaning for a reader.
const DOS_STAMP = { time: 0, day: 33 };

// Minimal ZIP writer: deflate each entry, fall back to store when compression
// does not pay off. No external binary (no `zip` on Windows) and no zip64,
// which is fine because the entry and size caps are well below the format
// limits.
export function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const { time, day } = DOS_STAMP;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const checksum = crc32(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const payload = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, payload);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(day, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(payload.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += header.length + name.length + payload.length;
  }
  const directoryBytes = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function pruneArchives(directory, keep, now = Date.now()) {
  const names = await readdir(directory).catch(() => []);
  const archives = [];
  for (const name of names) {
    if (!name.endsWith(".zip")) continue;
    const info = await lstat(path.join(directory, name)).catch(() => null);
    if (info?.isFile()) archives.push({ name, mtime: info.mtimeMs });
  }
  archives.sort((a, b) => b.mtime - a.mtime);
  const stale = archives.slice(keep).filter((item) => now - item.mtime > PRUNE_MIN_AGE_MS);
  for (const item of stale) await rm(path.join(directory, item.name), { force: true }).catch(() => {});
}

export async function archiveRepository({ cwd = process.cwd(), excludes = [], outDir, prompt = "",
  maxFileBytes = 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024, keepArchives = 5, requestId = null } = {}) {  const { root, selected, skipped } = await collectTrackedSources({ cwd, excludes });
  if (!selected.length) {
    throw new WfaError("BUNDLE_REPO_EMPTY", "--bundle-repo=zip found no eligible tracked files. Select paths with --file or adjust --exclude.");
  }
  const taskText = String(prompt);
  // Put the files the request names first so a size cap drops unrelated code
  // rather than the sources the task is about.
  const mentioned = [];
  const rest = [];
  for (const relative of selected) {
    const base = path.posix.basename(relative);
    if (taskText.includes(relative) || (base.length > 3 && taskText.includes(base))) mentioned.push(relative);
    else rest.push(relative);
  }
  const entries = [];
  const secretFindings = [];
  let scannedFiles = 0;
  let totalBytes = 0;
  for (const relative of [...mentioned, ...rest]) {
    const absolute = path.resolve(root, relative);
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) {
      skipped.push({ path: relative, reason: info?.isSymbolicLink() ? "symbolic link" : "not a regular file or file-size cap" });
      continue;
    }
    if (totalBytes + info.size > maxTotalBytes) {
      skipped.push({ path: relative, reason: "archive budget" });
      continue;
    }
    const data = await readFile(absolute).catch(() => null);
    if (!data) { skipped.push({ path: relative, reason: "unreadable" }); continue; }
    entries.push({ name: relative.replace(/\\/g, "/"), data });
    const scan = scanEntry(relative, data);
    if (scan) { secretFindings.push(...scan); scannedFiles += 1; }
    totalBytes += data.length;
    if (entries.length > MAX_ENTRIES) throw new WfaError("BUNDLE_REPO_TOO_LARGE", `--bundle-repo=zip selected more than ${MAX_ENTRIES} files. Narrow it with --file or --exclude.`);
  }
  if (!entries.length) {
    throw new WfaError("BUNDLE_REPO_EMPTY", "--bundle-repo=zip found no readable tracked files. Select paths with --file or adjust --exclude.");
  }
  const zip = buildZip(entries);
  if (zip.length > MAX_ARCHIVE_BYTES) {
    throw new WfaError("BUNDLE_REPO_TOO_LARGE", `--bundle-repo=zip produced an archive of ${(zip.length / 1024 / 1024).toFixed(1)} MiB, over the 50 MiB attachment limit. Narrow it with --exclude or --file.`);
  }
  const directory = outDir ?? path.join(process.cwd(), ".wfa");
  await mkdir(directory, { recursive: true });
  // Keep the stem at 20 characters or fewer. ask-bridge confirms an attachment
  // by matching the whole filename against the page text, and Gemini truncates
  // the attachment label past that point, so a timestamped name is uploaded and
  // then reported as never attached 50 s later (docs/known-issues.md U1). The
  // content hash makes a replay with the same request_id reuse one path; the
  // random half keeps two independent requests from colliding, which a pure
  // content hash did whenever the same repository was archived twice.
  const slug = (path.basename(root).replace(/[^A-Za-z0-9._-]/g, "_") || "repo").slice(0, 4);
  const file = path.join(directory, `${slug}-${sha256(`${sha256(zip)}:${requestId ?? uuid()}`).slice(0, 15)}.zip`);
  if (!(await lstat(file).catch(() => null))?.isFile()) await writeFile(file, zip);
  await pruneArchives(directory, keepArchives);
  return {
    file,
    secretFindings,
    scannedFiles,
    stats: {
      files: entries.length,
      listed: selected.length,
      sourceBytes: totalBytes,
      archiveBytes: zip.length,
      ratio: totalBytes ? Number((zip.length / totalBytes).toFixed(3)) : 1,
      skipped: skipped.length,
    },
    skipped,
  };
}

export function repositoryArchiveBlock(archive, repository) {
  const name = path.basename(archive.file);
  const commit = repository?.commit ? ` at commit ${repository.commit}` : "";
  const branch = repository?.branch ? ` (branch ${repository.branch})` : "";
  // The archive is packed from the working tree, not from the commit object.
  // Saying only "at commit X" would let the provider treat uncommitted work as
  // the pushed state, which is the same mistake the repository reference warns
  // about.
  const dirty = repository?.dirty
    ? ` The working tree had uncommitted changes when it was packed (${repository.dirtyFiles?.length ?? "some"} file(s)), so individual files may differ from that commit.`
    : "";
  return [
    "REPOSITORY ARCHIVE",
    `The attached file ${name} is a zip of this repository's tracked sources${commit}${branch}.${dirty}`,
    `It holds ${archive.stats.files} file(s), ${archive.stats.sourceBytes} bytes uncompressed. Paths inside the archive are repository-relative.`,
    "Extract it and read the files you need from there. Do not wait for pasted files and do not try to fetch the repository over the network.",
    "If a path you need is missing from the archive, name that exact path instead of guessing what it contains.",
    "END REPOSITORY ARCHIVE",
  ].join("\n");
}
