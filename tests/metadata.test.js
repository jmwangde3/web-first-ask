import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readBatchMetadata, verifyStoredCompletion } from "../src/metadata.js";

async function writeJob(root, jobId, provider, state, response = null, extra = {}) {
  const dir = path.join(root, jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "metadata.json"), JSON.stringify({
    id: jobId,
    provider,
    state,
    threadUrl: provider === "chatgpt" ? "https://chatgpt.com/c/conv-1"
      : provider === "gemini" ? "https://gemini.google.com/app/conv-1"
        : "https://claude.ai/chat/conv-1",
    elapsedSeconds: 12,
    error: null,
    ...extra,
  }));
  if (response !== null) await writeFile(path.join(dir, "response.md"), response);
  return dir;
}

test("completed metadata is trusted only with exact identity and a stable non-empty response file", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-"));
  const root = path.join(runDir, "ask-bridge-output");
  try {
    await mkdir(root, { recursive: true });
    await writeJob(root, "job-1", "chatgpt", "completed", "Full answer");
    const result = await readBatchMetadata(root, "job-1", "chatgpt", { runDir });
    assert.equal(result.state, "completed");
    assert.equal(result.threadUrl, "https://chatgpt.com/c/conv-1");
    assert.equal(result.trustedCompletion, true);
    assert.equal(result.completionProof.source, "ask-bridge-batch-terminal");
    assert.match(result.completionProof.metadataSha256, /^[a-f0-9]{64}$/);
    assert.match(result.completionProof.responseSha256, /^[a-f0-9]{64}$/);
    const verified = await verifyStoredCompletion(root, {
      jobId: "job-1", completionProof: result.completionProof,
    }, "chatgpt", runDir);
    assert.equal(verified.verified, true);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("missing or mismatched job/provider identity is never trusted", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-identity-"));
  const root = path.join(runDir, "ask-bridge-output");
  try {
    await mkdir(root, { recursive: true });
    const dir = await writeJob(root, "job-2", "gemini", "completed", "Answer");
    const wrongProvider = await readBatchMetadata(root, "job-2", "chatgpt", { runDir });
    assert.equal(wrongProvider.state, "interrupted_unknown");
    assert.equal(wrongProvider.trustedCompletion, false);
    assert.equal(wrongProvider.responsePath, null);
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify({
      provider: "gemini", state: "completed",
    }));
    const missingIdentity = await readBatchMetadata(root, "job-2", "gemini", { runDir });
    assert.equal(missingIdentity.state, "interrupted_unknown");
    assert.equal(missingIdentity.trustedCompletion, false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("provisional in_progress metadata becomes interrupted_unknown, never completed", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-"));
  const root = path.join(runDir, "ask-bridge-output");
  try {
    await mkdir(root, { recursive: true });
    await writeJob(root, "job-3", "chatgpt", "in_progress", "PARTIAL ANSWER");
    const result = await readBatchMetadata(root, "job-3", "chatgpt", { runDir });
    assert.equal(result.state, "interrupted_unknown");
    assert.match(result.error, /do not resend/i);
    assert.equal(result.trustedCompletion, false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("timed-out partial artifacts are not exposed as completed result files", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-"));
  const root = path.join(runDir, "ask-bridge-output");
  try {
    await mkdir(root, { recursive: true });
    await writeJob(root, "job-4", "chatgpt", "timed_out", "possibly partial text");
    const result = await readBatchMetadata(root, "job-4", "chatgpt", { runDir });
    assert.equal(result.state, "timed_out");
    assert.equal(result.responsePath, null);
    assert.equal(result.trustedCompletion, false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("completed metadata with missing, empty, invalid or contradictory response is not trusted", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-invalid-"));
  const root = path.join(runDir, "ask-bridge-output");
  try {
    await mkdir(root, { recursive: true });
    await writeJob(root, "missing", "chatgpt", "completed");
    const missing = await readBatchMetadata(root, "missing", "chatgpt", { runDir });
    assert.equal(missing.trustedCompletion, false);
    await writeJob(root, "empty", "chatgpt", "completed", "  \n");
    const empty = await readBatchMetadata(root, "empty", "chatgpt", { runDir });
    assert.equal(empty.trustedCompletion, false);
    await writeJob(root, "error", "chatgpt", "completed", "Answer", { error: "contradictory failure" });
    const contradictory = await readBatchMetadata(root, "error", "chatgpt", { runDir });
    assert.equal(contradictory.trustedCompletion, false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});


test("artifacts outside the recorded task run directory are never trusted", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-owner-"));
  const wrongRunDir = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-other-"));
  const root = path.join(runDir, "ask-bridge-output");
  try {
    await mkdir(root, { recursive: true });
    await writeJob(root, "job-owned", "chatgpt", "completed", "Answer");
    const missingRunDir = await readBatchMetadata(root, "job-owned", "chatgpt");
    assert.equal(missingRunDir.trustedCompletion, false);
    const wrongOwner = await readBatchMetadata(root, "job-owned", "chatgpt", { runDir: wrongRunDir });
    assert.equal(wrongOwner.trustedCompletion, false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
    await rm(wrongRunDir, { recursive: true, force: true });
  }
});

test("symlinked response files are rejected when the platform permits symlink creation", async (t) => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-symlink-"));
  const root = path.join(runDir, "ask-bridge-output");
  try {
    await mkdir(root, { recursive: true });
    const dir = await writeJob(root, "job-link", "chatgpt", "completed");
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "not the provider artifact");
    try {
      await symlink(outside, path.join(dir, "response.md"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const result = await readBatchMetadata(root, "job-link", "chatgpt", { runDir });
    assert.equal(result.trustedCompletion, false);
    assert.equal(result.responsePath, null);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
