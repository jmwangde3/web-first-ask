import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { waitForSubmission, discoverBroker, getTurn } from "../src/broker/client.js";
import { readConversation } from "../src/engines/cdp-read.js";
import { runCdpTurn } from "../src/engines/cdp-engine.js";
import { startBroker } from "../src/broker/server.js";
import { readTurn } from "../src/broker/turn-store.js";
import { spawnDetachedBroker } from "../src/broker/cli.js";

async function eventually(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.fail("Condition was not met before timeout");
}

async function closeBroker(broker) {
  if (!broker) return;
  await broker.close().catch(() => {});
  await broker.closed.catch(() => {});
}

test("waitForSubmission waits until sendCommittedAt appears", async () => {
  const record = {
    host: "127.0.0.1",
    port: 43210,
    token: "test-token",
  };

  let pollCount = 0;
  let virtualTime = 0;

  const turn = await waitForSubmission({
    record,
    turnId: "turn-submission-confirmation",
    timeoutMs: 1000,
    pollIntervalMs: 10,
    deps: {
      now: () => virtualTime,
      sleep: async (ms) => {
        virtualTime += ms;
      },
      getTurn: async (_record, id) => {
        pollCount++;
        return {
          status: 200,
          json: {
            id,
            state: "running",
            ...(pollCount === 3 ? { sendCommittedAt: 123456 } : {}),
          },
        };
      },
    },
  });

  assert.equal(pollCount, 3);
  assert.equal(turn.id, "turn-submission-confirmation");
  assert.equal(turn.state, "running");
  assert.equal(turn.sendCommittedAt, 123456);
});

test("waitForSubmission returns a bounded timeout without a submission signal", async () => {
  const record = {
    host: "127.0.0.1",
    port: 43210,
    token: "test-token",
  };

  let virtualTime = 0;

  await assert.rejects(
    () => waitForSubmission({
      record,
      turnId: "turn-never-submitted",
      timeoutMs: 25,
      pollIntervalMs: 10,
      deps: {
        now: () => virtualTime,
        sleep: async (ms) => {
          virtualTime += ms;
        },
        getTurn: async (_record, id) => ({
          status: 200,
          json: {
            id,
            state: "running",
            sendCommittedAt: null,
          },
        }),
      },
    }),
    error => {
      assert.equal(error.code, "SUBMISSION_TIMEOUT");
      assert.equal(error.turnId, "turn-never-submitted");
      return true;
    }
  );
});

test("runCdpTurn publishes sendCommittedAt before answer generation completes", async () => {
  const progress = [];
  let releaseCompletion;

  const completionGate = new Promise(resolve => {
    releaseCompletion = resolve;
  });

  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.evaluate" &&
          params.expression === "window.location.href") {
        return {
          result: {
            value: "https://chatgpt.com/c/submission-progress",
          },
        };
      }
      return {};
    },
    close() {},
  };

  const runPromise = runCdpTurn({
    provider: "chatgpt",
    prompt: "submission progress test",
    mode: "background",
    minIntervalMs: 0,
    onProgress: patch => {
      progress.push(patch);
    },
    deps: {
      skipTurnLock: true,
      enforceCooldown: async () => {},
      recordLastTurn: async () => {},
      withSendSlot: async (_provider, fn) => fn(),
      pace: async () => {},
      recoverBrowser: async () => ({
        action: "ADOPT",
        chrome: { pid: 123, port: 9222 },
      }),
      connectCdp: async () => cdp,
      driver: {
        ensureAnchorTab: async () => ({
          targetId: "anchor",
          created: false,
        }),
        openTab: async () => ({
          targetId: "work",
          sessionId: "work-session",
        }),
        waitForEditor: async () => true,
        readTurnState: async () => ({
          userTurns: 0,
          answerTurns: 0,
          answerText: "",
          answerActionsVisible: false,
          stopVisible: false,
          editorEmpty: true,
          loggedOut: false,
          pageError: null,
        }),
        typePrompt: async () => ({
          typedChars: 24,
          replacedChars: 0,
        }),
        submitTurn: async () => ({}),
        waitForCompletion: async () => {
          await completionGate;
          return {
            status: "completed",
            reason: "completed",
            text: "Final answer",
            evidence: {},
          };
        },
      },
    },
  });

  try {
    const committed = await eventually(
      () => progress.find(patch => patch.sendCommittedAt != null)
    );

    assert.equal(typeof committed.sendCommittedAt, "number");
    assert.equal(committed.conversationUrl, "https://chatgpt.com/");
    assert.equal(committed.targetId, "work");
  } finally {
    releaseCompletion();
  }

  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Final answer");
});

test("spawnDetachedBroker propagates WFA_HOME and cleans a dead broker record", async () => {
  const home = path.join(os.tmpdir(), "wfa-detached-spawn-test");

  let spawnOptions = null;
  let unrefCalled = false;
  let clearedRecord = null;

  const child = {
    unref() {
      unrefCalled = true;
    },
  };

  await spawnDetachedBroker({
    home,
    mode: "background",
    deps: {
      mkdir: async () => {},
      openSync: () => 100,
      closeSync: () => {},
      readBrokerRecord: async () => ({
        instanceId: "stale-instance",
        pid: 999999,
      }),
      isPidAlive: () => false,
      clearBrokerRecord: async (actualHome, instanceId) => {
        clearedRecord = { home: actualHome, instanceId };
      },
      spawn: (_executable, _args, options) => {
        spawnOptions = options;
        return child;
      },
    },
  });

  assert.deepEqual(clearedRecord, {
    home,
    instanceId: "stale-instance",
  });

  assert.equal(spawnOptions.detached, true);
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(spawnOptions.env.WFA_HOME, home);
  assert.equal(unrefCalled, true);
});

test("turn records survive broker restart and distinguish dead broker from unknown task", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-turn-restart-"));

  let firstBroker = null;
  let secondBroker = null;

  const conversationUrl = "https://chatgpt.com/c/persisted-turn";
  const targetId = "persisted-target";
  const sendCommittedAt = 123456789;

  try {
    firstBroker = await startBroker({
      home,
      mode: "tray",
      runner: {
        run: async (_turn, _signal, { onProgress }) => {
          await new Promise(resolve => setTimeout(resolve, 25));

          await onProgress({
            conversationUrl,
            targetId,
            sendCommittedAt,
          });

          return {
            status: "failed",
            text: "",
            reason: "test_terminal_state",
            conversationUrl,
            targetId,
            sendCommittedAt,
          };
        },
      },
    });

    const createResponse = await fetch(`${firstBroker.url}/turns`, {
      method: "POST",
      headers: {
        "x-wfa-token": firstBroker.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "chatgpt",
        prompt: "persist this turn",
        mode: "background",
      }),
    });

    assert.equal(createResponse.status, 202);

    const created = await createResponse.json();
    const turnId = created.id;

    assert.ok(turnId);

    // The creation record must exist before submission starts.
    const initialRecord = await readTurn(home, turnId);

    assert.ok(initialRecord);
    assert.equal(initialRecord.turnId, turnId);
    assert.equal(initialRecord.state, "queued");
    assert.equal(initialRecord.sendCommittedAt, null);

    // Wait for the runner's progress callback to persist submission metadata.
    const committedRecord = await eventually(async () => {
      const record = await readTurn(home, turnId);
      return record?.sendCommittedAt === sendCommittedAt ? record : null;
    });

    assert.equal(committedRecord.conversationUrl, conversationUrl);
    assert.equal(committedRecord.targetId, targetId);

    await closeBroker(firstBroker);
    firstBroker = null;

    // A fresh broker instance must restore the durable turn into its API map.
    secondBroker = await startBroker({
      home,
      mode: "tray",
      runner: {
        run: async () => ({
          status: "failed",
          text: "",
          reason: "unexpected_runner_execution",
        }),
      },
    });

    const record = await discoverBroker(home);
    assert.ok(record);

    const restoredResponse = await getTurn(record, turnId);

    assert.equal(restoredResponse.status, 200);
    assert.equal(restoredResponse.json.id, turnId);
    assert.equal(restoredResponse.json.sendCommittedAt, sendCommittedAt);
    assert.equal(restoredResponse.json.conversationUrl, conversationUrl);
    assert.equal(restoredResponse.json.targetId, targetId);

    // wfa read --task-id must resolve the restored turn without opening Chrome
    // when browser recovery is unavailable.
    const restoredRead = await readConversation({
      home,
      taskId: turnId,
      deps: {
        recoverBrowser: async () => ({
          reason: "test_browser_unavailable",
        }),
      },
    });

    assert.equal(restoredRead.taskId, turnId);
    assert.equal(restoredRead.provider, "chatgpt");
    assert.equal(restoredRead.status, "needs_user");
    assert.equal(restoredRead.reason, "test_browser_unavailable");

    await closeBroker(secondBroker);
    secondBroker = null;

    // A durable task is not an unknown task merely because its broker exited.
    await assert.rejects(
      () => readConversation({
        home,
        taskId: turnId,
      }),
      error => {
        assert.equal(error.code, "BROKER_UNREACHABLE");
        return true;
      }
    );

    // Only an ID absent from both durable stores is TURN_NOT_FOUND.
    await assert.rejects(
      () => readConversation({
        home,
        taskId: "00000000-0000-4000-8000-000000000001",
      }),
      error => {
        assert.equal(error.code, "TURN_NOT_FOUND");
        return true;
      }
    );
  } finally {
    await closeBroker(secondBroker);
    await closeBroker(firstBroker);
    await rm(home, { recursive: true, force: true });
  }
});
