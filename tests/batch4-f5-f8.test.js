import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as claudeAdapter from "../src/browser/adapters/claude.js";
import { createTurn } from "../src/broker/turns.js";
import { isValidConversationUrl } from "../src/browser/conversation-store.js";
import { createPacer, resolvePaceRange } from "../src/browser/pacer.js";
import { runWithRepoFallback, isRepoUnreadableResponse } from "../src/engines/cdp-cli.js";

// F5: Claude adapter contract, login probe, read state, provider allowlist
test("F5: claude adapter supports login probe, read state, conversation URL validation, and createTurn", () => {
  assert.equal(claudeAdapter.id, "claude");
  assert.equal(claudeAdapter.url, "https://claude.ai/new");
  assert.equal(isValidConversationUrl("claude", "https://claude.ai/chat/12345678-abcd"), true);
  assert.equal(isValidConversationUrl("claude", "https://claude.ai/new"), false);

  const turn = createTurn({ provider: "claude", prompt: "hello claude" });
  assert.equal(turn.provider, "claude");

  const loginRes = vm.runInNewContext(claudeAdapter.buildLoginProbeJs(), {
    location: { hostname: "claude.ai", origin: "https://claude.ai" },
    document: {
      title: "Claude",
      querySelector: (sel) => (sel.includes("ProseMirror") ? {} : null),
    },
  });
  assert.equal(loginRes.loggedIn, true);
  assert.equal(loginRes.offOrigin, false);

  const rawState = vm.runInNewContext(claudeAdapter.buildReadStateJs(), {
    document: {
      title: "Claude",
      querySelectorAll: (sel) => {
        if (sel.includes("user-message")) return [{}];
        if (sel.includes("data-is-streaming")) {
          return [{
            innerText: "Claude reply",
            textContent: "Claude reply",
            getAttribute: (k) => (k === "data-is-streaming" ? "false" : null),
            querySelectorAll: () => [],
          }];
        }
        return [];
      },
      querySelector: (sel) => (sel.includes("ProseMirror") ? { innerText: "" } : null),
    },
  });
  const parsed = JSON.parse(rawState);
  assert.equal(parsed.userTurns, 1);
  assert.equal(parsed.answerTurns, 1);
  assert.equal(parsed.answerText, "Claude reply");
  assert.equal(parsed.answerActionsVisible, true);
  assert.equal(parsed.stopVisible, false);
});

// F6: Configurable human-like pacing (casual 1-2s, batch 4-6s)
test("F6: createPacer applies configurable randomized delays for casual and batch modes", async () => {
  const slept = [];
  const pacer = createPacer({
    enabled: true,
    casual: { min: 1000, max: 2000 },
    batch: { min: 4000, max: 6000 },
    random: () => 0.5,
    sleep: async (ms) => { slept.push(ms); },
  });

  const d1 = await pacer("casual");
  const d2 = await pacer("batch");
  const d3 = await pacer("casual", { enabled: false });
  assert.ok(d1 >= 1000 && d1 <= 2000);
  assert.ok(d2 >= 4000 && d2 <= 6000);
  assert.equal(d3, 0);
  assert.deepEqual(slept, [d1, d2]);
  assert.deepEqual(resolvePaceRange("casual"), { min: 1000, max: 2000 });
  assert.deepEqual(resolvePaceRange("batch"), { min: 4000, max: 6000 });
});

// F7: createTurn preserves cleanupCreated flag
test("F7: createTurn tracks cleanupCreated flag cleanly without affecting default false", () => {
  assert.equal(createTurn({ provider: "chatgpt", prompt: "hi" }).cleanupCreated, false);
  assert.equal(createTurn({ provider: "chatgpt", prompt: "hi", cleanupCreated: true }).cleanupCreated, true);
});

// F8: REPO_UNREADABLE triggers bundle fallback ONLY on terminal completed answer, never on uncertain/stalled
test("F8: runWithRepoFallback bundles repo on terminal REPO_UNREADABLE and refuses non-completed states", async () => {
  assert.equal(isRepoUnreadableResponse("REPO_UNREADABLE: cannot access private repo"), true);
  assert.equal(isRepoUnreadableResponse("Looks good!"), false);

  let fallbackCalls = 0;
  const skipped = await runWithRepoFallback({
    initialResult: { status: "stalled", text: "REPO_UNREADABLE" },
    createArchiveFn: async () => ({ archivePath: "/tmp/should-not-run.zip" }),
    submitFallbackFn: async () => { fallbackCalls += 1; return {}; },
  });
  assert.equal(skipped.triggered, false);
  assert.equal(fallbackCalls, 0);

  const recovered = await runWithRepoFallback({
    initialResult: { status: "completed", text: "REPO_UNREADABLE" },
    workspaceRoot: "/tmp/repo",
    createArchiveFn: async () => ({ archivePath: "/tmp/bundle.zip" }),
    submitFallbackFn: async ({ archivePath }) => {
      fallbackCalls += 1;
      return { status: "completed", text: `read from ${archivePath}` };
    },
  });
  assert.equal(recovered.triggered, true);
  assert.equal(recovered.archivePath, "/tmp/bundle.zip");
  assert.equal(recovered.result.text, "read from /tmp/bundle.zip");
  assert.equal(fallbackCalls, 1);
});
