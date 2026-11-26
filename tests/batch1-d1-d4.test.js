import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { waitForCompletion } from "../src/browser/driver.js";
import { startBroker } from "../src/broker/server.js";
import { discoverBroker, createTurn as remoteCreateTurn, getTurn } from "../src/broker/client.js";
import { readConversation } from "../src/engines/cdp-read.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// D4: Gemini collapsed wrapper uses textContent + does not stall on frozen pending
// ---------------------------------------------------------------------------
test("D4: gemini buildReadStateJs uses textContent when collapsible-content-wrapper truncates innerText", () => {
  const fullBody = "Title line\n" + "Full generated content ".repeat(300) + "\nfunction done() { return 42; }";
  const codeBlockEl = {
    innerText: "",
    textContent: "function done() { return 42; }",
    parentElement: null,
  };
  const bodyEl = {
    innerText: "Title line",
    textContent: fullBody,
    querySelector: (sel) => (sel.includes("collapsible-content-wrapper") ? {} : null),
    querySelectorAll: (sel) => (sel.includes("pre") ? [codeBlockEl] : []),
  };
  const lastResponse = {
    querySelector: (sel) => {
      if (sel.includes("message-content")) return bodyEl;
      if (sel.includes("collapsible-content-wrapper")) return {};
      if (sel === "message-actions") return null;
      return null;
    },
    querySelectorAll: (sel) => (sel.includes("pending") ? Array.from({ length: 731 }, () => ({})) : []),
  };
  const fakeDoc = {
    title: "Google Gemini",
    querySelectorAll: (sel) => {
      if (sel === "user-query") return [{}];
      if (sel === "model-response") return [lastResponse];
      return [];
    },
    querySelector: () => null,
  };
  const rawState = vm.runInNewContext(geminiAdapter.buildReadStateJs(), { document: fakeDoc });
  const state = typeof rawState === "string" ? JSON.parse(rawState) : rawState;
  assert.equal(state.collapsed, true);
  assert.equal(state.pendingCount, 731);
  assert.ok(state.answerText.length > 5000, `expected >5000 chars, got ${state.answerText.length}`);
  assert.ok(state.answerText.includes("```\nfunction done() { return 42; }\n```") || state.answerText.includes("function done() { return 42; }"));
  assert.equal(state.answerActionsVisible, null);
});

test("D4: waitForCompletion completes collapsed Gemini turn once stopVisible=false and textContent settles", async () => {
  let virtualTime = 0;
  const fullAnswer = "Title\n" + "Detailed Gemini response ".repeat(250);
  const mockCdp = {
    async send(method) {
      if (method === "Runtime.evaluate") {
        const done = virtualTime >= 30000;
        return {
          result: {
            value: {
              userTurns: 1,
              answerTurns: 1,
              answerText: done ? fullAnswer : "Title\nStreaming...",
              answerActionsVisible: null,
              pendingCount: 731,
              collapsed: true,
              stopVisible: !done,
              editorEmpty: true,
              title: "Google Gemini",
            },
          },
        };
      }
      return {};
    },
  };

  const res = await waitForCompletion(mockCdp, "s-d4", geminiAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
    pollIntervalMs: 1000,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.text, fullAnswer);
  assert.ok(res.elapsedMs < 60000, `must complete promptly without 420s stall, got ${res.elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// D3: Gemini attachment chip verification rejects 0-height empty wrapper & checks filename
// ---------------------------------------------------------------------------
test("D3: gemini buildAttachmentVerifyJs rejects 0-height empty wrapper and matches real gem-attachment filename", () => {
  const expr = geminiAdapter.buildAttachmentVerifyJs(["/tmp/d3-probe.zip"]);

  // Case 1: only 0-height empty wrapper (or upload button) exists -> present must be false
  const emptyDoc = {
    querySelectorAll: (sel) => {
      if (sel.includes("file-preview-chip")) {
        return [{
          childElementCount: 0,
          innerText: "",
          textContent: "",
          getBoundingClientRect: () => ({ width: 0, height: 0 }),
          querySelector: () => null,
        }];
      }
      return [{
        disabled: false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 32, height: 32 }),
      }];
    },
    querySelector: () => null,
  };
  const emptyRes = vm.runInNewContext(expr, { document: emptyDoc });
  assert.equal(emptyRes.present, false);
  assert.deepEqual([...emptyRes.matched], [false]);
  assert.equal(emptyRes.chipCount, 0);

  // Case 2: visible chip with wrong filename -> present must be false
  const wrongChip = {
    childElementCount: 1,
    innerText: "TXT\nother",
    textContent: "TXT\nother",
    getBoundingClientRect: () => ({ width: 160, height: 48 }),
    querySelector: (s) => {
      if (s.includes("gem-attachment-text")) return { innerText: "other", textContent: "other" };
      if (s.includes("gem-attachment-extension-label")) return { innerText: "TXT", textContent: "TXT" };
      return null;
    },
  };
  const wrongDoc = {
    querySelectorAll: (sel) => (sel.includes("file-preview-chip") ? [wrongChip] : [{
      disabled: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 32, height: 32 }),
    }]),
    querySelector: () => null,
  };
  const wrongRes = vm.runInNewContext(expr, { document: wrongDoc });
  assert.equal(wrongRes.present, false);
  assert.deepEqual([...wrongRes.matched], [false]);

  // Case 3: visible chip with matching gem-attachment-text + gem-attachment-extension-label -> present=true
  const goodChip = {
    childElementCount: 1,
    innerText: "ZIP\nd3-probe",
    textContent: "ZIP\nd3-probe",
    getBoundingClientRect: () => ({ width: 180, height: 56 }),
    querySelector: (s) => {
      if (s.includes("gem-attachment-text")) return { innerText: "d3-probe", textContent: "d3-probe" };
      if (s.includes("gem-attachment-extension-label")) return { innerText: "ZIP", textContent: "ZIP" };
      return null;
    },
  };
  const goodDoc = {
    querySelectorAll: (sel) => (sel.includes("file-preview-chip") ? [goodChip] : [{
      disabled: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 32, height: 32 }),
    }]),
    querySelector: () => null,
  };
  const goodRes = vm.runInNewContext(expr, { document: goodDoc });
  assert.equal(goodRes.present, true);
  assert.deepEqual([...goodRes.matched], [true]);
  assert.equal(goodRes.chipCount, 1);
  assert.deepEqual([...goodRes.chipTexts], ["d3-probe.zip"]);
});

// ---------------------------------------------------------------------------
// D1: broker must not idle out while a --no-wait turn is still running
// ---------------------------------------------------------------------------
test("D1: broker in off mode does not idle-exit while a non-terminal turn is running past idleTimeoutMs", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-d1-test-"));
  let server;
  let releaseTurn;
  const turnGate = new Promise((resolve) => { releaseTurn = resolve; });
  t.after(async () => {
    releaseTurn?.();
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  server = await startBroker({
    home,
    mode: "off",
    idleTimeoutMs: 150,
    runner: {
      run: async () => {
        await turnGate;
        return { status: "completed", text: "finished after idle window" };
      },
      cancel() {},
    },
  });

  const record = await discoverBroker(home);
  const created = await remoteCreateTurn(record, {
    provider: "chatgpt",
    prompt: "slow no-wait prompt",
  });
  assert.equal(created.status, 202);
  const turnId = created.json.id;

  // Wait well beyond idleTimeoutMs while turn is still running
  await delay(350);
  const stillAlive = await discoverBroker(home);
  assert.ok(stillAlive, "broker must remain alive while turn is running");
  const mid = await getTurn(stillAlive, turnId);
  assert.equal(mid.status, 200);
  assert.equal(mid.json.state, "running");

  // Complete turn and verify it reaches completed
  releaseTurn();
  await delay(40);
  const after = await getTurn(stillAlive, turnId);
  assert.equal(after.json.state, "completed");
  assert.equal(after.json.text, "finished after idle window");

  // Once terminal, broker should idle out cleanly
  await delay(350);
  assert.equal(await discoverBroker(home), null);
});

// ---------------------------------------------------------------------------
// D2: first read after reopening a tab hydrates instead of returning unconfirmed
// ---------------------------------------------------------------------------
test("D2: readConversation hydrates after reopen and returns completed on first read; empty stays unconfirmed", async () => {
  let virtualTime = 0;
  let readCalls = 0;
  const cdp = {
    async send() { return {}; },
    close() {},
  };

  const res = await readConversation({
    home: "/tmp/wfa-d2-hydrate",
    provider: "chatgpt",
    url: "https://chatgpt.com/c/d2-hydrated-conv",
    wait: 0,
    reopenHydrateTimeoutMs: 5000,
    deps: {
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: async () => [],
        openTab: async () => ({ targetId: "t-reopen-1", sessionId: "s-reopen-1" }),
        readTurnState: async () => {
          readCalls += 1;
          if (readCalls <= 2) {
            return { userTurns: 0, answerTurns: 0, answerText: "", answerActionsVisible: null, stopVisible: false };
          }
          return { userTurns: 1, answerTurns: 1, answerText: "Hydrated full answer", answerActionsVisible: true, stopVisible: false };
        },
      },
    },
  });

  assert.equal(res.status, "completed");
  assert.equal(res.text, "Hydrated full answer");
  assert.ok(readCalls >= 3);

  // Genuinely empty conversation still returns unconfirmed after bounded hydrate timeout
  let emptyTime = 0;
  const emptyRes = await readConversation({
    home: "/tmp/wfa-d2-empty",
    provider: "chatgpt",
    url: "https://chatgpt.com/c/d2-empty-conv",
    wait: 0,
    reopenHydrateTimeoutMs: 1500,
    deps: {
      now: () => emptyTime,
      sleep: async (ms) => { emptyTime += ms; },
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: async () => [],
        openTab: async () => ({ targetId: "t-reopen-empty", sessionId: "s-reopen-empty" }),
        readTurnState: async () => ({
          userTurns: 0,
          answerTurns: 0,
          answerText: "",
          answerActionsVisible: null,
          stopVisible: false,
        }),
      },
    },
  });

  assert.equal(emptyRes.status, "unconfirmed");
  assert.equal(emptyTime, 1500);
});
