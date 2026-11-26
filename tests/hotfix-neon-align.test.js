// Neon hotfix alignment (commit 5676132, "fix(d3,f1,d7)"): port of neon's
// tests/hotfix-d3-f1-sorry.test.js to the muse branch. D3 and D7 are the two
// items muse lacked; the F1 test guards the --gemini-mode parsing muse
// already had (VALUE_FLAGS in src/engines/cdp-cli.js:44 and
// src/broker/cli.js:25) against regression.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTurn } from "../src/broker/turns.js";
import { startBroker } from "../src/broker/server.js";
import { discoverBroker, createTurn as remoteCreateTurn, waitForTurn } from "../src/broker/client.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { waitForEditor } from "../src/browser/driver.js";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";

function createMockStream() {
  let buf = "";
  return {
    write(chunk) { buf += String(chunk); },
    get output() { return buf; },
  };
}

test("D3 hotfix (neon align): POST /turns preserves files through broker to runner and rejects relative paths", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-d3-files-"));
  let server;
  let receivedFiles = null;
  t.after(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  const absZip = path.resolve(home, "d3-probe.zip");
  assert.throws(() => createTurn({ provider: "gemini", prompt: "hi", files: ["relative/file.zip"] }));
  // Neon cap: at most 20 files per turn.
  assert.throws(() => createTurn({
    provider: "gemini",
    prompt: "hi",
    files: Array.from({ length: 21 }, (_, i) => path.resolve(home, `f${i}.zip`)),
  }));
  assert.deepEqual(createTurn({ provider: "gemini", prompt: "hi", files: [absZip] }).files, [absZip]);

  server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async (turn) => {
        receivedFiles = turn.files;
        return { status: "completed", text: "received" };
      },
      cancel() {},
    },
  });

  const record = await discoverBroker(home);
  const res = await remoteCreateTurn(record, {
    provider: "gemini",
    prompt: "read attachment",
    requestId: "req-d3-files-1",
    files: [absZip],
  });
  assert.equal(res.status, 202);
  const done = await waitForTurn({ record, turnId: res.json.id, home, timeoutMs: 5000 });
  assert.equal(done.state, "completed");
  assert.deepEqual(receivedFiles, [absZip]);

  // The request hash now includes files: replaying the same requestId with
  // the same attachments is an idempotent replay (200), with different
  // attachments it is a different request (409), not a silent replay.
  const replay = await remoteCreateTurn(record, {
    provider: "gemini",
    prompt: "read attachment",
    requestId: "req-d3-files-1",
    files: [absZip],
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, res.json.id);
  const otherZip = path.resolve(home, "d3-other.zip");
  const conflict = await remoteCreateTurn(record, {
    provider: "gemini",
    prompt: "read attachment",
    requestId: "req-d3-files-1",
    files: [otherZip],
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "REQUEST_ID_CONFLICT");
});

test("F1 hotfix (neon align): cdp-cli parses --gemini-mode task as value flag and forwards geminiMode to createTurn", async () => {
  let capturedBody = null;
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runCdpCommand(
    ["ask", "--provider", "gemini", "--gemini-mode", "task", "--prompt", "test task mode", "--json"],
    {
      home: "/tmp/wfa-f1-cli-parse",
      stdout,
      stderr,
      ensureBroker: async () => ({ host: "127.0.0.1", port: 12345, token: "tok" }),
      createTurn: async (_record, body) => {
        capturedBody = body;
        return { status: 202, json: { id: "turn-f1-1", state: "queued" } };
      },
      waitForTurn: async () => ({
        id: "turn-f1-1",
        provider: "gemini",
        state: "completed",
        text: "task ok",
        conversationUrl: "https://gemini.google.com/app/task1",
      }),
    },
  );

  assert.equal(res.code, 0, stderr.output);
  assert.equal(capturedBody?.geminiMode, "task");
});

test("D7 hotfix (neon align): waitForEditor fast-fails and parks Google /sorry interstitial to about:blank", async () => {
  const navigated = [];
  let virtualTime = 0;
  const cdp = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              found: false,
              title: "https://www.google.com/sorry/index",
              url: "https://www.google.com/sorry/index?continue=https://gemini.google.com/app",
              hasPassword: false,
              bodyLength: 120,
              emptyBody: false,
            },
          },
        };
      }
      if (method === "Page.navigate") {
        navigated.push(params.url);
        return {};
      }
      return {};
    },
  };

  await assert.rejects(
    () => waitForEditor(cdp, "s-sorry-1", geminiAdapter, {
      timeoutMs: 60000,
      pollIntervalMs: 100,
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
    }),
    (err) => err?.code === "HUMAN_VERIFICATION_REQUIRED" && err?.details?.parked === true,
  );
  assert.ok(virtualTime < 1000, `must fast-fail on /sorry instead of waiting timeoutMs, got ${virtualTime}ms`);
  assert.deepEqual(navigated, ["about:blank"]);
});
