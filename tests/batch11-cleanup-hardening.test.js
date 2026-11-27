import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendDebugIssue, getDebugLogPath } from "../src/debug-log.js";
import { recordResult, readResult } from "../src/broker/result-store.js";
import { recordTurn, readTurn } from "../src/broker/turn-store.js";
import {
  runCdpCommand,
  classifyCleanupCandidate,
  collectCleanupCandidates,
  parseDeleteEvalResult,
  waitForNavigationReady,
} from "../src/engines/cdp-cli.js";

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

test("3.1: result-store & turn-store persist createdByWfa and classifyCleanupCandidate rejects unknown by default", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-b11-origin-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  await recordResult(home, {
    id: "turn-true",
    provider: "gemini",
    state: "completed",
    conversationUrl: "https://gemini.google.com/app/aaa",
    createdByWfa: true,
  });
  await recordTurn(home, {
    id: "turn-false",
    provider: "chatgpt",
    state: "completed",
    conversationUrl: "https://chatgpt.com/c/bbb",
    createdByWfa: false,
  });

  assert.equal((await readResult(home, "turn-true")).createdByWfa, true);
  assert.equal((await readTurn(home, "turn-false")).createdByWfa, false);

  // Unknown (undefined / null) is rejected by default
  const unk = classifyCleanupCandidate(
    { conversationUrl: "https://gemini.google.com/app/legacy", state: "completed" },
    { all: true },
  );
  assert.equal(unk.eligible, false);
  assert.equal(unk.reason, "created_by_wfa_unknown");

  // Unknown allowed only when includeUnknown: true
  const unkAllowed = classifyCleanupCandidate(
    { conversationUrl: "https://gemini.google.com/app/legacy", state: "completed" },
    { all: true, includeUnknown: true },
  );
  assert.equal(unkAllowed.eligible, true);

  // Pre-existing (false) is ALWAYS rejected even with includeUnknown: true
  const preexisting = classifyCleanupCandidate(
    { conversationUrl: "https://chatgpt.com/c/pre", state: "completed", createdByWfa: false },
    { all: true, includeUnknown: true },
  );
  assert.equal(preexisting.eligible, false);
  assert.equal(preexisting.reason, "preexisting_conversation");
});

test("3.2: collectCleanupCandidates merges results, turns, conversation-store, and sessions.json with URL dedupe", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-b11-merge-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  await recordResult(home, {
    id: "t-res-1",
    provider: "gemini",
    state: "completed",
    conversationUrl: "https://gemini.google.com/app/shared",
    createdByWfa: true,
  });
  // Same URL has a stalled turn in turn-store -> merged state must be stalled
  await recordTurn(home, {
    id: "t-turn-2",
    provider: "gemini",
    state: "stalled",
    conversationUrl: "https://gemini.google.com/app/shared/",
    createdByWfa: true,
  });
  // Conversation store session + retired URL
  const convDir = path.join(home, "conversations", "chatgpt");
  await mkdir(convDir, { recursive: true });
  await writeFile(path.join(convDir, "abc.json"), JSON.stringify({
    schema: 1,
    provider: "chatgpt",
    conversationId: "proj-a",
    conversationUrl: "https://chatgpt.com/c/conv-active",
    retired: [
      { conversationUrl: "https://chatgpt.com/c/conv-retired", cleanupStatus: null },
      { conversationUrl: "https://chatgpt.com/c/conv-already-deleted", cleanupStatus: "deleted" },
    ],
  }));
  // Legacy sessions.json
  await writeFile(path.join(home, "sessions.json"), JSON.stringify({
    version: 1,
    workspaces: {
      legacyWs: {
        gemini: "https://gemini.google.com/app/legacy-ws",
      },
    },
  }));

  const candidates = await collectCleanupCandidates(home);
  const byUrl = new Map(candidates.map((c) => [c.conversationUrl.replace(/\/+$/, ""), c]));
  assert.equal(byUrl.size, 4, "must deduplicate shared URL and skip already-deleted retired URL");
  assert.equal(byUrl.get("https://gemini.google.com/app/shared").state, "stalled");
  assert.equal(byUrl.get("https://chatgpt.com/c/conv-active").createdByWfa, true);
  assert.equal(byUrl.get("https://chatgpt.com/c/conv-retired").createdByWfa, true);
  assert.equal(byUrl.get("https://gemini.google.com/app/legacy-ws").createdByWfa, null);
  assert.equal(byUrl.get("https://gemini.google.com/app/legacy-ws").source, "sessions.json");
});

test("3.3 & 3.4 & 3.5: bulk cleanup uses batch pacing, waits for pathname readiness, respects --limit, and reports deletedCount accurately", async () => {
  const paceKinds = [];
  let readyPolls = 0;

  const stdout = createMockStream();
  const res = await runCdpCommand(["cleanup", "--all", "--limit", "3", "--json"], {
    home: "/tmp/wfa-b11-bulk",
    stdout,
    stderr: createMockStream(),
    sleep: async () => {},
    pace: async (kind) => { paceKinds.push(kind); return 0; },
    resultStore: {
      readResults: async () => [
        { turnId: "t1", provider: "gemini", state: "completed", createdByWfa: true, conversationUrl: "https://gemini.google.com/app/ok1" },
        { turnId: "t2", provider: "gemini", state: "completed", createdByWfa: true, conversationUrl: "https://gemini.google.com/app/ok2" },
        { turnId: "t3", provider: "chatgpt", state: "completed", createdByWfa: true, conversationUrl: "https://chatgpt.com/c/fail3" },
        { turnId: "t4", provider: "chatgpt", state: "completed", createdByWfa: true, conversationUrl: "https://chatgpt.com/c/overlimit4" },
      ],
    },
    adapters: {
      gemini: { buildDeleteConversationJs: (u) => `DELETE:${u}` },
      chatgpt: { buildDeleteConversationJs: (u) => `DELETE:${u}` },
    },
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
    connectCdp: async () => {
      let currentUrl = "https://gemini.google.com/app/ok1";
      return {
        async send(method, params) {
          if (method === "Page.navigate") {
            currentUrl = params.url;
            readyPolls = 0;
            return {};
          }
          if (method === "Runtime.evaluate") {
            if (params.expression.includes("document.readyState")) {
              readyPolls += 1;
              if (readyPolls < 2) {
                return { result: { value: { readyState: "loading", pathname: "/app/stale" } } };
              }
              return { result: { value: { readyState: "complete", pathname: new URL(currentUrl).pathname } } };
            }
            if (params.expression.includes("fail3")) {
              return { result: { value: { success: false, reason: "menu_button_not_found" } } };
            }
            return { result: { value: { success: true, verified: "route_changed" } } };
          }
          return {};
        },
        close() {},
      };
    },
    driver: {
      openTab: async () => ({ targetId: "tab-1", sessionId: "sess-1" }),
      closeTab: async () => {},
    },
  });

  assert.equal(res.code, 0);
  const parsed = JSON.parse(stdout.output);
  assert.deepEqual(paceKinds, ["batch", "batch"], "must use batch (4-6s) pacing");
  assert.equal(parsed.deletedCount, 2);
  assert.equal(parsed.cleanedCount, 2, "cleanedCount must equal verified deletedCount");
  assert.equal(parsed.failedCount, 1);
  assert.equal(parsed.attemptedCount, 0);
  assert.equal(parsed.skippedCount, 1, "4th item skipped due to --limit 3");
  assert.equal(parsed.cleaned[0].status, "deleted");
  assert.equal(parsed.cleaned[0].verified, "route_changed");
  assert.equal(parsed.cleaned[2].status, "failed");
  assert.equal(parsed.cleaned[2].reason, "menu_button_not_found");

  // Direct test of waitForNavigationReady timeout
  const timeoutRes = await waitForNavigationReady(
    {
      async send() {
        return { result: { value: { readyState: "loading", pathname: "/app/wrong" } } };
      },
    },
    "s1",
    "https://gemini.google.com/app/expected",
    { timeoutMs: 30, pollMs: 5, settleMs: 1, sleepFn: async () => new Promise((r) => setTimeout(r, 10)) },
  );
  assert.equal(timeoutRes.ready, false);
  assert.equal(timeoutRes.reason, "navigation_timeout");

  // Null/empty Runtime.evaluate must NOT falsely treat navigation as ready
  const nullEvalRes = await waitForNavigationReady(
    { async send() { return { result: { value: null } }; } },
    "s1",
    "https://gemini.google.com/app/expected",
    { timeoutMs: 30, pollMs: 5, settleMs: 1, sleepFn: async () => new Promise((r) => setTimeout(r, 10)) },
  );
  assert.equal(nullEvalRes.ready, false);
  assert.equal(nullEvalRes.reason, "navigation_timeout");

  // Direct test of parseDeleteEvalResult
  assert.equal(parseDeleteEvalResult({ result: { value: { success: true, verified: "sidebar_entry_removed" } } }).status, "deleted");
  assert.equal(parseDeleteEvalResult({ result: { value: { success: false, reason: "target_url_mismatch" } } }).status, "failed");
  assert.equal(parseDeleteEvalResult({ result: { value: {} } }).status, "attempted");
});

test("3.6: debug-issues.md rotates to debug-issues.md.1 when exceeding maxBytes", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-b11-rotate-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const first = await appendDebugIssue({ home, errorCode: "E1", repro: "A".repeat(200), maxBytes: 150 });
  assert.equal(first.logged, true);
  assert.equal(first.rotated, false);

  const second = await appendDebugIssue({ home, errorCode: "E2", repro: "B".repeat(50), maxBytes: 150 });
  assert.equal(second.logged, true);
  assert.equal(second.rotated, true);

  const logPath = getDebugLogPath(home);
  const backupStat = await stat(`${logPath}.1`);
  assert.ok(backupStat.size >= 150);
  const currentContent = await readFile(logPath, "utf8");
  assert.ok(currentContent.includes("E2"));
  assert.ok(!currentContent.includes("E1"));
});
