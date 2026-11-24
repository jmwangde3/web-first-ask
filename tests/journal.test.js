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
import { getResultsDir, readResult, recordResult } from "../src/broker/result-store.js";
import { getRequestsDir, recordRequest } from "../src/broker/request-store.js";
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

    const match = await findCommitted(tmp, { provider: "chatgpt", promptSha256: sha });
    assert.ok(match);
    assert.equal(match.turnId, "turn-123");

    const diffProvider = await findCommitted(tmp, { provider: "gemini", promptSha256: sha });
    assert.equal(diffProvider, null);

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

    await writeFile(path.join(journalDir, "truncated.json"), '{"schema": 1, "turnId": "bad", ');

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

test("5. POST /turns with same prompt and no requestId succeeds twice with distinct turnIds even if an orphan exists", async () => {
  const tmp = await tempHome();
  let runnerCalls = 0;
  let broker;
  try {
    const promptText = "same prompt without requestId";
    await recordCommit(tmp, {
      turnId: "turn-orphan-legacy",
      provider: "chatgpt",
      promptSha256: hashPrompt(promptText),
      submittedAt: "2026-11-23T09:00:00.000Z",
    });

    const mockRunner = {
      chrome: { pid: process.pid, port: 9222 },
      run: async () => {
        runnerCalls++;
        return { status: "completed", text: `ok-${runnerCalls}` };
      },
    };

    broker = await startBroker({
      home: tmp,
      runner: mockRunner,
    });

    const res1 = await fetch(`http://127.0.0.1:${broker.port}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wfa-token": broker.token },
      body: JSON.stringify({ provider: "chatgpt", prompt: promptText }),
    });
    const res2 = await fetch(`http://127.0.0.1:${broker.port}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wfa-token": broker.token },
      body: JSON.stringify({ provider: "chatgpt", prompt: promptText }),
    });

    assert.equal(res1.status, 202);
    assert.equal(res2.status, 202);
    const body1 = await res1.json();
    const body2 = await res2.json();
    assert.ok(body1.id);
    assert.ok(body2.id);
    assert.notEqual(body1.id, body2.id);
  } finally {
    if (broker) await broker.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("6. POST /turns with clean journal -> 202", async () => {
  const tmp = await tempHome();
  let broker;
  try {
    const mockRunner = {
      chrome: { pid: process.pid, port: 9222 },
      run: async () => ({ status: "completed", text: "ok" }),
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

test("7. Completed turn persists result before clearing journal; failed result write preserves orphan journal", async () => {
  const tmp = await tempHome();
  let broker;
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
          return { status: "completed", text: "all done" };
        },
      },
    });

    broker = await startBroker({
      home: tmp,
      mode: "tray",
      runner,
    });

    const created = await fetch(`http://127.0.0.1:${broker.port}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wfa-token": broker.token },
      body: JSON.stringify({ provider: "chatgpt", prompt: "complete me" }),
    }).then((r) => r.json());

    let done = null;
    for (let i = 0; i < 100; i++) {
      const turn = await fetch(`http://127.0.0.1:${broker.port}/turns/${created.id}`, {
        headers: { "x-wfa-token": broker.token },
      }).then((r) => r.json());
      if (turn.state === "completed") {
        done = turn;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(done);
    assert.equal(done.text, "all done");

    const stored = await readResult(tmp, created.id);
    assert.ok(stored);
    assert.equal(stored.text, "all done");
    assert.equal((await listOrphans(tmp)).length, 0);
  } finally {
    if (broker) await broker.close();
    await rm(tmp, { recursive: true, force: true });
  }

  // Verify journal is preserved if resultStore.recordResult fails
  const tmpFail = await tempHome();
  let brokerFail;
  try {
    const runnerFail = createCdpRunner({
      home: tmpFail,
      deps: {
        recoverBrowser: async () => ({ action: "SAFE_START", chrome: { pid: process.pid, port: 9222 } }),
        fetch: async () => ({ ok: true, status: 200 }),
        runCdpTurn: async ({ deps }) => {
          if (deps?.onSendIntent) {
            await deps.onSendIntent({ provider: "chatgpt", prompt: "persist fail" });
          }
          return { status: "completed", text: "finished" };
        },
      },
    });

    brokerFail = await startBroker({
      home: tmpFail,
      mode: "tray",
      runner: runnerFail,
      deps: {
        resultStore: {
          readResults: async () => [],
          recordResult: async () => {
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          },
          pruneResults: async () => 0,
        },
      },
    });

    const created = await fetch(`http://127.0.0.1:${brokerFail.port}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wfa-token": brokerFail.token },
      body: JSON.stringify({ provider: "chatgpt", prompt: "persist fail" }),
    }).then((r) => r.json());

    for (let i = 0; i < 100; i++) {
      const turn = await fetch(`http://127.0.0.1:${brokerFail.port}/turns/${created.id}`, {
        headers: { "x-wfa-token": brokerFail.token },
      }).then((r) => r.json());
      if (turn.state === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const orphansAfter = await listOrphans(tmpFail);
    assert.equal(orphansAfter.length, 1);
    assert.equal(orphansAfter[0].turnId, created.id);
  } finally {
    if (brokerFail) await brokerFail.close();
    await rm(tmpFail, { recursive: true, force: true });
  }
});

test("8. onSendIntent throwing -> result is needs_human / journal_unwritable and driver.submitTurn never called", async () => {
  // onSendIntent 现位于发送门闩内（typePrompt 之后、submit 之前），因此断言核心安全保证
  // "绝不提交/发送"，而非"绝不输入"（输入草稿但不发送无副作用，且可避免门闩等待期取消误记 intent）。
  let submitTurnCalls = 0;
  const mockDriver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({ userTurns: 0, answerTurns: 0, loggedOut: false }),
    typePrompt: async () => ({ typedChars: 5, replacedChars: 0 }),
    submitTurn: async () => {
      submitTurnCalls++;
    },
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
  assert.equal(submitTurnCalls, 0, "driver.submitTurn must never be called if onSendIntent throws");
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

test("11. listOrphans ignores results/ and requests/ subdirectories", async () => {
  const tmp = await tempHome();
  try {
    await recordResult(tmp, {
      id: "turn-res-1",
      provider: "chatgpt",
      prompt: "secret full prompt should not be stored",
      state: "completed",
      text: "done",
      createdAt: "2026-11-23T00:00:00.000Z",
      finishedAt: "2026-11-23T00:00:05.000Z",
    });
    await recordRequest(tmp, {
      requestId: "req-1",
      requestHash: "hash-1",
      turnId: "turn-res-1",
    });

    assert.ok(getResultsDir(tmp).endsWith(path.join("turns", "results")));
    assert.ok(getRequestsDir(tmp).endsWith(path.join("turns", "requests")));

    const orphans = await listOrphans(tmp);
    assert.deepEqual(orphans, []);

    const stored = await readResult(tmp, "turn-res-1");
    assert.ok(stored);
    assert.equal(Object.hasOwn(stored, "prompt"), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
