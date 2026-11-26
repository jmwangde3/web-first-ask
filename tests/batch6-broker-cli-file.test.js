import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBrokerCommand } from "../src/broker/cli.js";

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

test("broker ask forwards repeatable --file, --gemini-mode, --conversation-id, --download-dir, and --cleanup to createTurn", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-broker-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f1 = path.join(dir, "d3-attachment.txt");
  const f2 = path.join(dir, "extra.txt");
  await writeFile(f1, "D3_TOKEN_OK");
  await writeFile(f2, "EXTRA");

  let captured = null;
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runBrokerCommand(
    [
      "ask", "--provider", "gemini",
      "--file", f1, "--file", f2,
      "--gemini-mode", "task",
      "--conversation-id", "conv-b1",
      "--download-dir", dir,
      "--cleanup",
      "--prompt", "read attached files",
      "--json",
    ],
    {
      home: dir,
      cwd: dir,
      stdout,
      stderr,
      ensureBroker: async () => ({ host: "127.0.0.1", port: 12345, token: "tok" }),
      createTurn: async (_rec, body) => {
        captured = body;
        return { status: 202, json: { id: "turn-b-file-1", state: "queued", files: body.files } };
      },
    },
  );

  assert.equal(res.code, 0, stderr.output);
  assert.deepEqual(captured.files, [f1, f2]);
  assert.equal(captured.geminiMode, "task");
  assert.equal(captured.conversationId, "conv-b1");
  assert.equal(captured.downloadDir, dir);
  assert.equal(captured.cleanupCreated, true);
});

test("broker ask fails closed (exit 2) when --file does not exist and never calls createTurn", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-broker-file-miss-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let createCalls = 0;
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runBrokerCommand(
    ["ask", "--provider", "gemini", "--file", path.join(dir, "missing.txt"), "--prompt", "hi"],
    {
      home: dir,
      cwd: dir,
      stdout,
      stderr,
      ensureBroker: async () => ({ host: "127.0.0.1", port: 12345, token: "tok" }),
      createTurn: async () => { createCalls += 1; return { status: 202, json: {} }; },
    },
  );

  assert.equal(res.code, 2);
  assert.equal(createCalls, 0);
  assert.match(stderr.output, /wfa:/);
});
