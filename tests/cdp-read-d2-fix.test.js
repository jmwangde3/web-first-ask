import assert from "node:assert/strict";
import test from "node:test";
import { readConversation } from "../src/engines/cdp-read.js";
import * as defaultDriver from "../src/browser/driver.js";

// D2 fix regression tests (REPORT-7b9e1ceb, branch acceptance 2026-11-26):
// the first D2 fix covered only the openTab branch and settled on any
// message node, so both live paths still returned an empty `unconfirmed`
// on first read. These tests cover the two failing paths. Browser
// interaction is mocked at the driver layer and time is virtual
// (deps.now / deps.sleep), as in tests/cdp-read-d2-d4.test.js.

function makeCdp({ targets = [] } = {}) {
  const state = {
    targets: targets.map((target) => ({ ...target })),
    closed: false,
    async send(method, params = {}) {
      if (method === "Target.getTargets") return { targetInfos: state.targets.map((target) => ({ ...target })) };
      if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
      if (method === "Target.createTarget") {
        const targetId = `created-${state.targets.length + 1}`;
        state.targets.push({ targetId, type: "page", url: params.url || "about:blank" });
        return { targetId };
      }
      return {};
    },
    close() { state.closed = true; },
  };
  return state;
}

function virtualClock() {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
    sleeps,
  };
}

function baseDeps(clock, driver) {
  return {
    now: clock.now,
    sleep: clock.sleep,
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
    connectCdp: async () => driver.cdp,
    driver: driver.fns,
  };
}

// 976 chars, mirroring the acceptance evidence (first read 0 chars, second
// read 976 chars, all other evidence signals identical).
const ANSWER_976 = "x".repeat(976);

test("D2 fix path A: tab exists but unrendered (restored-session shell) settles via attachTab and returns completed", async () => {
  const clock = virtualClock();
  const cdp = makeCdp({
    targets: [{ targetId: "restored-shell", type: "page", url: "https://chatgpt.com/c/d2fix-restored" }],
  });
  let attachCalls = 0;
  let readCalls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-d2fix-restored",
    url: "https://chatgpt.com/c/d2fix-restored",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => {
          attachCalls += 1;
          return { targetId: "restored-shell", sessionId: "restored-session" };
        },
        readTurnState: async () => {
          readCalls += 1;
          // Restored shell: the tab is listed but the page has not loaded,
          // so the first samples see 0 turns; the message list renders
          // ~2 s after attach.
          if (clock.now() < 2000) {
            return {
              userTurns: 0, answerTurns: 0, answerText: "",
              answerActionsVisible: null, stopVisible: false,
            };
          }
          return {
            userTurns: 2, answerTurns: 2, answerText: ANSWER_976,
            answerActionsVisible: true, stopVisible: false,
          };
        },
      },
    }),
  });

  assert.equal(attachCalls, 1);
  assert.ok(readCalls > 1, "must keep sampling while the restored tab loads");
  assert.equal(result.status, "completed");
  assert.equal(result.text, ANSWER_976);
  assert.equal(result.text.length, 976);
  assert.equal(result.partial, false);
  // Text lands at 2000 ms; D4 confirmation needs one identical second
  // sample 500 ms later.
  assert.equal(result.elapsedMs, 2500);
  assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 500), `sleeps: ${clock.sleeps}`);
});

test("D2 fix path B: body text renders later than the action bar — settle must not end on message nodes alone", async () => {
  const clock = virtualClock();
  const cdp = makeCdp(); // no matching tab: the read reopens one (openTab)
  let openCalls = 0;
  let readCalls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-d2fix-late-text",
    url: "https://chatgpt.com/c/d2fix-late-text",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        openTab: async () => {
          openCalls += 1;
          return { targetId: "reopened-late-text", sessionId: "reopened-late-text-session" };
        },
        readTurnState: async () => {
          readCalls += 1;
          // Acceptance evidence: userTurns=2 / answerTurns=2 /
          // actionsVisible=true from the first sample, but answerText is
          // still empty; the 976-char body lands ~3 s after the tab opens.
          // The old settle condition (any message node) ended here.
          if (clock.now() < 3000) {
            return {
              userTurns: 2, answerTurns: 2, answerText: "",
              answerActionsVisible: true, stopVisible: false,
            };
          }
          return {
            userTurns: 2, answerTurns: 2, answerText: ANSWER_976,
            answerActionsVisible: true, stopVisible: false,
          };
        },
      },
    }),
  });

  assert.equal(openCalls, 1);
  assert.ok(readCalls > 6, `must keep polling past the action-bar-only samples, got ${readCalls} reads`);
  assert.equal(result.status, "completed");
  assert.equal(result.text, ANSWER_976);
  assert.equal(result.text.length, 976);
  assert.equal(result.partial, false);
  // Text lands at 3000 ms; D4 confirmation needs one identical second
  // sample 500 ms later. Under the old condition this returned
  // `unconfirmed` at elapsedMs 0.
  assert.equal(result.elapsedMs, 3500);
  assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 500), `sleeps: ${clock.sleeps}`);
});

test("D2 fix path A: a genuinely empty attached tab still returns unconfirmed after the bounded settle", async () => {
  const clock = virtualClock();
  const cdp = makeCdp({
    targets: [{ targetId: "attached-empty", type: "page", url: "https://chatgpt.com/c/d2fix-attached-empty" }],
  });
  const result = await readConversation({
    home: "/tmp/wfa-read-d2fix-attached-empty",
    url: "https://chatgpt.com/c/d2fix-attached-empty",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "attached-empty", sessionId: "attached-empty-session" }),
        readTurnState: async () => ({
          userTurns: 0, answerTurns: 0, answerText: "",
          answerActionsVisible: null, stopVisible: false,
        }),
      },
    }),
  });

  assert.equal(result.status, "unconfirmed");
  assert.equal(result.reason, "no_positive_completion_signal");
  assert.equal(result.text, "");
  assert.equal(result.partial, false);
  // Bounded: the ~10 s settle, not an unbounded wait.
  assert.equal(result.elapsedMs, 10000);
  assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 500));
});

test("D2 fix path B: turns and action bar present but body text never arrives still returns unconfirmed after the bounded settle", async () => {
  const clock = virtualClock();
  const cdp = makeCdp(); // openTab path
  const result = await readConversation({
    home: "/tmp/wfa-read-d2fix-no-text",
    url: "https://chatgpt.com/c/d2fix-no-text",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        openTab: async () => ({ targetId: "reopened-no-text", sessionId: "reopened-no-text-session" }),
        // Structure signals are all present; only the body text is missing.
        // The stricter settle must not promote this to settled/completed,
        // and must not wait past its bound either.
        readTurnState: async () => ({
          userTurns: 2, answerTurns: 2, answerText: "",
          answerActionsVisible: true, stopVisible: false,
        }),
      },
    }),
  });

  assert.equal(result.status, "unconfirmed");
  assert.equal(result.reason, "no_positive_completion_signal");
  assert.equal(result.text, "");
  assert.equal(result.partial, false);
  assert.equal(result.elapsedMs, 10000);
  assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 500));
});
