import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readBatchMetadata } from "../src/metadata.js";

test("completed metadata is trusted only with a non-empty response file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-"));
  try {
    const dir = path.join(root, "job-1");
    await mkdir(dir);
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify({ state: "completed", threadUrl: "https://chatgpt.com/c/1" }));
    await writeFile(path.join(dir, "response.md"), "Full answer");
    const result = await readBatchMetadata(root, "job-1");
    assert.equal(result.state, "completed");
    assert.equal(result.threadUrl, "https://chatgpt.com/c/1");
    assert.ok(result.responsePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisional in_progress metadata becomes interrupted_unknown, never completed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-"));
  try {
    const dir = path.join(root, "job-2");
    await mkdir(dir);
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify({ state: "in_progress", threadUrl: "https://chatgpt.com/c/2" }));
    const result = await readBatchMetadata(root, "job-2");
    assert.equal(result.state, "interrupted_unknown");
    assert.match(result.error, /do not resend/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("timed-out partial artifacts are not exposed as completed result files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-meta-"));
  try {
    const dir = path.join(root, "job-3");
    await mkdir(dir);
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify({ state: "timed_out", threadUrl: "https://chatgpt.com/c/3" }));
    await writeFile(path.join(dir, "response.md"), "possibly partial text");
    const result = await readBatchMetadata(root, "job-3");
    assert.equal(result.state, "timed_out");
    assert.equal(result.responsePath, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
