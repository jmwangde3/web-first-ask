import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { createTurn } from "../src/broker/turns.js";
import { createCdpRunner } from "../src/broker/runner.js";
import { recordTurn } from "../src/broker/turn-store.js";
import { isValidConversationUrl } from "../src/browser/conversation-store.js";
import { loadConfig } from "../src/config.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { readConversation } from "../src/engines/cdp-read.js";
import * as defaultDriver from "../src/browser/driver.js";

// Coordinator integration wiring (backlog/d1-f9): broker gating for F1/F5
// (claude + geminiMode + downloadDir through turns/runner/turn-store/
// conversation-store/read), F6 pace config, F3 extract CLI. No live
// browser; all browser interaction is mocked.

async function tmpDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function captureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

// --- turns.js: claude + geminiMode + downloadDir ---

test("wiring: createTurn accepts claude with geminiMode task and downloadDir", () => {
  const turn = createTurn({
    provider: "claude",
    prompt: "hi",
    geminiMode: "task",
    downloadDir: "/tmp/wfa-dl",
  });
  assert.equal(turn.provider, "claude");
  assert.equal(turn.geminiMode, "task");
  assert.equal(turn.downloadDir, "/tmp/wfa-dl");
  assert.equal(turn.state, "queued");
});

test("wiring: createTurn rejects an unknown geminiMode and an unknown provider", () => {
  assert.throws(
    () => createTurn({ provider: "gemini", prompt: "hi", geminiMode: "turbo" }),
    /Invalid turn arguments/
  );
  assert.throws(
    () => createTurn({ provider: "grok", prompt: "hi" }),
    /Invalid turn arguments/
  );
});

// --- runner.js: geminiMode / downloadDir / requestId reach runCdpTurn ---

test("wiring: broker runner passes geminiMode, downloadDir and requestId to runCdpTurn", async () => {
  let captured = null;
  const runner = createCdpRunner({
    home: "/tmp/wfa-wiring-runner",
    mode: "background",
    deps: {
      runCdpTurn: async (args) => {
        captured = args;
        return { status: "completed", text: "ok" };
      },
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1, port: 9222 } }),
    },
  });
  const result = await runner.run({
    id: "t1",
    provider: "claude",
    prompt: "hi",
    mode: "background",
    requestId: "r1",
    geminiMode: "task",
    downloadDir: "/tmp/wfa-dl",
  });
  assert.equal(result.status, "completed");
  assert.equal(captured.provider, "claude");
  assert.equal(captured.geminiMode, "task");
  assert.equal(captured.downloadDir, "/tmp/wfa-dl");
  assert.equal(captured.requestId, "r1");
});

// --- turn-store.js: claude records persist ---

test("wiring: turn-store records a claude turn and rejects an unknown provider", async () => {
  const home = await tmpDir("wfa-wiring-turnstore-");
  try {
    await recordTurn(home, { id: "t-claude", provider: "claude", state: "completed" });
    const saved = JSON.parse(
      await readFile(path.join(home, "turns", "records", "t-claude.json"), "utf8")
    );
    assert.equal(saved.provider, "claude");
    assert.equal(saved.state, "completed");
    await assert.rejects(
      recordTurn(home, { id: "t-bad", provider: "grok", state: "completed" }),
      /INVALID_TURN_RECORD/
    );
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// --- conversation-store.js: claude URLs ---

test("wiring: claude.ai /chat/ URLs validate for claude only", () => {
  assert.equal(isValidConversationUrl("claude", "https://claude.ai/chat/abc-123"), true);
  assert.equal(isValidConversationUrl("claude", "https://claude.ai/new"), false);
  assert.equal(isValidConversationUrl("claude", "https://chatgpt.com/c/abc-123"), false);
  assert.equal(isValidConversationUrl("chatgpt", "https://claude.ai/chat/abc-123"), false);
});

// --- config.js: pace defaults and overrides ---

test("wiring: loadConfig supplies F6 pace defaults and honours overrides", async () => {
  const home = await tmpDir("wfa-wiring-config-");
  try {
    const defaults = await loadConfig(home);
    assert.equal(defaults.pace.enabled, true);
    assert.deepEqual(defaults.pace.casual, { min: 1000, max: 2000 });
    assert.deepEqual(defaults.pace.batch, { min: 4000, max: 6000 });

    await writeFile(path.join(home, "config.json"), JSON.stringify({
      pace: { casualMinMs: 500, casualMaxMs: 600, batchMinMs: 1000, batchMaxMs: 1200 },
    }), "utf8");
    const custom = await loadConfig(home);
    assert.deepEqual(custom.pace.casual, { min: 500, max: 600 });
    assert.deepEqual(custom.pace.batch, { min: 1000, max: 1200 });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// --- cdp-cli.js: wfa cdp extract (F3) ---

const EXTRACT_OK = `Here are the files:\nFILE: src/a.js\n\`\`\`js\nconsole.log("a");\n\`\`\`\n`;
const EXTRACT_TRUNCATED = `FILE: src/a.js\n\`\`\`js\nconsole.log("a");\n`;

test("wiring: wfa cdp extract writes files for a well-formed answer", async () => {
  const home = await tmpDir("wfa-wiring-extract-");
  try {
    const input = path.join(home, "answer.md");
    const outDir = path.join(home, "out");
    await writeFile(input, EXTRACT_OK, "utf8");
    const stdout = captureStream();
    const stderr = captureStream();
    const result = await runCdpCommand(
      ["extract", "--input", input, "--out-dir", outDir, "--json"],
      { stdout: stdout.stream, stderr: stderr.stream }
    );
    assert.equal(result.code, 0);
    assert.equal(result.blockCount, 1);
    assert.equal(
      await readFile(path.join(outDir, "src", "a.js"), "utf8"),
      "console.log(\"a\");\n"
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.files.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("wiring: wfa cdp extract refuses a truncated answer and writes nothing", async () => {
  const home = await tmpDir("wfa-wiring-extract-bad-");
  try {
    const input = path.join(home, "answer.md");
    const outDir = path.join(home, "out");
    await writeFile(input, EXTRACT_TRUNCATED, "utf8");
    const stdout = captureStream();
    const stderr = captureStream();
    const result = await runCdpCommand(
      ["extract", "--input", input, "--out-dir", outDir],
      { stdout: stdout.stream, stderr: stderr.stream }
    );
    assert.equal(result.code, 1);
    assert.equal(result.error?.code, "FILE_BLOCK_INTEGRITY_FAILED");
    await assert.rejects(readFile(path.join(outDir, "src", "a.js"), "utf8"));
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// --- cdp-read.js: claude.ai URLs resolve to the claude adapter ---

function makeCdp({ targets = [] } = {}) {
  const state = {
    targets: targets.map((target) => ({ ...target })),
    async send(method, params = {}) {
      if (method === "Target.getTargets") return { targetInfos: state.targets.map((t) => ({ ...t })) };
      if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
      if (method === "Target.createTarget") {
        const targetId = `created-${state.targets.length + 1}`;
        state.targets.push({ targetId, type: "page", url: params.url || "about:blank" });
        return { targetId };
      }
      return {};
    },
    close() {},
  };
  return state;
}

test("wiring: cdp read of a claude.ai URL reaches the claude adapter instead of failing provider validation", async () => {
  const cdp = makeCdp({
    targets: [{ targetId: "claude-tab", type: "page", url: "https://claude.ai/chat/wiring-1" }],
  });
  const result = await readConversation({
    home: "/tmp/wfa-wiring-claude-read",
    url: "https://claude.ai/chat/wiring-1",
    provider: "claude",
    deps: {
      now: () => 0,
      sleep: async () => {},
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        listPageTargets: defaultDriver.listPageTargets,
        openTab: async () => ({ targetId: "claude-tab", sessionId: "claude-session" }),
        readTurnState: async () => ({
          userTurns: 1, answerTurns: 1, answerText: "CLAUDE-OK",
          answerActionsVisible: true, stopVisible: false,
        }),
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "CLAUDE-OK");
  assert.equal(result.provider, "claude");
});
