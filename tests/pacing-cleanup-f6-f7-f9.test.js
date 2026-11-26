import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computePaceDelay, pace, resolvePaceConfig } from "../src/browser/pacer.js";
import { resolveStaggerConfig, resetStaggerQueues, withSendSlot } from "../src/browser/stagger.js";
import { enforceCooldown, recordLastTurn, resolveMinIntervalMs } from "../src/browser/cooldown.js";
import {
  cleanupCreatedConversations,
  listCreatedConversations,
  loadSession,
  saveSession,
} from "../src/browser/conversation-store.js";

const CHATGPT_URL = "https://chatgpt.com/c/created-1";
const CHATGPT_URL_2 = "https://chatgpt.com/c/created-2";
const CHATGPT_PREEXISTING = "https://chatgpt.com/c/pre-existing-1";
const GEMINI_URL = "https://gemini.google.com/app/created-1";

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-pacing-cleanup-"));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// --- F6: pacer ---

test("F6 pacer: resolvePaceConfig defaults are 1-2s casual / 4-6s batch", () => {
  assert.deepEqual(resolvePaceConfig(), {
    enabled: true,
    casual: { min: 1000, max: 2000 },
    batch: { min: 4000, max: 6000 },
  });
  assert.deepEqual(resolvePaceConfig({ pace: { enabled: false } }).enabled, false);
});

test("F6 pacer: custom ranges honored, invalid bounds fall back, min>max swapped", () => {
  const custom = resolvePaceConfig({
    casualMinMs: 100, casualMaxMs: 200, batchMinMs: 300, batchMaxMs: 400,
  });
  assert.deepEqual(custom.casual, { min: 100, max: 200 });
  assert.deepEqual(custom.batch, { min: 300, max: 400 });

  const nested = resolvePaceConfig({ pace: { casual: { min: 50, max: 60 } } });
  assert.deepEqual(nested.casual, { min: 50, max: 60 });
  assert.deepEqual(nested.batch, { min: 4000, max: 6000 });

  const bad = resolvePaceConfig({ casualMinMs: "x", casualMaxMs: NaN, batchMinMs: -5, batchMaxMs: 100 });
  assert.deepEqual(bad.casual, { min: 1000, max: 2000 });
  assert.deepEqual(bad.batch, { min: 0, max: 100 });

  const swapped = resolvePaceConfig({ casualMinMs: 2000, casualMaxMs: 1000 });
  assert.deepEqual(swapped.casual, { min: 1000, max: 2000 });
});

test("F6 pacer: computePaceDelay stays inside configured ranges", () => {
  const ranges = { casual: { min: 100, max: 100 }, batch: { min: 500, max: 500 } };
  assert.equal(computePaceDelay("casual", () => 0.99, ranges), 100);
  assert.equal(computePaceDelay("batch", () => 0, ranges), 500);
  // No override: defaults unchanged.
  assert.equal(computePaceDelay("casual", () => 0), 1000);
  assert.equal(computePaceDelay("batch", () => 0.9999), 6000);
});

test("F6 pacer: pace() uses injected config/sleep; disabled or zero ranges never sleep", async () => {
  const slept = [];
  const d = await pace("casual", {
    config: { casualMinMs: 120, casualMaxMs: 120 },
    sleep: async (ms) => { slept.push(ms); },
    random: () => 0.5,
  });
  assert.equal(d, 120);
  assert.deepEqual(slept, [120]);

  const noSleep = [];
  const d2 = await pace("batch", {
    config: { enabled: false },
    sleep: async (ms) => { noSleep.push(ms); },
  });
  assert.equal(d2, 0);
  assert.deepEqual(noSleep, []);

  const zeroSleep = [];
  const d3 = await pace("casual", {
    config: { casualMinMs: 0, casualMaxMs: 0 },
    sleep: async (ms) => { zeroSleep.push(ms); },
  });
  assert.equal(d3, 0);
  assert.deepEqual(zeroSleep, []);
});

// --- F6: stagger ---

test("F6 stagger: resolveStaggerConfig defaults 3-5s, custom and invalid handled", () => {
  assert.deepEqual(resolveStaggerConfig(), { min: 3000, max: 5000 });
  assert.deepEqual(resolveStaggerConfig({ minMs: 100, maxMs: 200 }), { min: 100, max: 200 });
  assert.deepEqual(resolveStaggerConfig({ stagger: { min: 10, max: 20 } }), { min: 10, max: 20 });
  assert.deepEqual(resolveStaggerConfig({ minMs: "bad" }), { min: 3000, max: 5000 });
  assert.deepEqual(resolveStaggerConfig({ minMs: 500, maxMs: 100 }), { min: 100, max: 500 });
});

test("F6 stagger: withSendSlot honors injected minMs/maxMs instead of the 3-5s default", async () => {
  resetStaggerQueues();
  let now = 10000;
  const clock = {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    random: () => 0, // spacing = minMs
  };
  await withSendSlot("gemini", async () => {}, { ...clock, minMs: 100, maxMs: 100 });
  // Second new-conversation send must wait out the 100 ms spacing, not 3000+.
  const started = now;
  await withSendSlot("gemini", async () => {}, { ...clock, minMs: 100, maxMs: 100 });
  assert.equal(now - started, 100);
  resetStaggerQueues();
});

// --- F6: cooldown ---

test("F6 cooldown: resolveMinIntervalMs defaults per provider, config map/number honored", () => {
  assert.equal(resolveMinIntervalMs("chatgpt"), 5000);
  assert.equal(resolveMinIntervalMs("gemini"), 2000);
  assert.equal(resolveMinIntervalMs("chatgpt", { chatgpt: 100, gemini: 200 }), 100);
  assert.equal(resolveMinIntervalMs("gemini", { chatgpt: 100, gemini: 200 }), 200);
  assert.equal(resolveMinIntervalMs("chatgpt", 250), 250);
  assert.equal(resolveMinIntervalMs("chatgpt", { cooldown: { chatgpt: 75 } }), 75);
  assert.equal(resolveMinIntervalMs("chatgpt", { chatgpt: "bad" }), 5000);
  assert.equal(resolveMinIntervalMs("unknown-provider"), 2000);
});

test("F6 cooldown: enforceCooldown uses the configured interval with injected clock", async () => {
  await withHome(async (home) => {
    await recordLastTurn(home, "chatgpt", { finishedAt: 10000, countsForCooldown: true });
    const slept = [];
    const res = await enforceCooldown(home, "chatgpt", {
      config: { chatgpt: 5000 },
      now: () => 10100,
      sleep: async (ms) => { slept.push(ms); },
    });
    assert.equal(res.sleptMs, 4900);
    assert.deepEqual(slept, [4900]);

    // Zero interval from config disables the wait entirely.
    const res2 = await enforceCooldown(home, "chatgpt", {
      config: { chatgpt: 0 },
      now: () => 10100,
      sleep: async (ms) => { slept.push(ms); },
    });
    assert.equal(res2.sleptMs, 0);
    assert.deepEqual(slept, [4900]);
  });
});

// --- F7: created-by-this-run tracking ---

test("F7 store: saveSession records createdByRun/createdRunId; legacy records default to pre-existing", async () => {
  await withHome(async (home) => {
    const saved = await saveSession(home, "chatgpt", "run-created", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      createdByRun: true,
      createdRunId: "run-1",
    });
    assert.equal(saved.createdByRun, true);
    assert.equal(saved.createdRunId, "run-1");
    assert.equal((await loadSession(home, "chatgpt", "run-created")).createdByRun, true);

    // A reuse patch that omits the flags must not downgrade the provenance.
    const reused = await saveSession(home, "chatgpt", "run-created", { turnCount: 2 });
    assert.equal(reused.createdByRun, true);
    assert.equal(reused.createdRunId, "run-1");

    // No flags at all: pre-existing by default.
    const plain = await saveSession(home, "chatgpt", "pre-existing", {
      conversationUrl: CHATGPT_PREEXISTING,
      turnCount: 1,
    });
    assert.equal(plain.createdByRun, false);
    assert.equal(plain.createdRunId, null);

    await assert.rejects(
      () => saveSession(home, "chatgpt", "bad-flag", { conversationUrl: CHATGPT_URL, createdByRun: "yes" }),
      /INVALID_CONVERSATION_CREATED_BY_RUN/,
    );
  });
});

test("F7 store: listCreatedConversations excludes pre-existing sessions, includes retired created ones", async () => {
  await withHome(async (home) => {
    await saveSession(home, "chatgpt", "mixed", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      createdByRun: true,
      createdRunId: "run-1",
    });
    // URL replaced by a pre-existing conversation: the created URL retires
    // but stays a cleanup target; the current pre-existing URL is not one.
    await saveSession(home, "chatgpt", "mixed", {
      conversationUrl: CHATGPT_PREEXISTING,
      turnCount: 2,
    });
    const targets = await listCreatedConversations(home, "chatgpt", "mixed");
    assert.deepEqual(targets.map((t) => t.conversationUrl), [CHATGPT_URL]);
    assert.equal(targets[0].retired, true);

    // runId narrows to this run only.
    assert.deepEqual(await listCreatedConversations(home, "chatgpt", "mixed", { runId: "run-1" }), targets);
    assert.deepEqual(await listCreatedConversations(home, "chatgpt", "mixed", { runId: "other-run" }), []);

    // A wholly pre-existing session has no targets at all.
    await saveSession(home, "gemini", "old", { conversationUrl: GEMINI_URL, turnCount: 1 });
    assert.deepEqual(await listCreatedConversations(home, "gemini", "old"), []);
  });
});

test("F7 cleanup: deletes exactly the created set; a pre-existing conversation is never in the delete set", async () => {
  await withHome(async (home) => {
    await saveSession(home, "chatgpt", "run-a", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      createdByRun: true,
      createdRunId: "run-a",
    });
    await saveSession(home, "chatgpt", "run-a", {
      conversationUrl: CHATGPT_URL_2,
      turnCount: 2,
      createdByRun: true,
      createdRunId: "run-a",
    });
    // CHATGPT_URL is now retired-but-created; CHATGPT_URL_2 is current-created.
    await saveSession(home, "chatgpt", "other-key", {
      conversationUrl: CHATGPT_PREEXISTING,
      turnCount: 1,
    });

    const deleted = [];
    const result = await cleanupCreatedConversations(home, "chatgpt", "run-a", {
      deleteConversation: async ({ conversationUrl }) => {
        deleted.push(conversationUrl);
        return { success: true };
      },
    });
    assert.equal(result.status, "done");
    assert.deepEqual([...deleted].sort(), [CHATGPT_URL, CHATGPT_URL_2].sort());
    assert.ok(!deleted.includes(CHATGPT_PREEXISTING), "pre-existing conversation must never be deleted");
    assert.deepEqual([...result.deleted].sort(), [CHATGPT_URL, CHATGPT_URL_2].sort());
    assert.deepEqual(result.failed, []);

    // Idempotent: a second cleanup deletes nothing.
    const deleted2 = [];
    const again = await cleanupCreatedConversations(home, "chatgpt", "run-a", {
      deleteConversation: async ({ conversationUrl }) => { deleted2.push(conversationUrl); return { success: true }; },
    });
    assert.deepEqual(deleted2, []);
    assert.deepEqual(again.deleted, []);

    // The pre-existing session under its own key is untouched by any cleanup.
    const preResult = await cleanupCreatedConversations(home, "chatgpt", "other-key", {
      deleteConversation: async () => { throw new Error("must not be called for pre-existing"); },
    });
    assert.equal(preResult.status, "done");
    assert.deepEqual(preResult.deleted, []);
  });
});

test("F7 cleanup: without a delete hook nothing is deleted and wouldDelete names the missing hook", async () => {
  await withHome(async (home) => {
    await saveSession(home, "chatgpt", "no-hook", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      createdByRun: true,
      createdRunId: "run-9",
    });
    const result = await cleanupCreatedConversations(home, "chatgpt", "no-hook");
    assert.equal(result.status, "missing_delete_hook");
    assert.deepEqual(result.wouldDelete, [CHATGPT_URL]);
    assert.deepEqual(result.deleted, []);
    // Still recorded as created, so a later hooked cleanup can delete it.
    assert.deepEqual(
      (await listCreatedConversations(home, "chatgpt", "no-hook")).map((t) => t.conversationUrl),
      [CHATGPT_URL],
    );

    const dry = await cleanupCreatedConversations(home, "chatgpt", "no-hook", {
      dryRun: true,
      deleteConversation: async () => { throw new Error("dry run must not delete"); },
    });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.wouldDelete, [CHATGPT_URL]);
    assert.deepEqual(dry.deleted, []);
  });
});

test("F7 cleanup: a failed delete is reported as partial and the pre-existing set stays untouched", async () => {
  await withHome(async (home) => {
    await saveSession(home, "chatgpt", "partial", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
      createdByRun: true,
      createdRunId: "run-p",
    });
    const seen = [];
    const result = await cleanupCreatedConversations(home, "chatgpt", "partial", {
      runId: "run-p",
      deleteConversation: async ({ conversationUrl }) => {
        seen.push(conversationUrl);
        return { success: false, reason: "confirm_button_not_found" };
      },
    });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.failed, [{ conversationUrl: CHATGPT_URL, reason: "confirm_button_not_found" }]);
    assert.deepEqual(seen, [CHATGPT_URL]);
    // Failed targets stay listed for a later retry.
    assert.equal((await listCreatedConversations(home, "chatgpt", "partial")).length, 1);
  });
});
