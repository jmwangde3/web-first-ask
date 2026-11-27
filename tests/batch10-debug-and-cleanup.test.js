import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDebugEnabled, getDebugLogPath } from "../src/debug-log.js";
import { runCdpCommand, classifyCleanupCandidate } from "../src/engines/cdp-cli.js";

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

test("debug mode is ON by default and respects --no-debug and WFA_DEBUG=0", () => {
  const prev = process.env.WFA_DEBUG;
  try {
    delete process.env.WFA_DEBUG;
    assert.equal(isDebugEnabled(), true);
    assert.equal(isDebugEnabled({ "no-debug": true }), false);
    process.env.WFA_DEBUG = "0";
    assert.equal(isDebugEnabled(), false);
    assert.equal(isDebugEnabled({ debug: true }), true);
  } finally {
    if (prev === undefined) delete process.env.WFA_DEBUG;
    else process.env.WFA_DEBUG = prev;
  }
});

test("wfa cdp log-issue appends reproduction record to <home>/debug-issues.md", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-debug-log-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const stdout = createMockStream();
  const stderr = createMockStream();
  const res = await runCdpCommand(
    ["log-issue", "--provider", "gemini", "--task-id", "t-123", "--command", "wfa cdp ask --provider gemini", "--repro", "Timed out after 10s on Task tab", "--json"],
    { home, stdout, stderr },
  );
  assert.equal(res.code, 0, stderr.output);
  const content = await readFile(getDebugLogPath(home), "utf8");
  assert.ok(content.includes("Timed out after 10s on Task tab"));
  assert.ok(content.includes("t-123"));
});

test("failed wfa cdp command auto-logs to debug-issues.md by default and skips with --no-debug", async (t) => {
  const home1 = await mkdtemp(path.join(os.tmpdir(), "wfa-debug-auto-"));
  const home2 = await mkdtemp(path.join(os.tmpdir(), "wfa-debug-off-"));
  t.after(async () => {
    await rm(home1, { recursive: true, force: true });
    await rm(home2, { recursive: true, force: true });
  });

  const stderr1 = createMockStream();
  const r1 = await runCdpCommand(["ask", "--provider", "bad-provider", "--prompt", "hi"], { home: home1, stdout: createMockStream(), stderr: stderr1 });
  assert.equal(r1.code, 1);
  assert.match(stderr1.output, /\[debug\] issue logged to/);
  assert.ok((await readFile(getDebugLogPath(home1), "utf8")).includes("INVALID_ARGUMENT"));

  const stderr2 = createMockStream();
  const r2 = await runCdpCommand(["ask", "--provider", "bad-provider", "--prompt", "hi", "--no-debug"], { home: home2, stdout: createMockStream(), stderr: stderr2 });
  assert.equal(r2.code, 1);
  assert.doesNotMatch(stderr2.output, /\[debug\] issue logged/);
  assert.equal(await stat(getDebugLogPath(home2)).catch(() => null), null);
});

test("bulk wfa cdp cleanup --all opens ONLY ONE tab and navigates within it for all conversations", async () => {
  let openTabCalls = 0;
  let closeTabCalls = 0;
  let paceCalls = 0;
  const navigatedUrls = [];

  const stdout = createMockStream();
  const res = await runCdpCommand(["cleanup", "--all", "--json"], {
    home: "/tmp/wfa-single-tab-cleanup",
    stdout,
    stderr: createMockStream(),
    sleep: async () => {},
    pace: async () => { paceCalls += 1; return 0; },
    resultStore: {
      readResults: async () => [
        { turnId: "t1", provider: "chatgpt", state: "completed", createdByWfa: true, conversationUrl: "https://chatgpt.com/c/one" },
        { turnId: "t2", provider: "chatgpt", state: "completed", createdByWfa: true, conversationUrl: "https://chatgpt.com/c/two" },
        { turnId: "t3", provider: "gemini", state: "completed", createdByWfa: true, conversationUrl: "https://gemini.google.com/app/three" },
      ],
    },
    adapters: {
      chatgpt: { buildDeleteConversationJs: () => "Promise.resolve({ deleted: true })" },
      gemini: { buildDeleteConversationJs: () => "Promise.resolve({ deleted: true })" },
    },
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
    connectCdp: async () => ({
      async send(method, params) {
        if (method === "Page.navigate") navigatedUrls.push(params.url);
        if (method === "Runtime.evaluate") {
          if (String(params?.expression || "").includes("document.readyState")) {
            const current = navigatedUrls[navigatedUrls.length - 1] || "https://chatgpt.com/c/one";
            return { result: { value: { readyState: "complete", pathname: new URL(current).pathname } } };
          }
          return { result: { value: { deleted: true } } };
        }
        return {};
      },
      close() {},
    }),
    driver: {
      openTab: async (_cdp, url) => {
        openTabCalls += 1;
        navigatedUrls.push(url);
        return { targetId: "shared-cleanup-tab", sessionId: "shared-cleanup-session" };
      },
      closeTab: async () => { closeTabCalls += 1; },
    },
  });

  assert.equal(res.code, 0);
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.cleanedCount, 3);
  assert.equal(openTabCalls, 1, "bulk cleanup must open only ONE tab");
  assert.equal(closeTabCalls, 1, "bulk cleanup must close that single tab once");
  assert.equal(paceCalls, 2, "must pace between subsequent navigations");
  assert.deepEqual(navigatedUrls, [
    "https://chatgpt.com/c/one",
    "https://chatgpt.com/c/two",
    "https://gemini.google.com/app/three",
  ]);
  assert.equal(classifyCleanupCandidate({ createdByWfa: true, conversationUrl: "https://chatgpt.com/c/x", state: "stalled" }, { keepUnfinished: true }).eligible, false);
});
