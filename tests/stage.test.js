import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { applyStagedFiles, parseFileBlocks, readTaskResult, stageTaskFiles } from "../src/stage.js";
import { readBatchMetadata } from "../src/metadata.js";

async function makeCompletedCodeTask() {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-stage-home-"));
  const workspaceRoot = path.join(home, "repo");
  const runDir = path.join(home, "runs", "task-1");
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  const resultPath = path.join(runDir, "response.md");
  await writeFile(path.join(workspaceRoot, "src", "main.js"), "old content\n");
  await writeFile(resultPath, "FILE: src/main.js\n```js\nnew content\n```\n");
  const store = new Store(home);
  await store.transaction(({ tasks }) => {
    tasks.tasks["task-1"] = {
      taskId: "task-1",
      kind: "code",
      mode: "full-file",
      workspace: "repo",
      workspaceRoot,
      runDir,
      children: {
        chatgpt: {
          provider: "chatgpt",
          state: "completed",
          resultPath,
          revision: 1,
        },
      },
    };
  });
  return { home, workspaceRoot, runDir, resultPath, store };
}

test("stage is non-destructive and apply requires explicit confirmation", async () => {
  const fixture = await makeCompletedCodeTask();
  try {
    const target = path.join(fixture.workspaceRoot, "src", "main.js");
    const originalMode = (await stat(target)).mode & 0o777;
    const staged = await stageTaskFiles("task-1", { provider: "chatgpt", home: fixture.home, store: fixture.store });
    assert.equal(staged.files.length, 1);
    assert.equal(await readFile(target, "utf8"), "old content\n");

    const preview = await applyStagedFiles("task-1", { provider: "chatgpt", home: fixture.home, store: fixture.store });
    assert.equal(preview.applied, false);
    assert.equal(await readFile(target, "utf8"), "old content\n");

    const applied = await applyStagedFiles("task-1", { provider: "chatgpt", confirm: true, home: fixture.home, store: fixture.store });
    assert.equal(applied.applied, true);
    assert.equal(await readFile(target, "utf8"), "new content\n");
    const task = (await fixture.store.snapshot()).tasks.tasks["task-1"];
    assert.equal(task.children.chatgpt.appliedFiles[0], "src/main.js");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("apply refuses a target changed after the preview", async () => {
  const fixture = await makeCompletedCodeTask();
  try {
    await stageTaskFiles("task-1", { provider: "chatgpt", home: fixture.home, store: fixture.store });
    const target = path.join(fixture.workspaceRoot, "src", "main.js");
    await writeFile(target, "manual edit\n");
    await assert.rejects(
      () => applyStagedFiles("task-1", { provider: "chatgpt", confirm: true, home: fixture.home, store: fixture.store }),
      { code: "TARGET_CHANGED" },
    );
    assert.equal(await readFile(target, "utf8"), "manual edit\n");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("spec tasks and path traversal are never staged", async () => {
  const fixture = await makeCompletedCodeTask();
  try {
    await writeFile(fixture.resultPath, "FILE: ../escape.js\n```js\nbad\n```\n");
    await assert.rejects(
      () => stageTaskFiles("task-1", { provider: "chatgpt", home: fixture.home, store: fixture.store }),
      { code: "UNSAFE_RESULT_PATH" },
    );
    await fixture.store.transaction(({ tasks }) => {
      tasks.tasks["task-1"].mode = "spec";
    });
    await assert.rejects(
      () => stageTaskFiles("task-1", { provider: "chatgpt", home: fixture.home, store: fixture.store }),
      { code: "NOT_APPLICABLE" },
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("result reader only returns task-owned result files", async () => {
  const fixture = await makeCompletedCodeTask();
  try {
    const result = await readTaskResult("task-1", { provider: "chatgpt", stdout: true, home: fixture.home, store: fixture.store });
    assert.match(result.body, /FILE: src\/main.js/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});


test("auto-collected ask-bridge results are hash-verified again before reading and staging", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-stage-proof-home-"));
  try {
    const workspaceRoot = path.join(home, "repo");
    const runDir = path.join(home, "runs", "task-proof");
    const outputDir = path.join(runDir, "ask-bridge-output");
    const jobId = "wfa-chatgpt-proof";
    const jobDir = path.join(outputDir, jobId);
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await mkdir(jobDir, { recursive: true });
    const resultPath = path.join(jobDir, "response.md");
    const body = "FILE: src/main.js\n```js\nverified\n```\n";
    await writeFile(resultPath, body);
    await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
      id: jobId, provider: "chatgpt", state: "completed",
      threadUrl: "https://chatgpt.com/c/proof", elapsedSeconds: 4, error: null,
    }));
    const artifact = await readBatchMetadata(outputDir, jobId, "chatgpt", { runDir });
    assert.equal(artifact.trustedCompletion, true);
    const store = new Store(home);
    await store.transaction(({ tasks }) => {
      tasks.tasks["task-proof"] = {
        taskId: "task-proof", kind: "code", mode: "full-file", workspace: "repo",
        workspaceRoot, runDir, outputDir, state: "completed",
        children: { chatgpt: {
          provider: "chatgpt", jobId, state: "completed", resultPath,
          completionProof: artifact.completionProof, collectionSource: "ask-bridge-batch-terminal",
        } },
      };
    });
    await writeFile(resultPath, body.replace("verified", "tampered"));
    await assert.rejects(
      () => readTaskResult("task-proof", { provider: "chatgpt", stdout: true, home, store }),
      { code: "RESULT_INTEGRITY_FAILED" },
    );
    await assert.rejects(
      () => stageTaskFiles("task-proof", { provider: "chatgpt", home, store }),
      { code: "RESULT_INTEGRITY_FAILED" },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
