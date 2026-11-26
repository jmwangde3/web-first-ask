import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { waitForCompletion, attachFiles } from "../src/browser/driver.js";
import { startBroker } from "../src/broker/server.js";
import { discoverBroker, createTurn as remoteCreateTurn } from "../src/broker/client.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("D5 hardening: stale pending fallback completes non-collapsed Gemini turn after stopVisible true->false", async () => {
  let virtualTime = 0;
  const fullAnswer = "Generated full answer with stale pending nodes";
  const cdp = {
    async send(method) {
      if (method === "Runtime.evaluate") {
        const generating = virtualTime < 10000;
        return {
          result: {
            value: {
              userTurns: 1,
              answerTurns: 1,
              answerText: generating ? "Generating..." : fullAnswer,
              answerActionsVisible: !generating,
              pendingCount: 24,
              collapsed: false,
              stopVisible: generating,
              editorEmpty: true,
              title: "Google Gemini",
            },
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(cdp, "s-d5-stale", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    stalePendingMs: 15000,
    settleMs: 4000,
    pollIntervalMs: 1000,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.reason, "completed_stale_pending_fallback");
  assert.equal(res.text, fullAnswer);
  assert.equal(res.evidence.stalePendingFallback, true);
});

test("F1 hardening: Task-mode submission confirms ACK via stopVisible/URL transition without send_unconfirmed", async () => {
  let virtualTime = 0;
  const cdp = {
    async send(method) {
      if (method === "Runtime.evaluate") {
        const done = virtualTime >= 6000;
        return {
          result: {
            value: {
              userTurns: 0,
              answerTurns: 1,
              answerText: done ? "Task sandbox passed" : "Running task...",
              answerActionsVisible: done ? true : null,
              pendingCount: 0,
              collapsed: false,
              stopVisible: !done,
              editorEmpty: false,
              url: "https://gemini.google.com/app/task-abc12345",
              title: "Google Gemini",
            },
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(cdp, "s-f1-ack", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    baselineUrl: "https://gemini.google.com/app",
    settleMs: 2000,
    pollIntervalMs: 1000,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.text, "Task sandbox passed");
});

test("Broker hardening: close() waits for in-flight persistTurnResult and clearCommit before resolving", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-close-flush-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  let resultPersisted = false;
  let commitCleared = false;
  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async () => ({ status: "completed", text: "fast" }),
      cancel() {},
    },
    deps: {
      resultStore: {
        readResults: async () => [],
        pruneResults: async () => {},
        recordResult: async () => {
          await delay(120);
          resultPersisted = true;
        },
      },
      journal: {
        hashPrompt: () => "sha",
        findCommitted: async () => null,
        listOrphans: async () => [],
        clearCommit: async () => {
          await delay(80);
          commitCleared = true;
        },
      },
    },
  });

  const record = await discoverBroker(home);
  const created = await remoteCreateTurn(record, { provider: "chatgpt", prompt: "flush test" });
  assert.equal(created.status, 202);
  await delay(30); // runner settled, persistTurnResult still in flight
  await server.close();
  assert.equal(resultPersisted, true, "close() must wait for recordResult");
  assert.equal(commitCleared, true, "close() must wait for clearCommit");
});

test("D3 hardening: ATTACH_UPLOAD_FAILED carries full structured upload diagnostics", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-d3-diag-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sampleFile = path.join(dir, "bundle.zip");
  await writeFile(sampleFile, "zip-bytes");

  let virtualTime = 0;
  const cdp = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        if (String(params?.expression || "").includes("upload_trigger_not_found")) {
          return { result: { value: { success: true } } };
        }
        return {
          result: {
            value: {
              present: false,
              matched: [false],
              chipCount: 0,
              chipTexts: [],
              sendReady: true,
              inputFiles: ["bundle.zip"],
            },
          },
        };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      return {};
    },
  };

  await assert.rejects(
    () => attachFiles(cdp, "s-d3-diag", geminiAdapter, [sampleFile], {
      attachmentVerifyTimeoutMs: 300,
      attachmentVerifyIntervalMs: 100,
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
    }),
    (err) => err?.code === "ATTACH_UPLOAD_FAILED" &&
      err?.details?.verifyPolls >= 2 &&
      err?.details?.sendReady === true &&
      Array.isArray(err?.details?.chipTexts) &&
      err?.details?.expectedFiles?.[0] === "bundle.zip",
  );
});
