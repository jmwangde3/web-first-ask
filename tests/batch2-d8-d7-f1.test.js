import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import {
  attachTab,
  ensureProviderMode,
  waitForEditor,
  waitForCompletion,
} from "../src/browser/driver.js";
import { createTurn } from "../src/broker/turns.js";

// ---------------------------------------------------------------------------
// D8: attachTab enables focus emulation & falls back to Target.activateTarget if Page.enable stalls
// ---------------------------------------------------------------------------
test("D8: attachTab soft-enables Emulation.setFocusEmulationEnabled and activates frozen tab on Page.enable failure", async () => {
  const calls = [];
  let pageEnableAttempts = 0;
  const cdp = {
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.attachToTarget") {
        return { sessionId: "s-bg-1" };
      }
      if (method === "Page.enable") {
        pageEnableAttempts += 1;
        if (pageEnableAttempts === 1) {
          throw new Error("CDP_TIMEOUT: Page.enable timed out");
        }
        return {};
      }
      return {};
    },
  };

  const tab = await attachTab(cdp, "target-frozen-1");
  assert.deepEqual(tab, { targetId: "target-frozen-1", sessionId: "s-bg-1" });
  assert.equal(pageEnableAttempts, 2);
  assert.ok(calls.some((c) => c.method === "Target.activateTarget" && c.params?.targetId === "target-frozen-1"));
  assert.ok(calls.some((c) => c.method === "Emulation.setFocusEmulationEnabled" && c.params?.enabled === true));
});

test("D8: attachTab tolerates Emulation.setFocusEmulationEnabled failure (soft-fail)", async () => {
  const cdp = {
    async send(method) {
      if (method === "Target.attachToTarget") return { sessionId: "s-soft" };
      if (method === "Emulation.setFocusEmulationEnabled") throw new Error("unsupported");
      return {};
    },
  };
  const tab = await attachTab(cdp, "target-soft-1");
  assert.equal(tab.sessionId, "s-soft");
});

// ---------------------------------------------------------------------------
// D7: Cloudflare interstitial parks tab to about:blank before reporting human_verification_required
// ---------------------------------------------------------------------------
test("D7: waitForEditor parks challenged tab to about:blank on human_verification_required", async () => {
  const navigatedUrls = [];
  let virtualTime = 0;
  const cdp = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              found: false,
              title: "请稍候…",
              hasPassword: false,
              bodyLength: 0,
              emptyBody: true,
            },
          },
        };
      }
      if (method === "Page.navigate") {
        navigatedUrls.push(params.url);
        return {};
      }
      return {};
    },
  };

  await assert.rejects(
    () => waitForEditor(cdp, "s-cf-1", chatgptAdapter, {
      timeoutMs: 5000,
      pollIntervalMs: 100,
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
    }),
    (err) => err?.code === "HUMAN_VERIFICATION_REQUIRED" && err?.details?.parked === true,
  );
  assert.deepEqual(navigatedUrls, ["about:blank"]);
});

test("D7: waitForCompletion parks challenged tab to about:blank and reports parked=true", async () => {
  const navigatedUrls = [];
  const cdp = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              userTurns: 0,
              answerTurns: 0,
              answerText: "",
              answerActionsVisible: null,
              pendingCount: 0,
              stopVisible: false,
              editorEmpty: null,
              title: "Just a moment...",
              hasChallenge: true,
              hasProseMirror: false,
            },
          },
        };
      }
      if (method === "Page.navigate") {
        navigatedUrls.push(params.url);
        return {};
      }
      return {};
    },
  };

  const res = await waitForCompletion(cdp, "s-cf-2", chatgptAdapter, {
    baselineUserTurns: 0,
    baselineAnswerTurns: 0,
  });
  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "human_verification_required");
  assert.equal(res.evidence.parked, true);
  assert.deepEqual(navigatedUrls, ["about:blank"]);
});

// ---------------------------------------------------------------------------
// F1: Gemini Task mode toggle & active-state verification
// ---------------------------------------------------------------------------
test("F1: gemini buildEnsureModeJs clicks Task segmented button and verifies aria-pressed=true", () => {
  let pressed = "false";
  let placeholder = "Ask Gemini";
  let clicks = 0;
  const taskBtn = {
    innerText: "Task",
    textContent: "Task",
    getAttribute: (k) => (k === "aria-pressed" ? pressed : null),
    click: () => {
      clicks += 1;
      pressed = "true";
      placeholder = "Describe a task";
    },
  };
  const chatBtn = {
    innerText: "Chat",
    textContent: "Chat",
    getAttribute: () => "true",
    click: () => {},
  };
  const fakeDoc = {
    querySelectorAll: () => [chatBtn, taskBtn],
    querySelector: () => ({ getAttribute: (k) => (k === "data-placeholder" ? placeholder : null) }),
  };

  const res = vm.runInNewContext(geminiAdapter.buildEnsureModeJs("task"), { document: fakeDoc });
  assert.equal(clicks, 1);
  assert.equal(res.ok, true);
  assert.equal(res.active, true);
  assert.equal(res.switched, true);
  assert.equal(res.placeholder, "Describe a task");
});

test("F1: ensureProviderMode succeeds when Task mode activates and createTurn validates geminiMode", async () => {
  let polls = 0;
  let virtualTime = 0;
  const cdp = {
    async send(method) {
      if (method === "Runtime.evaluate") {
        polls += 1;
        return {
          result: {
            value: polls === 1
              ? { ok: false, active: false, switched: true, reason: "mode_switch_pending" }
              : { ok: true, active: true, switched: false, mode: "task", placeholder: "Describe a task" },
          },
        };
      }
      return {};
    },
  };

  const out = await ensureProviderMode(cdp, "s-f1", geminiAdapter, "task", {
    timeoutMs: 2000,
    pollIntervalMs: 100,
    now: () => virtualTime,
    sleep: async (ms) => { virtualTime += ms; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.active, true);
  assert.equal(polls, 2);

  const validTurn = createTurn({ provider: "gemini", prompt: "run test", geminiMode: "task" });
  assert.equal(validTurn.geminiMode, "task");
  assert.throws(() => createTurn({ provider: "gemini", prompt: "run test", geminiMode: "carbon" }));
});
