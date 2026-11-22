import {
  chmod, copyFile, lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.js";
import { WfaError } from "./errors.js";
import { hashFile, sha256, uuid } from "./util.js";
import { inspectResponseHeuristics, verifyStoredCompletion } from "./metadata.js";

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeRelativePath(relativePath, root) {
  const value = String(relativePath ?? "").trim();
  // A single leading ./ is conventional and safe. All other dot segments and
  // traversal are still rejected rather than passed to path.resolve.
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

function parseFence(lines, at, filePath, label) {
  let index = at;
  while (index < lines.length && !lines[index].trim()) index += 1;
  const fence = lines[index]?.match(/^(`{3,})([A-Za-z0-9_+.-]*)\s*$/);
  if (!fence) throw new WfaError("INCOMPLETE_FILE_BLOCK", `${label} block "${filePath}" is not followed by a complete fenced body.`);
  const marker = fence[1];
  index += 1;
  const body = [];
  for (; index < lines.length && lines[index] !== marker; index += 1) body.push(lines[index]);
  if (index >= lines.length) throw new WfaError("INCOMPLETE_FILE_BLOCK", `${label} block "${filePath}" has an unterminated code fence.`);
  if (!body.length) throw new WfaError("EMPTY_FILE_BLOCK", `${label} block "${filePath}" is empty.`);
  return { content: `${body.join("\n")}\n`, last: index, language: fence[2] };
}

// Two accepted formats:
//   FILE: src/x.js\n```js\ncomplete source\n```
//   FILE: src/x.js\nANCHOR:\n```js\nexact existing text\n```\nREPLACE:\n```js\nnew text\n```
// An ANCHOR must occur exactly once, including its surrounding context.
export function parseFileBlocks(markdown = "") {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^FILE:\s*(.+?)\s*$/);
    if (!header) continue;
    const filePath = header[1].trim().replace(/^`(.*)`$/, "$1");
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
    if (/^ANCHOR:\s*$/.test(lines[cursor] ?? "")) {
      while (/^ANCHOR:\s*$/.test(lines[cursor] ?? "")) {
        const anchor = parseFence(lines, cursor + 1, filePath, "ANCHOR");
        cursor = anchor.last + 1;
        while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
        if (!/^REPLACE:\s*$/.test(lines[cursor] ?? "")) {
          throw new WfaError("INCOMPLETE_ANCHOR_BLOCK", `ANCHOR for ${filePath} requires a REPLACE block.`);
        }
        const replacement = parseFence(lines, cursor + 1, filePath, "REPLACE");
        blocks.push({ filePath, kind: "replace", anchor: anchor.content, replacement: replacement.content });
        index = replacement.last;
        cursor = replacement.last + 1;
        while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
      }
    } else {
      const file = parseFence(lines, cursor, filePath, "FILE");
      blocks.push({ filePath, kind: "full", content: file.content, language: file.language });
      index = file.last;
    }
  }
  if (!blocks.length) throw new WfaError("NO_FILE_BLOCKS", "No complete FILE: path plus fenced full-file or ANCHOR/REPLACE blocks were found.");
  const seen = new Map();
  for (const block of blocks) {
    const key = block.filePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const canonical = process.platform === "win32" ? key.toLowerCase() : key;
    const previous = seen.get(canonical);
    if (previous && (block.kind !== "replace" || previous !== "replace")) {
      throw new WfaError("DUPLICATE_FILE_BLOCK", `Provider returned incompatible duplicate FILE blocks: ${block.filePath}`);
    }
    seen.set(canonical, block.kind);
  }
  return blocks;
}

function assertCleanProviderOutput(markdown, child, task) {
  if (child.responseHeuristics?.latexEscaping || inspectResponseHeuristics(markdown).latexEscaping) {
    throw new WfaError("RESPONSE_LATEX_CORRUPTED", "Provider result contains LaTeX-escaped code (\\vert{}, \\lbrace, \\rbrace, or \\textbackslash). Refusing to stage/apply; request a clean complete response.");
  }
  // The answer says the attached files could not be read. For a code task that
  // was given attachments, the whole result is suspect: staging it would write
  // code written without the files it was asked to work from.
  const heuristics = child.responseHeuristics ?? inspectResponseHeuristics(markdown);
  if (heuristics.attachmentUnreadable && (task?.attachmentCount ?? 0) > 0) {
    throw new WfaError("RESPONSE_ATTACHMENT_UNUSED", "Provider says the attached files could not be read, so this result was produced without them. Refusing to stage/apply; send the content as text or ask again with a readable attachment.");
  }
}

async function loadCompletedCodeTask(taskId, provider, { home, store }) {
  const snapshot = await store.snapshot();
  const task = snapshot.tasks.tasks[taskId];
  if (!task) throw new WfaError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  if (task.kind !== "code" || task.mode === "spec") {
    throw new WfaError("NOT_APPLICABLE", "Only completed wfa code tasks in full-file mode can be staged or applied.");
  }
  const providers = Object.entries(task.children ?? {}).filter(([, child]) => child.state === "completed" && child.resultPath);
  const selected = provider ? provider.toLowerCase() : (providers.length === 1 ? providers[0][0] : null);
  if (!selected) throw new WfaError("PROVIDER_REQUIRED", "Specify --provider when the task has multiple completed provider results.");
  const child = task.children?.[selected];
  if (!child || child.state !== "completed" || !child.resultPath) {
    throw new WfaError("RESULT_NOT_READY", `Provider ${selected} has no completed result for task ${taskId}.`);
  }
  const runDir = path.resolve(task.runDir);
  const resultPath = path.resolve(child.resultPath);
  if (!isInside(runDir, resultPath)) throw new WfaError("UNSAFE_RESULT_SOURCE", "The recorded resultPath is outside this task's run directory.");
  await assertNoSymlinkComponents(runDir, resultPath, { allowMissing: false });
  const resultInfo = await stat(resultPath);
  if (!resultInfo.isFile()) throw new WfaError("UNSAFE_RESULT_SOURCE", "The recorded resultPath is not a regular file.");
  const workspaceRoot = path.resolve(task.workspaceRoot ?? process.cwd());
  const rootInfo = await lstat(workspaceRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WfaError("WORKSPACE_ROOT_UNAVAILABLE", `Recorded workspace root is missing or not a real directory: ${workspaceRoot}`);
  }
  const responseHash = await hashFile(resultPath);
  if (child.completionProof) {
    const proof = await verifyStoredCompletion(task.outputDir, child, selected, task.runDir);
    if (!proof.verified || path.resolve(proof.result.responsePath) !== resultPath
      || responseHash !== child.completionProof.responseSha256) {
      throw new WfaError("RESULT_INTEGRITY_FAILED", proof.error ?? "The ask-bridge terminal result changed after verification.");
    }
  }
  assertCleanProviderOutput(await readFile(resultPath, "utf8"), child, task);
  return { task, child, selected, runDir, resultPath, workspaceRoot, responseHash };
}

export async function readTaskResult(taskId, {
  provider, stdout = false, home, store = new Store(home),
} = {}) {
  const snapshot = await store.snapshot();
  const task = snapshot.tasks.tasks[taskId];
  if (!task) throw new WfaError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  const candidates = Object.entries(task.children ?? {}).filter(([, child]) => child.resultPath);
  const selected = provider ? provider.toLowerCase() : (candidates.length === 1 ? candidates[0][0] : null);
  if (!selected) throw new WfaError("PROVIDER_REQUIRED", "Specify --provider when the task has multiple result files.");
  const child = task.children?.[selected];
  if (!child?.resultPath) throw new WfaError("RESULT_NOT_READY", `No saved result for ${selected}.`);
  const resultPath = path.resolve(child.resultPath);
  if (!task.runDir || !isInside(task.runDir, resultPath)) {
    throw new WfaError("UNSAFE_RESULT_SOURCE", "The recorded resultPath is outside this task's run directory.");
  }
  await assertNoSymlinkComponents(task.runDir, resultPath, { allowMissing: false });
  const body = await readFile(resultPath, "utf8");
  if (child.completionProof) {
    const proof = await verifyStoredCompletion(task.outputDir, child, selected, task.runDir);
    if (!proof.verified || path.resolve(proof.result.responsePath) !== resultPath
      || sha256(body) !== child.completionProof.responseSha256) {
      throw new WfaError("RESULT_INTEGRITY_FAILED", proof.error ?? "The ask-bridge terminal result changed after verification.");
    }
  }
  const warnings = { responseHeuristics: child.responseHeuristics ?? null,
    sessionIsolationWarning: child.sessionIsolationWarning ?? null };
  return stdout ? { taskId, provider: selected, resultPath, body, ...warnings }
    : { taskId, provider: selected, resultPath, bytes: Buffer.byteLength(body, "utf8"),
      sha256: sha256(body), state: child.state, ...warnings };
}

export async function stageTaskFiles(taskId, { provider, home, store = new Store(home) } = {}) {
  const taskInfo = await loadCompletedCodeTask(taskId, provider, { home, store });
  const markdown = await readFile(taskInfo.resultPath, "utf8");
  const blocks = parseFileBlocks(markdown);
  const preparedByPath = new Map();
  for (const block of blocks) {
    const safe = assertSafeRelativePath(block.filePath, taskInfo.workspaceRoot);
    const key = process.platform === "win32" ? safe.normalized.toLowerCase() : safe.normalized;
    let item = preparedByPath.get(key);
    if (!item) {
      await assertNoSymlinkComponents(taskInfo.workspaceRoot, safe.target);
      const existing = await stat(safe.target).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (existing && !existing.isFile()) throw new WfaError("TARGET_NOT_FILE", `Target is not a regular file: ${safe.normalized}`);
      item = { ...safe, content: existing ? await readFile(safe.target, "utf8") : null,
        originalExists: Boolean(existing), originalSha256: existing ? await hashFile(safe.target) : null,
        originalMode: existing ? (existing.mode & 0o777) : 0o644 };
      preparedByPath.set(key, item);
    }
    if (block.kind === "replace") {
      if (!item.originalExists) throw new WfaError("ANCHOR_NOT_FOUND", `Cannot replace an anchor in a missing file: ${safe.normalized}`);
      // Match complete physical lines. A CRLF source is still an exact
      // line-by-line match, and its original line endings remain unchanged.
      const eol = item.content.includes("\r\n") ? "\r\n" : "\n";
      const anchor = block.anchor.replaceAll("\n", eol);
      const replacement = block.replacement.replaceAll("\n", eol);
      const first = item.content.indexOf(anchor);
      if (first === -1) throw new WfaError("ANCHOR_NOT_FOUND", `Exact ANCHOR is absent from ${safe.normalized}; do not guess the replacement location.`);
      if (item.content.indexOf(anchor, first + 1) !== -1) {
        throw new WfaError("ANCHOR_AMBIGUOUS", `Exact ANCHOR appears more than once in ${safe.normalized}; add more surrounding context.`);
      }
      item.content = item.content.slice(0, first) + replacement + item.content.slice(first + anchor.length);
    } else item.content = block.content;
  }
  const prepared = [...preparedByPath.values()];
  const stageRoot = path.join(taskInfo.runDir, "staged", taskInfo.selected);
  await assertNoSymlinkComponents(taskInfo.runDir, stageRoot);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });
  const files = [];
  for (const item of prepared) {
    const stagedPath = path.join(stageRoot, ...item.normalized.split("/"));
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, item.content, { encoding: "utf8", mode: 0o600 });
    files.push({ path: item.normalized, stagedPath, bytes: Buffer.byteLength(item.content, "utf8"),
      lines: item.content.split("\n").length - 1, stagedSha256: await hashFile(stagedPath),
      originalExists: item.originalExists, originalSha256: item.originalSha256, originalMode: item.originalMode });
  }
  const manifest = { version: 1, taskId, provider: taskInfo.selected, workspaceRoot: taskInfo.workspaceRoot,
    resultPath: taskInfo.resultPath, responseSha256: taskInfo.responseHash,
    createdAt: new Date().toISOString(), files };
  const manifestPath = path.join(stageRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { taskId, provider: taskInfo.selected, stageRoot, manifestPath, responseSha256: taskInfo.responseHash,
    files: files.map(({ path: filePath, bytes, lines, originalExists, originalSha256, originalMode, stagedSha256 }) => ({
      path: filePath, bytes, lines, originalExists, originalSha256, originalMode, stagedSha256,
    })) };
}

export async function applyStagedFiles(taskId, {
  provider, confirm = false, home, store = new Store(home),
} = {}) {
  const taskInfo = await loadCompletedCodeTask(taskId, provider, { home, store });
  const stageRoot = path.join(taskInfo.runDir, "staged", taskInfo.selected);
  const manifestPath = path.join(stageRoot, "manifest.json");
  await assertNoSymlinkComponents(taskInfo.runDir, manifestPath, { allowMissing: false });
  const manifestInfo = await stat(manifestPath);
  if (!manifestInfo.isFile()) throw new WfaError("UNSAFE_STAGE_MANIFEST", "Stage manifest is not a regular file.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") throw new WfaError("STAGE_REQUIRED", "Run `wfa stage <task-id> --provider <provider>` first.");
    throw error;
  }));
  if (!Array.isArray(manifest.files) || !manifest.files.length
    || manifest.taskId !== taskId || manifest.provider !== taskInfo.selected
    || path.resolve(manifest.workspaceRoot) !== taskInfo.workspaceRoot
    || manifest.responseSha256 !== taskInfo.responseHash) {
    throw new WfaError("STAGE_STALE", "Task result or workspace identity changed after staging. Run `wfa stage` again.");
  }

  const targets = [];
  const seenTargets = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== "string" || typeof item.stagedPath !== "string"
      || typeof item.stagedSha256 !== "string" || typeof item.originalExists !== "boolean") {
      throw new WfaError("INVALID_STAGE_MANIFEST", "Stage manifest contains an invalid file entry.");
    }
    const safe = assertSafeRelativePath(item.path, taskInfo.workspaceRoot);
    const targetKey = process.platform === "win32" ? safe.normalized.toLowerCase() : safe.normalized;
    if (seenTargets.has(targetKey)) {
      throw new WfaError("DUPLICATE_STAGE_TARGET", `Stage manifest contains duplicate target paths: ${safe.normalized}`);
    }
    seenTargets.add(targetKey);
    await assertNoSymlinkComponents(taskInfo.workspaceRoot, safe.target);
    const current = await stat(safe.target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (current && !current.isFile()) throw new WfaError("TARGET_NOT_FILE", `Target is not a regular file: ${item.path}`);
    const currentHash = current ? await hashFile(safe.target) : null;
    const currentMode = current ? (current.mode & 0o777) : 0o644;
    if (Boolean(current) !== item.originalExists || currentHash !== item.originalSha256
      || currentMode !== item.originalMode) {
      throw new WfaError("TARGET_CHANGED", `Target changed after staging: ${item.path}. Re-stage and review before applying.`);
    }
    const stagedPath = path.resolve(item.stagedPath);
    if (!isInside(stageRoot, stagedPath)) throw new WfaError("UNSAFE_STAGE_PATH", `Staged file escapes task staging directory: ${item.path}`);
    await assertNoSymlinkComponents(stageRoot, stagedPath, { allowMissing: false });
    const stagedInfo = await stat(stagedPath);
    if (!stagedInfo.isFile()) throw new WfaError("UNSAFE_STAGE_PATH", `Staged path is not a regular file: ${item.path}`);
    if (await hashFile(stagedPath) !== item.stagedSha256) {
      throw new WfaError("STAGED_FILE_CHANGED", `Staged content changed after preview: ${item.path}`);
    }
    targets.push({ ...item, targetPath: safe.target, stagedPath });
  }

  if (!confirm) {
    return { applied: false, taskId, provider: taskInfo.selected,
      files: targets.map((item) => ({ path: item.path, originalExists: item.originalExists, bytes: item.bytes })) };
  }

  const backupRoot = path.join(taskInfo.runDir, "apply-backups", taskInfo.selected, uuid());
  const applied = [];
  let transactionCommitted = false;
  const rollback = async () => {
    const failures = [];
    for (const item of [...applied].reverse()) {
      try {
        const currentInfo = await stat(item.targetPath).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        const currentHash = currentInfo ? await hashFile(item.targetPath) : null;
        const currentMode = currentInfo ? (currentInfo.mode & 0o777) : null;
        if (currentHash !== item.stagedSha256 || currentMode !== item.originalMode) {
          throw new Error("target changed after WFA wrote it; refusing to overwrite that newer edit during rollback");
        }
        if (item.originalExists) {
          const restoreTemp = `${item.targetPath}.wfa-restore-${uuid()}`;
          await copyFile(item.backupPath, restoreTemp);
          await chmod(restoreTemp, item.originalMode);
          await rename(restoreTemp, item.targetPath);
        } else {
          await unlink(item.targetPath);
        }
      } catch (error) {
        failures.push(`${item.path}: ${error.message}`);
      }
    }
    return failures;
  };

  try {
    await store.transaction(async ({ tasks }) => {
      const currentTask = tasks.tasks[taskId];
      const currentChild = currentTask?.children?.[taskInfo.selected];
      if (!currentChild || currentChild.state !== "completed" || currentChild.resultPath !== taskInfo.resultPath) {
        throw new WfaError("APPLY_STATE_CHANGED", "Task state changed before apply. Inspect the task and staged files.");
      }
      if (await hashFile(taskInfo.resultPath) !== manifest.responseSha256) {
        throw new WfaError("STAGE_STALE", "Provider result changed after staging. Run `wfa stage` again.");
      }
      await mkdir(backupRoot, { recursive: true });
      for (const item of targets) {
        await assertNoSymlinkComponents(taskInfo.workspaceRoot, item.targetPath);
        const current = await stat(item.targetPath).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        const currentHash = current ? await hashFile(item.targetPath) : null;
        const currentMode = current ? (current.mode & 0o777) : 0o644;
        if (Boolean(current) !== item.originalExists || currentHash !== item.originalSha256
          || currentMode !== item.originalMode) {
          throw new WfaError("TARGET_CHANGED", `Target changed during apply preflight: ${item.path}. No files were written.`);
        }
        if (await hashFile(item.stagedPath) !== item.stagedSha256) {
          throw new WfaError("STAGED_FILE_CHANGED", `Staged content changed during apply preflight: ${item.path}.`);
        }
      }

      for (const item of targets) {
        await assertNoSymlinkComponents(taskInfo.workspaceRoot, item.targetPath);
        const current = await stat(item.targetPath).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        const currentHash = current ? await hashFile(item.targetPath) : null;
        const currentMode = current ? (current.mode & 0o777) : 0o644;
        if (Boolean(current) !== item.originalExists || currentHash !== item.originalSha256
          || currentMode !== item.originalMode) {
          throw new WfaError("TARGET_CHANGED", `Target changed immediately before write: ${item.path}.`);
        }
        await mkdir(path.dirname(item.targetPath), { recursive: true });
        const tempPath = path.join(path.dirname(item.targetPath), `.wfa-${uuid()}.tmp`);
        const backupPath = path.join(backupRoot, ...item.path.split("/"));
        try {
          await copyFile(item.stagedPath, tempPath);
          await chmod(tempPath, item.originalMode);
          if (item.originalExists) {
            await mkdir(path.dirname(backupPath), { recursive: true });
            await copyFile(item.targetPath, backupPath);
            if (await hashFile(backupPath) !== item.originalSha256
              || await hashFile(item.targetPath) !== item.originalSha256) {
              throw new WfaError("TARGET_CHANGED", `Target changed during backup immediately before write: ${item.path}.`);
            }
          } else {
            const appeared = await stat(item.targetPath).catch((error) => {
              if (error?.code === "ENOENT") return null;
              throw error;
            });
            if (appeared) throw new WfaError("TARGET_CHANGED", `A new target appeared immediately before write: ${item.path}.`);
          }
          await rename(tempPath, item.targetPath);
          applied.push({ ...item, backupPath });
        } catch (error) {
          await unlink(tempPath).catch(() => {});
          throw error;
        }
      }
      currentChild.appliedAt = new Date().toISOString();
      currentChild.appliedFiles = targets.map((item) => item.path);
      currentChild.revision = (currentChild.revision ?? 0) + 1;
    });
    transactionCommitted = true;
  } catch (error) {
    const failures = await rollback();
    if (failures.length) {
      throw new WfaError("APPLY_ROLLBACK_INCOMPLETE", `Apply failed and rollback was incomplete. Backups retained at ${backupRoot}. Failures: ${failures.join("; ")}. Original error: ${error.message}`);
    }
    if (applied.length) {
      throw new WfaError("APPLY_ROLLED_BACK", `Apply failed; previously written files were rolled back. Backups retained at ${backupRoot}. Cause: ${error.message}`);
    }
    throw error;
  }
  return { applied: transactionCommitted, taskId, provider: taskInfo.selected, backupRoot,
    files: targets.map((item) => item.path) };
}
