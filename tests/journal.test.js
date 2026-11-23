import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hashPrompt,
  getJournalDir,
  recordCommit,
  clearCommit,
  listOrphans,
  findCommitted,
} from "../src/broker/journal.js";
import { startBroker } from "../src/broker/server.js";
import { createCdpRunner } from "../src/broker/runner.js";
import { runCdpTurn } from "../src/engines/cdp-engine.js";
import { runBrokerCommand } from "../src/broker/cli.js";

const tempHome = () => mkdtemp(path.join(os.tmpdir(), "wfa-journal-test-"));

function createMockStream() {
  let content = "";
  return {
    write: (chunk) => {
      content += chunk;
      return true;
    },
    get output() {
      return content;
    },
    clear: () => {
      content = "";
    },
  };
}

test("1. hashPrompt is stable and differs for a one-character change", () => {
  const hash1 = hashPrompt("Hello World");
  const hash2 = hashPrompt("Hello World");
  const hash3 = hashPrompt("Hello World!");

  assert.equal(typeof hash1, "string");
  assert.equal(hash1.length, 64);
  assert.equal(hash1, hash2, "hashPrompt must be stable for identical inputs");
  assert.notEqual(hash1, hash3, "hashPrompt must differ for a one-character change");
});

test("2. recordCommit then findCommitted matches; different provider or different prompt -> null", async () => {
  const tmp = await tempHome();
  try {
    const prompt = "my test prompt";
    const sha = hashPrompt(prompt);

    const record = await recordCommit(tmp, {
      turnId: "turn-123",
      provider: "chatgpt",
      promptSha256: sha,
      conversationId: "conv-1",
    });

    assert.equal(record.turnId, "turn-123");
    assert.equal(record.provider, "chatgpt");
    assert.equal(record.promptSha256, sha);

    // Matching lookup
    const match = await findCommitted(tmp, { provider: "chatgpt", promptSha256: sha });
    assert.ok(match);
    assert.equal(match.turnId, "turn-123");

    // Different provider -> null
    const diffProvider = await findCommitted(tmp, { provider: "gemini", promptSha256: sha });
    assert.equal(diffProvider, null);

    // Different prompt -> null
    const diffPrompt = await findCommitted(tmp, { provider: "chatgpt", promptSha256: hashPrompt("other prompt") });
    assert.equal(diffPrompt, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("3. Two orphans for the same prompt -> older submittedAt is returned", async () => {
  const tmp = await tempHome();
  try {
    const prompt = "collision prompt";
    const promptSha256 = hashPrompt(prompt);

    await recordCommit(tmp, {
      turnId: "turn-newer",
      provider: "chatgpt",
      promptSha256,
      submittedAt: "2026-11-23T12:00:00.000Z",
    });

    await recordCommit(tmp, {
      turnId: "turn-older",
      provider: "chatgpt",
      promptSha256,
      submittedAt: "2026-11-23T08:00:00.000Z",
    });

    const found = await findCommitted(tmp, { provider: "chatgpt", promptSha256 });
    assert.ok(found);
    assert.equal(found.turnId, "turn-older");
    assert.equal(found.submittedAt, "2026-11-23T08:00:00.000Z");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("4. Truncated JSON file in journal dir is skipped, not thrown", async () => {
  const tmp = await tempHome();
  try {
    const journalDir = getJournalDir(tmp);
    await mkdir(journalDir, { recursive: true });

    // Write a corrupted/truncated JSON file
    await writeFile(path.join(journalDir, "truncated.json"), '{"schema": 1, "turnId": "bad", ');

    // Write a valid record
    await recordCommit(tmp, {
      turnId: "turn-valid",
      provider: "gemini",
      promptSha256: hashPrompt("valid prompt"),
    });

    const orphans = await listOrphans(tmp);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].turnId, "turn-valid");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("5. POST /turns with matching orphan -> 409 previously_submitted_uncertain and no runner call", async () => {
  const tmp = await tempHome();
  let runnerCalls = 0;
  let broker;
  try {
    const orphanPrompt = "orphan prompt to test";
    await recordCommit(tmp, {
      turnId: "turn-orphan-409",
      provider: "chatgpt",
      promptSha256: hashPrompt(orphanPrompt),
      submittedAt: "2026-11-23T09:00:00.000Z",
    });

    const mockRunner = {
      chrome: { pid: process.pid, port: 9222 },
      run: async () => {
        runnerCalls++;
        return { status: "completed", text: "ok" };
      },
    };

    broker = await startBroker({
      home: tmp,
      runner: mockRunner,
    });

    const res = await fetch(`http://127.0.0.1:${broker.port}/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wfa-token": broker.token,
      },
      body: JSON.stringify({
        provider: "chatgpt",
        prompt: orphanPrompt,
      }),
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "previously_submitted_uncertain");
    assert.equal(body.orphan?.turnId, "turn-orphan-409");
    assert.equal(body.orphan?.submittedAt, "2026-11-23T09:00:00.000Z");
    assert.match(body.hint, /Inspect the provider tab before resending/);
    assert.equal(runnerCalls, 0, "runner.run must not be called when an orphan matches");
  } finally {
    if (broker) await broker.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("6. POST /turns with clean journal -> 202", async () => {
  const tmp = await tempHome();
  let runnerCalls = 0;
  let broker;
  try {
    const mockRunner = {
      chrome: { pid: process.pid, port: 9222 },
      run: async () => {
        runnerCalls++;
        return { status: "completed", text: "ok" };
      },
    };

    broker = await startBroker({
      home: tmp,
      runner: mockRunner,
    });

    const res = await fetch(`http://127.0.0.1:${broker.port}/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wfa-token": broker.token,
      },
      body: JSON.stringify({
        provider: "chatgpt",
        prompt: "clean fresh prompt",
      }),
    });

    assert.equal(res.status, 202);
    const body = await res.json();
    assert.ok(body.id);
    assert.equal(body.state, "running");
  } finally {
    if (broker) await broker.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("7. Completed turn leaves no journal file", async () => {
  const tmp = await tempHome();
  try {
    const runner = createCdpRunner({
      home: tmp,
      deps: {
        recoverBrowser: async () => ({ action: "SAFE_START", chrome: { pid: process.pid, port: 9222 } }),
        fetch: async () => ({ ok: true, status: 200 }),
        runCdpTurn: async ({ deps }) => {
          if (deps?.onSendIntent) {
            await deps.onSendIntent({ provider: "chatgpt", prompt: "complete me" });
          }
          const orphansMidTurn = await listOrphans(tmp);
          assert.equal(orphansMidTurn.length, 1);
          assert.equal(orphansMidTurn[0].turnId, "turn-complete-1");
          return { status: "completed", text: "all done" };
        },
      },
    });

    const res = await runner.run({ id: "turn-complete-1", provider: "chatgpt", prompt: "complete me" });
    assert.equal(res.status, "completed");

    const orphansAfter = await listOrphans(tmp);
    assert.equal(orphansAfter.length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("8. onSendIntent throwing -> result is needs_human / journal_unwritable and driver.typePrompt never called", async () => {
  let typePromptCalls = 0;
  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({ userTurns: 0, answerTurns: 0, loggedOut: false }),
    typePrompt: async () => {
      typePromptCalls++;
    },
    submitTurn: async () => {},
    waitForCompletion: async () => ({ status: "completed", text: "done" }),
  };

  const res = await runCdpTurn({
    provider: "chatgpt",
    prompt: "Hello",
    deps: {
      recoverBrowser: async () => ({ action: "SAFE_START", chrome: { pid: process.pid, port: 9222 } }),
      connectCdp: async () => ({
        send: async () => ({}),
        close: () => {},
      }),
      driver: mockDriver,
      onSendIntent: async () => {
        throw new Error("disk I/O error writing journal");
      },
    },
  });

  assert.equal(res.status, "needs_human");
  assert.equal(res.reason, "journal_unwritable");
  assert.match(res.evidence.message, /disk I\/O error/);
  assert.equal(typePromptCalls, 0, "driver.typePrompt must never be called if onSendIntent throws");
});

test("9. Runner passes onSendIntent into runCdpTurn deps", async () => {
  const tmp = await tempHome();
  try {
    let capturedDeps;
    const runner = createCdpRunner({
      home: tmp,
      deps: {
        recoverBrowser: async () => ({ action: "SAFE_START", chrome: { pid: process.pid, port: 9222 } }),
        fetch: async () => ({ ok: true, status: 200 }),
        runCdpTurn: async ({ deps }) => {
          capturedDeps = deps;
          return { status: "completed", text: "done" };
        },
      },
    });

    await runner.run({ id: "turn-deps-check", provider: "chatgpt", prompt: "test prompt" });
    assert.ok(capturedDeps);
    assert.equal(typeof capturedDeps.onSendIntent, "function");
    assert.equal(typeof capturedDeps.onSendAborted, "function");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("10. wfa broker clear-orphan <turnId> clears entry and prints what it removed", async () => {
  const tmp = await tempHome();
  try {
    await recordCommit(tmp, {
      turnId: "turn-orphan-to-clear",
      provider: "chatgpt",
      promptSha256: hashPrompt("clear me"),
      submittedAt: "2026-11-23T01:00:00.000Z",
    });

    const orphansBefore = await listOrphans(tmp);
    assert.equal(orphansBefore.length, 1);

    const stdout = createMockStream();
    const stderr = createMockStream();

    const res = await runBrokerCommand(["clear-orphan", "turn-orphan-to-clear"], {
      home: tmp,
      stdout,
      stderr,
    });

    assert.equal(res.code, 0);
    assert.match(stdout.output, /cleared orphan turn-orphan-to-clear \(chatgpt, submittedAt: 2026-11-23T01:00:00.000Z\)/);

    const orphansAfter = await listOrphans(tmp);
    assert.equal(orphansAfter.length, 0);

    const stdout2 = createMockStream();
    const stderr2 = createMockStream();
    const res2 = await runBrokerCommand(["clear-orphan", "turn-orphan-to-clear"], {
      home: tmp,
      stdout: stdout2,
      stderr: stderr2,
    });
    assert.equal(res2.code, 1);
    assert.match(stderr2.output, /NOT_FOUND/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
