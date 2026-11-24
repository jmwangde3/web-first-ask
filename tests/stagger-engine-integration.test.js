import assert from "node:assert/strict";
import test from "node:test";
import { runCdpTurn } from "../src/engines/cdp-engine.js";
import { resetStaggerQueues } from "../src/browser/stagger.js";

const base = "https://chatgpt.com/";
const existing = `${base}c/existing-123`;

function harness() {
  let now = 10000;
  const sent = [];
  const intents = [];
  const deps = {
    adapters: { chatgpt: { id: "chatgpt", url: base } },
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
    connectCdp: async () => ({
      url: base,
      async send(method) {
        if (method === "Runtime.evaluate") return { result: { value: this.url } };
        return {};
      },
      close() {},
    }),
    driver: {
      async openTab(cdp, url) { cdp.url = url; return { targetId: "target", sessionId: "session" }; },
      async waitForEditor() {},
      async readTurnState() { return { userTurns: 1, answerTurns: 1, answerText: "old" }; },
      async typePrompt() { return { typedChars: 1, replacedChars: 0 }; },
      async submitTurn(cdp) { sent.push(now); if (cdp.url === base) cdp.url = `${base}c/new-123`; },
      async waitForCompletion() { return { status: "completed", text: "ok" }; },
    },
    conversationStore: {
      async loadSession(_home, _provider, id) {
        if (id === "continuation") return { conversationUrl: existing, turnCount: 1, invalidated: false };
        if (id === "retired") return { conversationUrl: existing, turnCount: 1, invalidated: true };
        return null;
      },
      async saveSession() {},
    },
    skipTurnLock: true,
    enforceCooldown: async (_home, _provider, options) => assert.equal(options.minIntervalMs, 0),
    recordLastTurn: async () => {},
    pace: async () => {},
    onSendIntent: async ({ prompt }) => { intents.push(prompt); },
    staggerNow: () => now,
    staggerSleep: async (ms) => { now += ms; },
    random: () => 0.5,
  };
  const run = (conversationId, overrides = {}) => runCdpTurn({
    provider: "chatgpt", prompt: conversationId || "anonymous", conversationId,
    minIntervalMs: 0, deps, ...overrides,
  });
  return { run, deps, sent, intents };
}

test.beforeEach(() => resetStaggerQueues());

test("engine: named first use, anonymous and invalidated replacement use stagger; restored session bypasses it even with minInterval=0", async () => {
  const { run, sent } = harness();
  for (const id of ["first-use", null, "continuation", "retired"]) {
    assert.equal((await run(id)).status, "completed");
  }
  assert.deepEqual(sent, [10000, 14000, 14000, 18000]);
});

test("engine: cancellation in stagger wait never records a new send intent or submits", async () => {
  const { run, deps, sent, intents } = harness();
  assert.equal((await run("first")).status, "completed");
  const controller = new AbortController();
  const result = await run("second", {
    signal: controller.signal,
    deps: { ...deps, staggerSleep: async () => controller.abort() },
  });
  assert.equal(result.reason, "cancelled");
  assert.equal(result.sendCommittedAt, undefined);
  assert.deepEqual(sent, [10000]);
  assert.deepEqual(intents, ["first"]);
});
