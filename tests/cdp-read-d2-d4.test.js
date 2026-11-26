import assert from "node:assert/strict";
import test from "node:test";
import { readConversation } from "../src/engines/cdp-read.js";
import * as defaultDriver from "../src/browser/driver.js";

// D2 + D4 regression tests. All browser interaction is mocked at the driver
// layer (the established pattern in tests/cdp-read.test.js); no live browser
// is required. Time is virtual: deps.now / deps.sleep drive the clock, which
// also proves the reopen/settle polling uses the injectable timer and not a
// fixed sleep.

function makeCdp({ targets = [] } = {}) {
  const calls = [];
  const state = {
    targets: targets.map((target) => ({ ...target })),
    calls,
    closed: false,
    async send(method, params = {}) {
      calls.push({ method, params });
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

const FULL_5000 = "0123456789".repeat(500);
assert.equal(FULL_5000.length, 5000);

// --- D2 ---

test("D2: first read after reopening a tab waits for message nodes and returns completed with full text", async () => {
  const clock = virtualClock();
  const cdp = makeCdp(); // no matching tab: the read must reopen one
  let openCalls = 0;
  let readCalls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-d2",
    url: "https://chatgpt.com/c/d2-late-render",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        openTab: async () => {
          openCalls += 1;
          return { targetId: "reopened-tab", sessionId: "reopened-session" };
        },
        readTurnState: async () => {
          readCalls += 1;
          // The message list renders ~3 s after the tab opens (backlog repro:
          // first read at 3.1 s saw userTurns 0; a retry 5 s later saw the
          // full answer).
          if (clock.now() < 3000) {
            return {
              userTurns: 0, answerTurns: 0, answerText: "",
              answerActionsVisible: null, stopVisible: false,
            };
          }
          return {
            userTurns: 1, answerTurns: 1, answerText: FULL_5000,
            answerActionsVisible: true, stopVisible: false,
          };
        },
      },
    }),
  });

  assert.equal(openCalls, 1);
  assert.ok(readCalls > 1, "must sample more than once while the page renders");
  assert.equal(result.status, "completed");
  assert.equal(result.text, FULL_5000);
  assert.equal(result.partial, false);
  assert.equal(result.elapsedMs, 3500);
  // Polling with small intervals, never one fixed sleep: every sleep is at
  // most the 500 ms poll interval.
  assert.ok(clock.sleeps.length > 0);
  assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 500), `sleeps: ${clock.sleeps}`);
});

test("D2: a genuinely empty reopened conversation still returns unconfirmed after the bounded settle", async () => {
  const clock = virtualClock();
  const cdp = makeCdp();
  let openCalls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-d2-empty",
    url: "https://chatgpt.com/c/d2-empty",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        openTab: async () => {
          openCalls += 1;
          return { targetId: "reopened-empty", sessionId: "reopened-empty-session" };
        },
        readTurnState: async () => ({
          userTurns: 0, answerTurns: 0, answerText: "",
          answerActionsVisible: null, stopVisible: false,
        }),
      },
    }),
  });

  assert.equal(openCalls, 1);
  assert.equal(result.status, "unconfirmed");
  assert.equal(result.reason, "no_positive_completion_signal");
  assert.equal(result.text, "");
  assert.equal(result.partial, false);
  // Bounded: the ~10 s reopen settle, not an unbounded wait.
  assert.equal(result.elapsedMs, 10000);
  assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 500));
});

test("D2: an already-open tab with no messages returns immediately; the settle applies only to reopened tabs", async () => {
  const clock = virtualClock();
  const cdp = makeCdp({
    targets: [{ targetId: "existing-empty", type: "page", url: "https://chatgpt.com/c/d2-existing-empty" }],
  });
  const result = await readConversation({
    home: "/tmp/wfa-read-d2-existing",
    url: "https://chatgpt.com/c/d2-existing-empty",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "existing-empty", sessionId: "existing-session" }),
        readTurnState: async () => ({
          userTurns: 0, answerTurns: 0, answerText: "",
          answerActionsVisible: null, stopVisible: false,
        }),
      },
    }),
  });

  assert.equal(result.status, "unconfirmed");
  assert.equal(result.reason, "no_positive_completion_signal");
  assert.equal(result.elapsedMs, 0);
  assert.equal(clock.sleeps.length, 0);
});

test("D2: a reopened tab that needs login returns needs_user immediately without waiting for render", async () => {
  const clock = virtualClock();
  const cdp = makeCdp();
  const result = await readConversation({
    home: "/tmp/wfa-read-d2-login",
    url: "https://chatgpt.com/c/d2-login",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        openTab: async () => ({ targetId: "reopened-login", sessionId: "reopened-login-session" }),
        readTurnState: async () => ({
          userTurns: 0, answerTurns: 0, answerText: "",
          answerActionsVisible: null, stopVisible: false, loggedOut: true,
        }),
      },
    }),
  });

  assert.equal(result.status, "needs_user");
  assert.equal(result.reason, "login_required");
  assert.equal(result.elapsedMs, 0);
});

// --- D4 ---

test("D4: Gemini answer with pending>0 is streaming and partial even when the action bar is visible", async () => {
  const clock = virtualClock();
  const cdp = makeCdp({
    targets: [{ targetId: "gemini-pending", type: "page", url: "https://gemini.google.com/app/d4-pending" }],
  });
  const shortText = "First line of a long answer...";
  assert.ok(shortText.length <= 35);
  const result = await readConversation({
    home: "/tmp/wfa-read-d4-pending",
    url: "https://gemini.google.com/app/d4-pending",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "gemini-pending", sessionId: "gemini-pending-session" }),
        readTurnState: async () => ({
          userTurns: 1, answerTurns: 1, answerText: shortText,
          answerActionsVisible: true, pendingCount: 3, stopVisible: true,
        }),
      },
    }),
  });

  assert.notEqual(result.status, "completed");
  assert.equal(result.status, "streaming");
  assert.equal(result.reason, "streaming_pending");
  assert.equal(result.text, shortText);
  assert.equal(result.partial, true);
  assert.equal(result.evidence.pendingCount, 3);
});

test("D4: Gemini answer completes with full 5000-char text once pending clears", async () => {
  const clock = virtualClock();
  const cdp = makeCdp({
    targets: [{ targetId: "gemini-full", type: "page", url: "https://gemini.google.com/app/d4-full" }],
  });
  const result = await readConversation({
    home: "/tmp/wfa-read-d4-full",
    url: "https://gemini.google.com/app/d4-full",
    // wait>0: the read observes the stream until pending clears.
    wait: 5000,
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "gemini-full", sessionId: "gemini-full-session" }),
        readTurnState: async () => {
          if (clock.now() < 1000) {
            return {
              userTurns: 1, answerTurns: 1, answerText: "First line of a long answer...",
              answerActionsVisible: true, pendingCount: 5, stopVisible: true,
            };
          }
          return {
            userTurns: 1, answerTurns: 1, answerText: FULL_5000,
            answerActionsVisible: true, pendingCount: 0, stopVisible: false,
          };
        },
      },
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, FULL_5000);
  assert.equal(result.text.length, 5000);
  assert.equal(result.partial, false);
  assert.equal(result.evidence.pendingCount, 0);
});

test("D4: a completed candidate whose text is still growing is not returned until it stabilises", async () => {
  const clock = virtualClock();
  const cdp = makeCdp({
    targets: [{ targetId: "chatgpt-growing", type: "page", url: "https://chatgpt.com/c/d4-growing" }],
  });
  let calls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-d4-growing",
    url: "https://chatgpt.com/c/d4-growing",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "chatgpt-growing", sessionId: "growing-session" }),
        readTurnState: async () => {
          calls += 1;
          // First sample shows only the first line although the action bar
          // is already visible; the full body lands on the next sample.
          const answerText = calls === 1 ? "line one\n" : FULL_5000;
          return {
            userTurns: 1, answerTurns: 1, answerText,
            answerActionsVisible: true, stopVisible: false,
          };
        },
      },
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, FULL_5000);
  assert.equal(result.partial, false);
  assert.equal(result.elapsedMs, 1000);
});

test("D4: a completed candidate still changing at the settle bound returns streaming with partial:true, not completed", async () => {
  const clock = virtualClock();
  const cdp = makeCdp({
    targets: [{ targetId: "chatgpt-unsettled", type: "page", url: "https://chatgpt.com/c/d4-unsettled" }],
  });
  let calls = 0;
  const result = await readConversation({
    home: "/tmp/wfa-read-d4-unsettled",
    url: "https://chatgpt.com/c/d4-unsettled",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "chatgpt-unsettled", sessionId: "unsettled-session" }),
        readTurnState: async () => {
          calls += 1;
          return {
            userTurns: 1, answerTurns: 1, answerText: `chunk-${calls}`,
            answerActionsVisible: true, stopVisible: false,
          };
        },
      },
    }),
  });

  assert.notEqual(result.status, "completed");
  assert.equal(result.status, "streaming");
  assert.equal(result.reason, "completion_unsettled");
  assert.equal(result.partial, true);
  assert.equal(result.elapsedMs, 2000);
});

test("D4: short-answer behaviour unchanged for ChatGPT (pending/stop signals ignored, same text completes)", async () => {
  const clock = virtualClock();
  const cdp = makeCdp({
    targets: [{ targetId: "chatgpt-short", type: "page", url: "https://chatgpt.com/c/d4-short" }],
  });
  const answer = "Short answer.";
  const result = await readConversation({
    home: "/tmp/wfa-read-d4-short",
    url: "https://chatgpt.com/c/d4-short",
    deps: baseDeps(clock, {
      cdp,
      fns: {
        listPageTargets: defaultDriver.listPageTargets,
        attachTab: async () => ({ targetId: "chatgpt-short", sessionId: "short-session" }),
        // ChatGPT precedent (tests/d4-completion-signal.test.js "chatgpt
        // 行为零变化"): pendingCount and a visible stop button must not
        // block completion for a requiresCompletionActions provider.
        readTurnState: async () => ({
          userTurns: 1, answerTurns: 1, answerText: answer,
          answerActionsVisible: true, pendingCount: 12, stopVisible: true,
        }),
      },
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, answer);
  assert.equal(result.partial, false);
  assert.equal(result.elapsedMs, 500);
});
