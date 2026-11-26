import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import {
  waitForComposerReady,
  configureDownloadBehavior,
  snapshotDownloadDir,
  collectDownloads,
} from "../src/browser/driver.js";
import { validateAnswerIntegrity, extractFileBlocksToDir } from "../src/engines/cdp-stage.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { createTurn } from "../src/broker/turns.js";

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

// D6: 0x0 stop button does not block composer; visible stop button blocks with stopDiagnostics
test("D6: waitForComposerReady preserves stop-gate semantics and captures stopDiagnostics on composer_stop_state", async () => {
  let virtualTime = 0;
  const cdpInvisibleStop = {
    async send(method) {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              ready: true,
              editorFound: true,
              editorEditable: true,
              editorVisible: true,
              editorChars: 0,
              stopActive: false,
              stopMatched: false,
              stopDiagnostics: [{ tag: "button", visible: false, width: 0, height: 0, active: false }],
            },
          },
        };
      }
      return {};
    },
  };
  const ok = await waitForComposerReady(cdpInvisibleStop, "s-d6-ok", chatgptAdapter, {
    timeoutMs: 1000,
    pollIntervalMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });
  assert.equal(ok.ok, true);

  let t2 = 0;
  const cdpVisibleStop = {
    async send(method) {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              ready: false,
              editorFound: true,
              editorEditable: true,
              editorVisible: true,
              editorChars: 0,
              stopActive: true,
              stopMatched: true,
              stopDiagnostics: [{ tag: "button", ariaLabel: "Stop", visible: true, width: 32, height: 32, active: true }],
            },
          },
        };
      }
      return {};
    },
  };
  const blocked = await waitForComposerReady(cdpVisibleStop, "s-d6-block", chatgptAdapter, {
    timeoutMs: 300,
    pollIntervalMs: 100,
    now: () => t2,
    sleep: async (ms) => { t2 += ms; },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "composer_stop_state");
  assert.equal(blocked.stopDiagnostics[0].width, 32);
});

// F3: validateAnswerIntegrity rejects unclosed fences / bad diff hunks; extractFileBlocksToDir writes verified files
test("F3: validateAnswerIntegrity rejects truncated fence and bad diff hunk; extractFileBlocksToDir writes clean files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-f3-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(
    () => validateAnswerIntegrity("FILE: a.js\n```js\nconst x = 1;\n"),
    (err) => err?.code === "INCOMPLETE_CODE_FENCE",
  );

  const badDiff = "FILE: fix.patch\n```diff\n--- a/x.js\n+++ b/x.js\n@@ -1,3 +1,3 @@\n-old\n+new\n```\n";
  assert.throws(
    () => validateAnswerIntegrity(badDiff),
    (err) => err?.code === "INVALID_HUNK_LINE_COUNT",
  );

  const goodMd = "FILE: src/hello.js\n```js\nexport const hello = 1;\n```\n";
  const res = await extractFileBlocksToDir({ markdown: goodMd, outputDir: dir });
  assert.equal(res.ok, true);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].filePath, "src/hello.js");
  assert.equal(await readFile(path.join(dir, "src/hello.js"), "utf8"), "export const hello = 1;\n");
});

// F4: CDP download behavior + SHA-256 verified collectDownloads + createTurn downloadDir
test("F4: configureDownloadBehavior and collectDownloads capture completed files with sha256 and ignore .crdownload", async (t) => {
  const dlDir = await mkdtemp(path.join(os.tmpdir(), "wfa-f4-dl-"));
  t.after(() => rm(dlDir, { recursive: true, force: true }));

  const sent = [];
  const cdp = {
    async send(method, params) {
      sent.push({ method, params });
      return {};
    },
  };
  const cfg = await configureDownloadBehavior(cdp, dlDir);
  assert.equal(cfg.configured, true);
  assert.equal(cfg.method, "Browser.setDownloadBehavior");

  await writeFile(path.join(dlDir, "preexisting.txt"), "old");
  const before = await snapshotDownloadDir(dlDir);
  await writeFile(path.join(dlDir, "partial.crdownload"), "wip");
  await writeFile(path.join(dlDir, "report.txt"), "hello download");

  const files = await collectDownloads({ downloadDir: dlDir, beforeFiles: before });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "report.txt");
  assert.equal(files[0].bytes, 14);
  assert.equal(files[0].sha256.length, 64);

  assert.equal(createTurn({ provider: "chatgpt", prompt: "hi", downloadDir: dlDir }).downloadDir, dlDir);
  assert.throws(() => createTurn({ provider: "chatgpt", prompt: "hi", downloadDir: "relative/dir" }));
});

// F2: --providers runs concurrently, writes per-provider artifacts, emits single-provider retryCommand on failure
test("F2: cdp ask --providers runs chatgpt and gemini concurrently, saves artifacts, and returns retryCommand on failure", async (t) => {
  const artDir = await mkdtemp(path.join(os.tmpdir(), "wfa-f2-art-"));
  t.after(() => rm(artDir, { recursive: true, force: true }));

  const stdout = createMockStream();
  const stderr = createMockStream();
  const seenProviders = [];

  const res = await runCdpCommand(
    ["ask", "--providers", "chatgpt,gemini", "--prompt", "compare this", "--artifact-dir", artDir, "--json"],
    {
      home: artDir,
      stdout,
      stderr,
      ensureBroker: async () => ({ host: "127.0.0.1", port: 12345, token: "tok" }),
      createTurn: async (_rec, body) => {
        seenProviders.push(body.provider);
        return { status: 202, json: { id: `turn-${body.provider}`, state: "queued" } };
      },
      waitForTurn: async ({ turnId }) => {
        if (turnId === "turn-chatgpt") {
          return { id: turnId, provider: "chatgpt", state: "completed", text: "ChatGPT answer" };
        }
        return { id: turnId, provider: "gemini", state: "failed", reason: "provider_error", text: "" };
      },
    },
  );

  assert.equal(res.code, 1);
  assert.deepEqual(seenProviders.sort(), ["chatgpt", "gemini"]);
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.providers.chatgpt.ok, true);
  assert.equal(await readFile(path.join(artDir, "chatgpt.md"), "utf8"), "ChatGPT answer");
  assert.equal(parsed.providers.gemini.ok, false);
  assert.match(parsed.providers.gemini.retryCommand, /wfa cdp ask --provider gemini/);
});
