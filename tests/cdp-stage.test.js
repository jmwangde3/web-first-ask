import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stageCdpResponse } from "../src/engines/cdp-stage.js";
import { hashFile, sha256 } from "../src/util.js";
import { WfaError } from "../src/errors.js";

async function makeFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cdp-stage-home-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wfa-cdp-stage-ws-"));
  return { home, workspaceRoot };
}

test("stageCdpResponse: returns null when text has no FILE blocks", async () => {
  const { home, workspaceRoot } = await makeFixture();
  try {
    const res = await stageCdpResponse({
      home,
      runId: "run-plain-1",
      provider: "chatgpt",
      text: "Just an ordinary conversation answer without file blocks.",
      workspaceRoot,
    });
    assert.equal(res, null);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("stageCdpResponse: stages two full files and writes manifest with matched sha256", async () => {
  const { home, workspaceRoot } = await makeFixture();
  try {
    const text = `Here are the files:
FILE: src/a.js
\`\`\`js
console.log("a");
\`\`\`

FILE: src/b.js
\`\`\`js
console.log("b");
\`\`\`
`;
    const res = await stageCdpResponse({
      home,
      runId: "run-files-1",
      provider: "gemini",
      text,
      workspaceRoot,
    });
    assert.ok(res);
    assert.equal(res.files.length, 2);
    assert.equal(res.responseSha256, sha256(text));

    const fileA = path.join(res.stageRoot, "src", "a.js");
    const fileB = path.join(res.stageRoot, "src", "b.js");
    assert.equal(await readFile(fileA, "utf8"), 'console.log("a");\n');
    assert.equal(await readFile(fileB, "utf8"), 'console.log("b");\n');

    assert.equal(res.files[0].stagedSha256, await hashFile(fileA));
    assert.equal(res.files[1].stagedSha256, await hashFile(fileB));

    const manifestRaw = await readFile(res.manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw);
    assert.equal(manifest.runId, "run-files-1");
    assert.equal(manifest.provider, "gemini");
    assert.equal(manifest.files.length, 2);
    assert.equal(manifest.files[0].stagedSha256, res.files[0].stagedSha256);

    const savedResponse = await readFile(path.join(home, "runs", "run-files-1", "response.md"), "utf8");
    assert.equal(savedResponse, text);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("stageCdpResponse: rejects path traversal and absolute paths", async () => {
  const { home, workspaceRoot } = await makeFixture();
  try {
    const textTraversal = "FILE: ../evil.js\n```js\nconsole.log(1);\n```\n";
    await assert.rejects(
      () => stageCdpResponse({ home, runId: "run-trav-1", provider: "chatgpt", text: textTraversal, workspaceRoot }),
      (err) => err instanceof WfaError && err.code === "UNSAFE_RESULT_PATH"
    );

    const textAbsolute = "FILE: /etc/passwd\n```js\nconsole.log(1);\n```\n";
    await assert.rejects(
      () => stageCdpResponse({ home, runId: "run-trav-2", provider: "chatgpt", text: textAbsolute, workspaceRoot }),
      (err) => err instanceof WfaError && err.code === "UNSAFE_RESULT_PATH"
    );

    const textDrive = "FILE: C:/windows/win.ini\n```js\nconsole.log(1);\n```\n";
    await assert.rejects(
      () => stageCdpResponse({ home, runId: "run-trav-3", provider: "chatgpt", text: textDrive, workspaceRoot }),
      (err) => err instanceof WfaError && err.code === "UNSAFE_RESULT_PATH"
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("stageCdpResponse: rejects duplicate FILE blocks (case insensitive on windows)", async () => {
  const { home, workspaceRoot } = await makeFixture();
  try {
    const textDup = `FILE: src/same.js
\`\`\`js
console.log(1);
\`\`\`
FILE: src/SAME.js
\`\`\`js
console.log(2);
\`\`\`
`;
    await assert.rejects(
      () => stageCdpResponse({ home, runId: "run-dup-1", provider: "chatgpt", text: textDup, workspaceRoot }),
      (err) => err instanceof WfaError && err.code === "DUPLICATE_FILE_BLOCK"
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("stageCdpResponse: parses CRLF input without error and preserves response.md content", async () => {
  const { home, workspaceRoot } = await makeFixture();
  try {
    const textCrlf = "FILE: src/crlf.js\r\n```js\r\nline1\r\nline2\r\n```\r\n";
    const res = await stageCdpResponse({
      home,
      runId: "run-crlf-1",
      provider: "chatgpt",
      text: textCrlf,
      workspaceRoot,
    });
    assert.ok(res);
    assert.equal(res.files.length, 1);
    const saved = await readFile(path.join(home, "runs", "run-crlf-1", "response.md"), "utf8");
    assert.equal(saved, textCrlf);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
