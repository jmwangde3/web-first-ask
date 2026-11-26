import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractFileBlocksToDisk, verifyFileBlockIntegrity } from "../src/stage.js";
import { classifyProviderError } from "../src/provider-errors.js";
import { INLINE_BUNDLE_MAX_BYTES, selectRepoFallbackTransport } from "../src/bundle.js";
import { probeArchiveFallback } from "../src/repository-archive.js";
import { decideRepoFallback, planRepoFallback, recordRepoFallback } from "../src/repo-fallback.js";
import { sha256 } from "../src/util.js";

const MULTI_FILE = `Here are the files:
FILE: src/a.js
\`\`\`js
console.log("a");
\`\`\`

FILE: src/b.js
\`\`\`js
console.log("b");
console.log("b2");
\`\`\`
`;

const TRUNCATED = `FILE: src/a.js
\`\`\`js
console.log("a");
`;

async function tmpDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function assertNotExists(target) {
  await assert.rejects(lstat(target), { code: "ENOENT" });
}

// --- F3: integrity self-check (pure) ---

test("F3 verify: well-formed multi-file answer passes with matching counts", () => {
  const report = verifyFileBlockIntegrity(MULTI_FILE);
  assert.equal(report.ok, true);
  assert.equal(report.fileHeaders, 2);
  assert.equal(report.fenceOpens, 2);
  assert.equal(report.fenceCloses, 2);
  assert.equal(report.blocks, 2);
  assert.deepEqual(report.blockLineCounts, [
    { path: "src/a.js", kind: "full", lines: 1 },
    { path: "src/b.js", kind: "full", lines: 2 },
  ]);
  assert.deepEqual(report.failures, []);
});

test("F3 verify: truncated answer fails fence pairing and block count with expected vs found", () => {
  const report = verifyFileBlockIntegrity(TRUNCATED);
  assert.equal(report.ok, false);
  const fences = report.checks.find((check) => check.name === "fence-pairing");
  assert.equal(fences.expected, 1);
  assert.equal(fences.found, 0);
  assert.equal(fences.ok, false);
  const blocks = report.checks.find((check) => check.name === "block-count");
  assert.equal(blocks.expected, 1);
  assert.equal(blocks.found, 0);
  assert.equal(blocks.detail, "INCOMPLETE_FILE_BLOCK: FILE block \"src/a.js\" has an unterminated code fence.");
  const trailing = report.checks.find((check) => check.name === "trailing-truncation");
  assert.equal(trailing.ok, false);
  assert.equal(report.parseErrorCode, "INCOMPLETE_FILE_BLOCK");
});

test("F3 verify: FILE header with no fence at all is rejected", () => {
  const report = verifyFileBlockIntegrity("FILE: src/a.js\n");
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "block-count").found, 0);
});

test("F3 verify: ANCHOR without REPLACE is rejected", () => {
  const text = "FILE: src/a.js\nANCHOR:\n```js\nold\n```\n";
  const report = verifyFileBlockIntegrity(text);
  assert.equal(report.ok, false);
  assert.equal(report.parseErrorCode, "INCOMPLETE_ANCHOR_BLOCK");
});

test("F3 verify: hunk line counts are recorded for ANCHOR/REPLACE blocks", () => {
  const text = "FILE: src/a.js\nANCHOR:\n```js\nold one\nold two\n```\nREPLACE:\n```js\nnew one\n```\n";
  const report = verifyFileBlockIntegrity(text);
  assert.equal(report.ok, true);
  assert.deepEqual(report.blockLineCounts, [
    { path: "src/a.js", kind: "replace", anchorLines: 2, replacementLines: 1 },
  ]);
});

// --- F3: extraction to disk ---

test("F3 extract: well-formed multi-file answer is written with matching hashes", async () => {
  const outDir = path.join(await tmpDir("wfa-f3-out-"), "extracted");
  try {
    const result = await extractFileBlocksToDisk(MULTI_FILE, { outputDir: outDir });
    assert.equal(result.blockCount, 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.sourceSha256, sha256(MULTI_FILE));
    for (const file of result.files) {
      const onDisk = await readFile(path.join(outDir, file.path), "utf8");
      assert.equal(sha256(onDisk), file.sha256);
      assert.equal(file.bytes, Buffer.byteLength(onDisk, "utf8"));
    }
    assert.equal(result.files[0].lines, 1);
    assert.equal(result.files[1].lines, 2);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.sourceSha256, result.sourceSha256);
    assert.equal(manifest.files[1].sha256, result.files[1].sha256);
  } finally {
    await rm(path.dirname(outDir), { recursive: true, force: true });
  }
});

test("F3 extract: truncated input is rejected and writes nothing", async () => {
  const base = await tmpDir("wfa-f3-trunc-");
  const outDir = path.join(base, "extracted");
  try {
    await assert.rejects(
      () => extractFileBlocksToDisk(TRUNCATED, { outputDir: outDir }),
      (error) => error.code === "FILE_BLOCK_INTEGRITY_FAILED"
        && /fence-pairing \(expected 1, found 0/.test(error.message)
        && /block-count \(expected 1, found 0/.test(error.message),
    );
    await assertNotExists(outDir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("F3 extract: path traversal is rejected and writes nothing", async () => {
  const base = await tmpDir("wfa-f3-trav-");
  const outDir = path.join(base, "extracted");
  try {
    await assert.rejects(
      () => extractFileBlocksToDisk("FILE: ../evil.js\n```js\nbad\n```\n", { outputDir: outDir }),
      { code: "UNSAFE_RESULT_PATH" },
    );
    await assertNotExists(outDir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("F3 extract: output inside the target repository is refused", async () => {
  const repoRoot = await tmpDir("wfa-f3-repo-");
  try {
    await assert.rejects(
      () => extractFileBlocksToDisk(MULTI_FILE, {
        outputDir: path.join(repoRoot, "staged"), repositoryRoot: repoRoot,
      }),
      { code: "EXTRACT_OUTPUT_INSIDE_REPO" },
    );
    await assertNotExists(path.join(repoRoot, "staged"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("F3 extract: ANCHOR/REPLACE applies against supplied originals", async () => {
  const base = await tmpDir("wfa-f3-replace-");
  const outDir = path.join(base, "extracted");
  try {
    const text = "FILE: src/x.js\nANCHOR:\n```js\nline2\n```\nREPLACE:\n```js\nline2-new\n```\n";
    const result = await extractFileBlocksToDisk(text, {
      outputDir: outDir,
      originals: new Map([["src/x.js", "line1\nline2\nline3\n"]]),
    });
    assert.equal(result.files.length, 1);
    const written = await readFile(path.join(outDir, "src", "x.js"), "utf8");
    assert.equal(written, "line1\nline2-new\nline3\n");
    assert.equal(result.files[0].sha256, sha256(written));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("F3 extract: ANCHOR/REPLACE without originals refuses and writes nothing", async () => {
  const base = await tmpDir("wfa-f3-replace-missing-");
  const outDir = path.join(base, "extracted");
  try {
    const text = "FILE: src/x.js\nANCHOR:\n```js\nline2\n```\nREPLACE:\n```js\nline2-new\n```\n";
    await assert.rejects(
      () => extractFileBlocksToDisk(text, { outputDir: outDir }),
      { code: "EXTRACT_REPLACE_NEEDS_ORIGINAL" },
    );
    await assertNotExists(outDir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- F8: provider error classification ---

test("F8 classify: a completed REPO_UNREADABLE answer is classified, not cleared", () => {
  const result = classifyProviderError({
    answerText: "REPO_UNREADABLE", state: "completed", hasResponse: true,
  });
  assert.equal(result.errorCode, "REPO_UNREADABLE");
  assert.equal(result.repoUnreadable, true);
  assert.equal(result.fallbackRecommended, true);
  assert.equal(result.repoUnreadableEvidence.kind, "sentinel");
  assert.match(result.recoveryHint, /do not resend the original prompt/i);
});

test("F8 classify: a quoted mention of the sentinel is not a signal", () => {
  const result = classifyProviderError({
    answerText: "The identifier REPO_UNREADABLE is in the test file.",
    state: "completed", hasResponse: true,
  });
  assert.equal(result.errorCode, null);
});

test("F8 classify: REPO_UNREADABLE in failed error text is classified", () => {
  const result = classifyProviderError({ error: "provider answered REPO_UNREADABLE", state: "failed" });
  assert.equal(result.errorCode, "REPO_UNREADABLE");
  assert.equal(result.fallbackRecommended, true);
});

test("F8 classify: stale error text does not downgrade a completed answer", () => {
  const result = classifyProviderError({
    error: "earlier job noted REPO_UNREADABLE", state: "completed", hasResponse: true,
  });
  assert.equal(result.errorCode, null);
});

// --- F8: transport selection ---

test("F8 transport: archive is preferred; inline only when it fits; none otherwise", () => {
  assert.equal(selectRepoFallbackTransport({ archiveAvailable: true, inlineBytes: 10 }).transport, "zip");
  assert.equal(selectRepoFallbackTransport({ archiveAvailable: false, inlineBytes: 100 }).transport, "inline");
  assert.deepEqual(selectRepoFallbackTransport({ archiveAvailable: false, inlineBytes: INLINE_BUNDLE_MAX_BYTES + 1 }), {
    transport: "none",
    reason: `Inline bundle is ${INLINE_BUNDLE_MAX_BYTES + 1} bytes, over the ${INLINE_BUNDLE_MAX_BYTES} byte prompt ceiling, and no attached archive is available.`,
  });
  assert.equal(selectRepoFallbackTransport({ archiveAvailable: false, inlineBytes: null }).transport, "none");
});

// --- F8: archive probe ---

test("F8 probe: non-Git directory has no archive transport", async () => {
  const dir = await tmpDir("wfa-f8-nogit-");
  try {
    const probe = await probeArchiveFallback({ cwd: dir });
    assert.equal(probe.available, false);
    assert.equal(probe.transport, "zip");
    assert.match(probe.reason, /Git working tree/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F8 probe: Git checkout with tracked files offers the archive transport", async () => {
  const root = await tmpDir("wfa-f8-git-");
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    git("init", "-q");
    git("config", "user.email", "a@example.test");
    git("config", "user.name", "Test");
    await writeFile(path.join(root, "main.js"), "export const answer = 42;\n");
    git("add", ".");
    git("commit", "-qm", "first");
    const probe = await probeArchiveFallback({ cwd: root });
    assert.equal(probe.available, true);
    assert.equal(probe.files, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- F8: fallback decision ---

const PARENT = {
  answerText: "REPO_UNREADABLE",
  provider: "chatgpt",
  parentTaskId: "task-parent",
  parentRequestId: "req-parent",
  workspace: "x",
  kind: "code",
  repoAvailable: true,
  archiveAvailable: true,
};

test("F8 decide: sentinel + local repo + archive yields a new bundled turn, not a resend", () => {
  const decision = decideRepoFallback(PARENT);
  assert.equal(decision.action, "retry-with-bundle");
  assert.equal(decision.transport, "zip");
  assert.equal(decision.followupTaskId, "task-parent");
  assert.equal(decision.provider, "chatgpt");
  assert.notEqual(decision.newRequestId, "req-parent");
  assert.match(decision.newRequestId, /^repo-fallback-/);
  assert.match(decision.instruction, /attached repository archive/);
  assert.doesNotMatch(decision.instruction, /Explain main\.js/);
  assert.match(decision.command, /--bundle-repo=zip/);
  // Deterministic: re-deciding the same parent yields the same new id, so a
  // re-drive cannot mint a duplicate turn.
  assert.equal(decideRepoFallback(PARENT).newRequestId, decision.newRequestId);
});

test("F8 decide: inline transport is used when no archive fits the prompt ceiling", () => {
  const decision = decideRepoFallback({ ...PARENT, archiveAvailable: false, inlineBytes: 120 });
  assert.equal(decision.action, "retry-with-bundle");
  assert.equal(decision.transport, "inline");
  assert.match(decision.instruction, /inlined repository sources/);
});

test("F8 decide: no signal, no local repo, already bundled, or already retried all decline", () => {
  assert.deepEqual(
    decideRepoFallback({ ...PARENT, answerText: "Here is the answer." }).action, "none");
  assert.equal(
    decideRepoFallback({ ...PARENT, repoAvailable: false }).reason, "no-local-repository");
  assert.equal(
    decideRepoFallback({ ...PARENT, bundleAlreadyUsed: true }).reason, "bundle-already-sent");
  assert.equal(
    decideRepoFallback({ ...PARENT, fallbackAlreadyUsed: true }).reason, "fallback-already-attempted");
  assert.equal(
    decideRepoFallback({ ...PARENT, archiveAvailable: false, inlineBytes: INLINE_BUNDLE_MAX_BYTES + 1 }).reason,
    "no-fallback-transport");
});

test("F8 record: fallback is recorded on the parent turn and cannot be recorded twice", () => {
  const decision = decideRepoFallback(PARENT);
  const child = { provider: "chatgpt", state: "repo_unreadable", repoUnreadable: true };
  const recorded = recordRepoFallback(child, decision, { now: new Date("2026-11-26T00:00:00.000Z") });
  assert.equal(recorded.repoFallbackUsed, true);
  assert.equal(recorded.state, "repo_unreadable");
  assert.equal(recorded.repoFallback.transport, "zip");
  assert.equal(recorded.repoFallback.newRequestId, decision.newRequestId);
  assert.equal(recorded.repoFallback.attemptedAt, "2026-11-26T00:00:00.000Z");
  assert.match(recorded.recoveryHint, /Do not resend the original prompt/);
  assert.throws(
    () => recordRepoFallback(child, decision),
    { code: "REPO_FALLBACK_ALREADY_RECORDED" },
  );
  assert.throws(
    () => recordRepoFallback({ state: "repo_unreadable" }, { action: "none", reason: "no-signal" }),
    { code: "REPO_FALLBACK_NOT_APPLICABLE" },
  );
});

test("F8 plan: non-Git checkout declines; Git checkout plans a zip retry", async () => {
  const plain = await tmpDir("wfa-f8-plan-plain-");
  const root = await tmpDir("wfa-f8-plan-git-");
  try {
    const { archiveAvailable: _archiveAvailable, ...signal } = PARENT;
    const declined = await planRepoFallback({ cwd: plain, ...signal });
    assert.equal(declined.action, "none");
    assert.equal(declined.reason, "no-fallback-transport");
    assert.equal(declined.probe.available, false);

    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    git("init", "-q");
    git("config", "user.email", "a@example.test");
    git("config", "user.name", "Test");
    await writeFile(path.join(root, "main.js"), "export const answer = 42;\n");
    git("add", ".");
    git("commit", "-qm", "first");
    await mkdir(path.join(root, "sub"), { recursive: true });
    const planned = await planRepoFallback({ cwd: root, ...PARENT, archiveAvailable: undefined });
    assert.equal(planned.action, "retry-with-bundle");
    assert.equal(planned.transport, "zip");
    assert.equal(planned.probe.available, true);
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
