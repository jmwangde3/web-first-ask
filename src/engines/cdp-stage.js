import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../paths.js";
import { WfaError } from "../errors.js";
import { hashFile, sha256 } from "../util.js";
import { parseFileBlocks } from "../stage.js";

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeRelativePath(relativePath, root) {
  const value = String(relativePath ?? "").trim();
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const firstSegment = normalized.split("/")[0]?.toLowerCase();
  if ([".git", ".wfa", "node_modules"].includes(firstSegment)) {
    throw new WfaError("PROTECTED_RESULT_PATH", `Provider output cannot overwrite protected workspace metadata/dependency paths: ${value}`);
  }
  if (!value || !normalized || normalized.includes("\0") || normalized.startsWith("/")
    || normalized.startsWith("//") || /^[A-Za-z]:/.test(normalized) || normalized.includes(":")
    || normalized.split("/").some((part) => part === ".." || part === "." || part === ""
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new WfaError("UNSAFE_RESULT_PATH", `Refusing unsafe path from provider output: ${value || "(empty)"}`);
  }
  const target = path.resolve(root, ...normalized.split("/"));
  if (!isInside(root, target) || target === path.resolve(root)) {
    throw new WfaError("UNSAFE_RESULT_PATH", `Provider output path escapes the workspace: ${value}`);
  }
  return { normalized, target };
}

async function assertNoSymlinkComponents(root, target, { allowMissing = true } = {}) {
  const rootPath = path.resolve(root);
  const rootInfo = await lstat(rootPath).catch((error) => {
    if (error?.code === "ENOENT" && allowMissing) return null;
    throw error;
  });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WfaError("UNSAFE_RESULT_PATH", `Path root is missing, not a directory, or a symbolic link: ${rootPath}`);
  }
  const relative = path.relative(rootPath, path.resolve(target));
  let current = path.resolve(root);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new WfaError("UNSAFE_RESULT_PATH", `Refusing path containing a symbolic link: ${current}`);
      }
    } catch (error) {
      if (error instanceof WfaError) throw error;
      if (error?.code === "ENOENT" && allowMissing) break;
      throw error;
    }
  }
}

export function validateAnswerIntegrity(markdown = "") {
  const normalized = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  // 1. Fence pairing check
  let openFence = null;
  let fencePairs = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trimStart();
    if (!openFence) {
      const openMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (openMatch) {
        openFence = { char: openMatch[1][0], len: openMatch[1].length, line: i + 1 };
      }
    } else {
      const closeRe = new RegExp(`^${openFence.char}{${openFence.len},}\\s*$`);
      if (closeRe.test(trimmed)) {
        openFence = null;
        fencePairs += 1;
      }
    }
  }
  if (openFence) {
    throw new WfaError(
      "INCOMPLETE_CODE_FENCE",
      `Unclosed code fence starting at line ${openFence.line}; answer appears truncated.`,
    );
  }

  // 2. FILE: header count vs parsed blocks
  const fileHeaderCount = lines.filter((line) => /^FILE:\s*.+\s*$/.test(line)).length;
  let blocks = [];
  if (fileHeaderCount > 0) {
    blocks = parseFileBlocks(normalized);
    const uniqueFileHeaders = new Set(blocks.map((b) => b.filePath)).size;
    if (blocks.length < fileHeaderCount && uniqueFileHeaders < fileHeaderCount) {
      throw new WfaError(
        "TRUNCATED_FILE_BLOCKS",
        `Detected ${fileHeaderCount} FILE: headers but only parsed ${blocks.length} complete blocks.`,
      );
    }
  }

  // 3. Unified diff hunk line-count verification inside diff/patch blocks
  let verifiedHunks = 0;
  for (const block of blocks) {
    const isDiff = block.language === "diff" || block.language === "patch" ||
      /\.(diff|patch)$/i.test(block.filePath || "");
    if (!isDiff || typeof block.content !== "string") continue;
    const diffLines = block.content.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < diffLines.length; i += 1) {
      const m = diffLines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const expectedOld = m[2] === undefined ? 1 : Number(m[2]);
      const expectedNew = m[4] === undefined ? 1 : Number(m[4]);
      let actualOld = 0;
      let actualNew = 0;
      let j = i + 1;
      while (j < diffLines.length) {
        const l = diffLines[j];
        if (/^(@@ |diff --git |--- |\+\+\+ )/.test(l)) break;
        if (l.startsWith("\\ No newline")) { j += 1; continue; }
        if (l.startsWith("-")) actualOld += 1;
        else if (l.startsWith("+")) actualNew += 1;
        else if (l.startsWith(" ") || l === "") { actualOld += 1; actualNew += 1; }
        else break;
        j += 1;
      }
      if (actualOld !== expectedOld || actualNew !== expectedNew) {
        throw new WfaError(
          "INVALID_HUNK_LINE_COUNT",
          `Hunk mismatch in ${block.filePath}: header expects -${expectedOld}/+${expectedNew}, got -${actualOld}/+${actualNew}.`,
        );
      }
      verifiedHunks += 1;
      i = j - 1;
    }
  }

  return {
    ok: true,
    fencePairs,
    fileHeaderCount,
    blockCount: blocks.length,
    verifiedHunks,
  };
}

export async function extractFileBlocksToDir({
  markdown,
  outputDir,
  allowOverwrite = false,
} = {}) {
  if (!outputDir || typeof outputDir !== "string") {
    throw new WfaError("INVALID_ARGUMENT", "outputDir is required to extract FILE blocks.");
  }
  const integrity = validateAnswerIntegrity(markdown);
  const blocks = parseFileBlocks(markdown);
  const root = path.resolve(outputDir);
  await mkdir(root, { recursive: true });

  const planned = [];
  for (const block of blocks) {
    if (block.kind !== "full") {
      throw new WfaError("UNSUPPORTED_EXTRACT_KIND", `extractFileBlocksToDir only supports full FILE blocks, got ${block.kind} for ${block.filePath}`);
    }
    const { normalized, target } = assertSafeRelativePath(block.filePath, root);
    await assertNoSymlinkComponents(root, target, { allowMissing: true });
    if (!allowOverwrite) {
      const existing = await stat(target).catch(() => null);
      if (existing) {
        throw new WfaError("TARGET_FILE_EXISTS", `Refusing to overwrite existing file without allowOverwrite: ${normalized}`);
      }
    }
    planned.push({ filePath: normalized, targetPath: target, content: block.content });
  }

  const written = [];
  for (const item of planned) {
    await mkdir(path.dirname(item.targetPath), { recursive: true });
    await writeFile(item.targetPath, item.content, "utf8");
    const buf = Buffer.from(item.content, "utf8");
    written.push({
      filePath: item.filePath,
      targetPath: item.targetPath,
      bytes: buf.length,
      sha256: sha256(item.content),
    });
  }
  return { ok: true, outputDir: root, files: written, integrity };
}

export async function stageCdpResponse({
  home,
  runId,
  provider,
  text,
  workspaceRoot = process.cwd(),
} = {}) {
  if (!runId) {
    throw new WfaError("INVALID_ARGUMENT", "Missing runId for CDP staging.");
  }
  if (!text) {
    return null;
  }

  if (/^FILE:\s*.+\s*$/m.test(String(text))) {
    validateAnswerIntegrity(text);
  }
  let blocks;
  try {
    blocks = parseFileBlocks(text);
  } catch (error) {
    if (error instanceof WfaError && error.code === "NO_FILE_BLOCKS") {
      return null;
    }
    throw error;
  }

  const paths = getPaths(home);
  const runDir = path.join(paths.runs, String(runId));
  await mkdir(runDir, { recursive: true });

  const responsePath = path.join(runDir, "response.md");
  await writeFile(responsePath, text, { encoding: "utf8", mode: 0o600 });
  const responseSha256 = sha256(text);

  const preparedByPath = new Map();
  for (const block of blocks) {
    const safe = assertSafeRelativePath(block.filePath, workspaceRoot);
    const key = process.platform === "win32" ? safe.normalized.toLowerCase() : safe.normalized;
    let item = preparedByPath.get(key);
    if (!item) {
      await assertNoSymlinkComponents(workspaceRoot, safe.target);
      const existing = await stat(safe.target).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (existing && !existing.isFile()) {
        throw new WfaError("TARGET_NOT_FILE", `Target is not a regular file: ${safe.normalized}`);
      }
      item = {
        ...safe,
        content: existing ? await readFile(safe.target, "utf8") : null,
        originalExists: Boolean(existing),
        originalSha256: existing ? await hashFile(safe.target) : null,
      };
      preparedByPath.set(key, item);
    }
    if (block.kind === "replace") {
      if (!item.originalExists) {
        throw new WfaError("ANCHOR_NOT_FOUND", `Cannot replace an anchor in a missing file: ${safe.normalized}`);
      }
      const eol = item.content.includes("\r\n") ? "\r\n" : "\n";
      const anchor = block.anchor.replaceAll("\n", eol);
      const replacement = block.replacement.replaceAll("\n", eol);
      const first = item.content.indexOf(anchor);
      if (first === -1) {
        throw new WfaError("ANCHOR_NOT_FOUND", `Exact ANCHOR is absent from ${safe.normalized}; do not guess the replacement location.`);
      }
      if (item.content.indexOf(anchor, first + 1) !== -1) {
        throw new WfaError("ANCHOR_AMBIGUOUS", `Exact ANCHOR appears more than once in ${safe.normalized}; add more surrounding context.`);
      }
      item.content = item.content.slice(0, first) + replacement + item.content.slice(first + anchor.length);
    } else {
      item.content = block.content;
    }
  }

  const prepared = [...preparedByPath.values()];
  const stageRoot = path.join(runDir, "staged", provider);
  await assertNoSymlinkComponents(runDir, stageRoot);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  const files = [];
  for (const item of prepared) {
    const stagedPath = path.join(stageRoot, ...item.normalized.split("/"));
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, item.content, { encoding: "utf8", mode: 0o600 });
    const stagedSha256 = await hashFile(stagedPath);
    files.push({
      path: item.normalized,
      bytes: Buffer.byteLength(item.content, "utf8"),
      lines: item.content.split("\n").length - 1,
      stagedSha256,
      originalExists: item.originalExists,
      originalSha256: item.originalSha256,
    });
  }

  const manifest = {
    version: 1,
    runId: String(runId),
    provider,
    workspaceRoot,
    responseSha256,
    createdAt: new Date().toISOString(),
    files,
  };

  const manifestPath = path.join(stageRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    stageRoot,
    manifestPath,
    responseSha256,
    files,
  };
}
