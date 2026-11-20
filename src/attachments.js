import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { WfaError } from "./errors.js";

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif",
]);
const DIRECTORY_FILE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyi", ".ps1", ".psm1", ".psd1", ".cs", ".java", ".kt",
  ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".rb",
  ".php", ".swift", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".sql",
  ".html", ".htm", ".css", ".scss", ".less", ".json", ".jsonc",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml",
  ".md", ".mdx", ".txt", ".rst", ".adoc", ".csv", ".tsv",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp", ".rtf", ".ipynb",
]);
const DEFAULT_IGNORED_DIRS = new Set([
  ".git", ".wfa", "node_modules", ".next", ".nuxt", ".turbo",
  "coverage", "dist", "build", "out", "target", "tmp", ".venv", "venv",
  ".cache", ".pytest_cache", ".mypy_cache", "__pycache__",
]);
const SENSITIVE_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", "id_rsa", "id_ed25519",
  "credentials", "secrets.json", "service-account.json",
]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore"]);

function normalizePattern(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function globToRegExp(pattern) {
  const value = normalizePattern(pattern);
  let source = "^";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "*" && value[i + 1] === "*") {
      i += 1;
      if (value[i + 1] === "/") {
        i += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = value.indexOf("}", i + 1);
      if (end > i) {
        const choices = value.slice(i + 1, end).split(",").map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"));
        source += `(?:${choices.join("|")})`;
        i = end;
      } else {
        source += "\\{";
      }
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

function matchesPattern(relativePath, pattern) {
  const normalized = normalizePattern(relativePath);
  const candidate = normalizePattern(pattern);
  const matcher = globToRegExp(candidate);
  if (matcher.test(normalized)) return true;
  if (!candidate.includes("/")) return matcher.test(path.posix.basename(normalized));
  return false;
}

function isSensitiveName(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);
  return base.startsWith(".env") || SENSITIVE_BASENAMES.has(base)
    || SENSITIVE_EXTENSIONS.has(ext) || base === ".npmrc" || base === ".pypirc" || base === ".netrc";
}

function isDirectoryAttachment(filePath) {
  if (isSensitiveName(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || DIRECTORY_FILE_EXTENSIONS.has(ext);
}

async function walkDirectory(directory, root, results, counter) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    counter.visited += 1;
    if (counter.visited > 100000) {
      throw new WfaError("ATTACHMENT_SCAN_LIMIT", "Directory scan exceeded 100,000 entries. Narrow the directory or add --exclude patterns.");
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
      await walkDirectory(absolute, root, results, counter);
    } else if (entry.isFile() && isDirectoryAttachment(absolute)) {
      results.push(absolute);
    }
  }
}

function classifyFile(filePath, target) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) target.images.push(filePath);
  else target.files.push(filePath);
}

export async function expandAttachmentInputs({
  files = [],
  images = [],
  excludes = [],
  cwd = process.cwd(),
  maxFiles = 250,
  maxBytes = 50 * 1024 * 1024,
} = {}) {
  const root = path.resolve(cwd);
  const target = { files: [], images: [] };
  const exclusionPatterns = [...excludes].map(normalizePattern);
  const explicit = [];

  for (const raw of [...files, ...images]) {
    const value = String(raw);
    if (value.startsWith("!") && value.length > 1) {
      exclusionPatterns.push(normalizePattern(value.slice(1)));
    } else {
      explicit.push({ value, imageOnly: images.includes(raw) });
    }
  }

  const matches = [];
  const globRequests = [];
  for (const item of explicit) {
    const absolute = path.resolve(root, item.value);
    const info = await lstat(absolute).catch(() => null);
    if (info?.isSymbolicLink()) {
      throw new WfaError("ATTACHMENT_SYMLINK", `Symbolic-link attachments are not followed: ${absolute}`);
    }
    if (info?.isFile()) {
      matches.push({ absolute, imageOnly: item.imageOnly, explicit: true });
    } else if (info?.isDirectory()) {
      const collected = [];
      await walkDirectory(absolute, root, collected, { visited: 0 });
      for (const filePath of collected) matches.push({ absolute: filePath, imageOnly: item.imageOnly, explicit: false });
    } else if (/[*?{]/.test(item.value)) {
      globRequests.push(item);
    } else {
      throw new WfaError("ATTACHMENT_NOT_FOUND", `Attachment path does not exist: ${absolute}`);
    }
  }

  if (globRequests.length) {
    const all = [];
    await walkDirectory(root, root, all, { visited: 0 });
    for (const item of globRequests) {
      const pattern = normalizePattern(item.value);
      const found = all.filter((filePath) => matchesPattern(path.relative(root, filePath), pattern));
      if (!found.length) {
        throw new WfaError("ATTACHMENT_GLOB_EMPTY", `Attachment glob matched no files: ${item.value}`);
      }
      for (const filePath of found) matches.push({ absolute: filePath, imageOnly: item.imageOnly, explicit: false });
    }
  }

  const seen = new Set();
  for (const item of matches) {
    const absolute = path.resolve(item.absolute);
    const rel = path.relative(root, absolute).replaceAll("\\", "/");
    if (exclusionPatterns.some((pattern) => matchesPattern(rel, pattern))) continue;
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) continue;
    if (item.imageOnly && !IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      throw new WfaError("IMAGE_TYPE_UNSUPPORTED", `--image expects an image file: ${absolute}`);
    }
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.imageOnly && !IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) continue;
    classifyFile(absolute, target);
  }

  target.files.sort((a, b) => a.localeCompare(b));
  target.images.sort((a, b) => a.localeCompare(b));
  const count = target.files.length + target.images.length;
  if (!count) {
    throw new WfaError("NO_ATTACHMENTS", "No supported attachment files remain after applying the include and exclude patterns.");
  }
  if (count > maxFiles) {
    throw new WfaError("ATTACHMENT_COUNT_LIMIT", `Attachment expansion produced ${count} files; the limit is ${maxFiles}. Add --exclude patterns or narrow the input.`);
  }
  let totalBytes = 0;
  for (const filePath of [...target.files, ...target.images]) {
    totalBytes += (await stat(filePath)).size;
  }
  if (totalBytes > maxBytes) {
    throw new WfaError("ATTACHMENT_SIZE_LIMIT", `Expanded attachments total ${(totalBytes / 1024 / 1024).toFixed(1)} MiB; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MiB.`);
  }
  target.totalBytes = totalBytes;
  target.count = count;
  return target;
}

export function isImageAttachment(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isSensitiveAttachmentPath(filePath) {
  return isSensitiveName(filePath);
}

export function isTextSourceAttachment(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return new Set([
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
    ".py", ".pyi", ".ps1", ".psm1", ".psd1", ".cs", ".java", ".kt",
    ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".rb",
    ".php", ".swift", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".sql",
    ".html", ".htm", ".css", ".scss", ".less", ".json", ".jsonc",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml",
    ".md", ".mdx", ".txt", ".rst", ".adoc", ".csv", ".tsv",
  ]).has(ext);
}
