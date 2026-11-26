import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { sha256 } from "./util.js";
import { WfaError } from "./errors.js";

export const MAX_BRIEF_CHARS = 12000;
export const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;
// Inline bundle ceiling from bundleRepository (src/repository.js): sources
// pasted into the prompt above this are truncated upstream, so a fallback
// retry must use the attached archive instead.
export const INLINE_BUNDLE_MAX_BYTES = 30 * 1024;

// F8 — pick the transport for a repo-read-failure fallback retry. The attached
// archive travels outside the prompt, so it is preferred whenever it is
// available; the inline bundle is the fallback only when it fits the prompt
// ceiling. Returns "none" when neither transport can carry the sources.
export function selectRepoFallbackTransport({ inlineBytes = null, archiveAvailable = false } = {}) {
  if (archiveAvailable) return { transport: "zip", reason: "Attached archive travels outside the prompt, so prompt truncation cannot corrupt it." };
  if (inlineBytes !== null && inlineBytes <= INLINE_BUNDLE_MAX_BYTES) {
    return { transport: "inline", reason: `Inline bundle is ${inlineBytes} bytes, within the ${INLINE_BUNDLE_MAX_BYTES} byte prompt ceiling.` };
  }
  if (inlineBytes === null) return { transport: "none", reason: "No attached archive is available and the inline bundle size is unknown." };
  return { transport: "none", reason: `Inline bundle is ${inlineBytes} bytes, over the ${INLINE_BUNDLE_MAX_BYTES} byte prompt ceiling, and no attached archive is available.` };
}

export async function resolveBriefText({
  briefFile,
  cwd = process.cwd(),
  shouldAutoInject = false,
  maxChars = MAX_BRIEF_CHARS,
} = {}) {
  const candidate = briefFile
    ? path.resolve(cwd, briefFile)
    : (shouldAutoInject ? path.join(cwd, ".wfa", "active-brief.md") : null);
  if (!candidate) return "";
  let raw;
  try {
    raw = await readFile(candidate, "utf8");
  } catch (error) {
    if (!briefFile && error?.code === "ENOENT") return "";
    throw new WfaError("BRIEF_READ_FAILED", `Could not read project brief ${candidate}: ${error.message}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[brief truncated at ${maxChars} characters]`;
}

export function prependBrief(prompt, briefText) {
  if (!briefText || !briefText.trim()) return prompt;
  return `[Project Handoff Context — background only; current task instructions take precedence]\n${briefText.trim()}\n\n---\n\n${prompt}`;
}

function displayPath(filePath, cwd) {
  const relative = path.relative(cwd, filePath).replaceAll("\\", "/");
  return relative && !relative.startsWith("../") ? relative : filePath.replaceAll("\\", "/");
}

function decodeUtf8(buffer, filePath) {
  if (buffer.includes(0)) {
    throw new WfaError("BUNDLE_BINARY_FILE", `Cannot line-number binary attachment: ${filePath}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new WfaError("BUNDLE_INVALID_UTF8", `Cannot line-number non-UTF-8 attachment: ${filePath}`);
  }
}

function logicalLines(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length === 0) return [];
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export async function buildLineNumberedBundle(files, {
  cwd = process.cwd(),
  maxBytes = MAX_BUNDLE_BYTES,
} = {}) {
  const sections = [];
  const included = [];
  for (const filePath of files) {
    const absolute = path.resolve(cwd, filePath);
    const body = decodeUtf8(await readFile(absolute), absolute);
    const lines = logicalLines(body);
    const label = displayPath(absolute, cwd);
    const numbered = lines.map((line, index) => `${label}:${index + 1} | ${line}`).join("\n");
    sections.push(`===== FILE: ${label} (${lines.length} lines) =====\n${numbered}\n===== END FILE: ${label} =====`);
    included.push({ path: label, lines: lines.length, bytes: Buffer.byteLength(body, "utf8") });
  }
  const content = `${sections.join("\n\n")}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new WfaError("BUNDLE_SIZE_LIMIT", `Line-numbered bundle is ${(bytes / 1024 / 1024).toFixed(1)} MiB; limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MiB. Select fewer files or use --mode spec.`);
  }
  return {
    content,
    bytes,
    sha256: sha256(content),
    files: included,
    lines: included.reduce((sum, item) => sum + item.lines, 0),
  };
}

export async function writeLineNumberedBundle(files, { outDir, cwd = process.cwd() } = {}) {
  if (!outDir) throw new WfaError("BUNDLE_OUTPUT_REQUIRED", "Bundle output directory is required.");
  const bundle = await buildLineNumberedBundle(files, { cwd });
  await mkdir(outDir, { recursive: true });
  const bundlePath = path.join(outDir, `source-bundle-${bundle.sha256.slice(0, 12)}.txt`);
  await writeFile(bundlePath, bundle.content, { encoding: "utf8", mode: 0o600 });
  return { ...bundle, bundlePath };
}

const SECRET_PATTERNS = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi],
  ["openai_api_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["secret_assignment", /\b(?:api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{12,})/gi],
];

export function scanSensitiveText(text, source = "prompt") {
  const findings = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    for (const [kind, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[lineIndex])) {
        findings.push({ source, line: lineIndex + 1, kind });
      }
    }
  }
  return findings;
}

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 4);
}
