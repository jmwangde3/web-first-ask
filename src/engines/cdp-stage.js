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
