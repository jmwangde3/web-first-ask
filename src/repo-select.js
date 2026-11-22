// Shared selection rules for repository inline bundles and ZIP archives.
// Attachment extension lists live here too, but attaching a file explicitly
// is a different operation from selecting it for a repository bundle.

export const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next",
  ".cache", "vendor", "target", ".venv", "__pycache__",
]);

export const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".zip", ".tar", ".gz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".class", ".pyc",
  ".woff", ".woff2", ".ttf", ".otf",
  ".mp3", ".mp4", ".avi", ".mov",
  ".sqlite", ".db", ".bin", ".dat", ".lock",
]);

export const SENSITIVE_NAME =
  /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|credentials|secrets\.json|service-account\.json|[^/]*\.(?:pem|key|p12|pfx|keystore))(?:$|\/)?/i;

export const TEXT_SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyi", ".ps1", ".psm1", ".psd1", ".cs", ".java", ".kt",
  ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".rb",
  ".php", ".swift", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".sql",
  ".html", ".htm", ".css", ".scss", ".less", ".json", ".jsonc",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml",
  ".md", ".mdx", ".txt", ".rst", ".adoc", ".csv", ".tsv",
]);

export const DIRECTORY_FILE_EXTENSIONS = new Set([
  ...TEXT_SOURCE_EXTENSIONS,
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp", ".rtf", ".ipynb",
]);

// .ipynb can be attached as a native document, but is deliberately not
// classified as text source for --bundle-lines or Gemini text inlining.

export function matchesExclude(label, patterns = []) {
  const file = String(label).replace(/\\/g, "/");
  return patterns.some((pattern) => {
    const p = String(pattern).replace(/\\/g, "/").replace(/^!/, "");
    if (!p) return false;
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, ".*");
    return new RegExp(`^(?:${escaped})(?:$|/)`).test(file)
      || (!p.includes("/") && new RegExp(`(?:^|/)${escaped}$`).test(file));
  });
}

export function selectionReason(label) {
  const normalized = String(label).replace(/\\/g, "/");
  const basename = normalized.split("/").at(-1).toLowerCase();
  const dot = basename.lastIndexOf(".");
  const ext = dot > 0 ? basename.slice(dot) : "";

  if (normalized.split("/").some((part) => SKIP_DIRS.has(part))) {
    return "build/cache directory";
  }
  if (SKIP_EXT.has(ext) || SKIP_EXT.has(basename)) {
    return "binary or generated filename";
  }
  if (SENSITIVE_NAME.test(normalized)) {
    return "sensitive filename";
  }
  if (/\.min\.(?:js|css)$/i.test(basename)) {
    return "minified source filename";
  }
  return null;
}

export function isSelectableFile(label) {
  return selectionReason(label) === null;
}
