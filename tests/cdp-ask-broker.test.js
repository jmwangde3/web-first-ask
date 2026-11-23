import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { startBroker } from "../src/broker/server.js";
import { recordCommit, hashPrompt } from "../src/broker/journal.js";

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
  };
}

test("cdp ask routes through ensureBroker -> createTurn -> waitForTurn with real broker and preserves flags", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cdp-broker-"));
  let server;
  t.after(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  const seenTurns = [];
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runCdpCommand(
    [
      "ask",
      "--provider", "chatgpt",
      "--prompt", "hello broker",
      "--conversation-id", "conv-alpha",
      "--mode", "visible",
      "--timeout", "45",
      "--settle", "1500",
      "--min-interval", "0",
      "--request-id", "cdp-req-1",
      "--json",
    ],
    {
      home,
      stdout,
      stderr,
      spawnBroker: async () => {
        server = await startBroker({
          home,
          mode: "off",
          idleTimeoutMs: 5000,
          runner: {
            run: async (turn) => {
              seenTurns.push(turn);
              return { status: "completed", text: "brokered answer", reason: "completed" };
            },
          },
        });
      },
    },
  );

  assert.equal(res.code, 0);
  assert.equal(seenTurns.length, 1);
  assert.equal(seenTurns[0].provider, "chatgpt");
  assert.equal(seenTurns[0].conversationId, "conv-alpha");
  assert.equal(seenTurns[0].mode, "visible");
  assert.equal(seenTurns[0].requestId, "cdp-req-1");
  assert.equal(seenTurns[0].settleMs, 1500);
  assert.equal(seenTurns[0].hardTimeoutMs, 45000);
  assert.equal(seenTurns[0].stallTimeoutMs, 45000);
  assert.equal(seenTurns[0].minIntervalMs, 0);

  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.text, "brokered answer");
  assert.equal(parsed.conversationId, "conv-alpha");
});

test("cdp ask with existing orphan succeeds without requestId and enforces requestId idempotency/conflict", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cdp-idem-"));
  let runnerCalls = 0;
  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async () => {
        runnerCalls += 1;
        return { status: "completed", text: `answer-${runnerCalls}` };
      },
    },
  });
  t.after(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });

  await recordCommit(home, {
    turnId: "orphan-1",
    provider: "gemini",
    promptSha256: hashPrompt("duplicate risky prompt"),
  });

  // Same prompt without explicit --request-id succeeds (auto-generated UUID)
  const r0 = await runCdpCommand(
    ["ask", "--provider", "gemini", "--prompt", "duplicate risky prompt", "--json"],
    { home, stdout: createMockStream(), stderr: createMockStream() },
  );
  assert.equal(r0.code, 0);
  assert.equal(runnerCalls, 1);

  // Explicit --request-id replays idempotently
  const r1 = await runCdpCommand(
    ["ask", "--provider", "gemini", "--prompt", "idem prompt", "--request-id", "cdp-idem-1", "--json"],
    { home, stdout: createMockStream(), stderr: createMockStream() },
  );
  const r2 = await runCdpCommand(
    ["ask", "--provider", "gemini", "--prompt", "idem prompt", "--request-id", "cdp-idem-1", "--json"],
    { home, stdout: createMockStream(), stderr: createMockStream() },
  );
  assert.equal(r1.code, 0);
  assert.equal(r2.code, 0);
  assert.equal(r1.result.id, r2.result.id);
  assert.equal(runnerCalls, 2);

  // Same --request-id with different prompt -> 409 REQUEST_ID_CONFLICT
  const conflictOut = createMockStream();
  const r3 = await runCdpCommand(
    ["ask", "--provider", "gemini", "--prompt", "other prompt", "--request-id", "cdp-idem-1", "--json"],
    { home, stdout: conflictOut, stderr: createMockStream() },
  );
  assert.equal(r3.code, 1);
  const parsedConflict = JSON.parse(conflictOut.output);
  assert.equal(parsedConflict.error, "REQUEST_ID_CONFLICT");
  assert.equal(parsedConflict.status, 409);
  assert.equal(runnerCalls, 2);
});

test("cdp ask allows same-provider parallel execution for different conversations while serializing same conversation", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cdp-parallel-"));
  let currentActive = 0;
  let maxObservedActive = 0;

  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async (turn) => {
        currentActive += 1;
        maxObservedActive = Math.max(maxObservedActive, currentActive);
        await new Promise((r) => setTimeout(r, 40));
        currentActive -= 1;
        return { status: "completed", text: `ok:${turn.conversationId}` };
      },
    },
  });
  t.after(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });

  const [r1, r2] = await Promise.all([
    runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "p1", "--conversation-id", "c1", "--json"], {
      home,
      stdout: createMockStream(),
      stderr: createMockStream(),
    }),
    runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "p2", "--conversation-id", "c2", "--json"], {
      home,
      stdout: createMockStream(),
      stderr: createMockStream(),
    }),
  ]);

  assert.equal(r1.code, 0);
  assert.equal(r2.code, 0);
  assert.equal(maxObservedActive, 2, "two distinct chatgpt conversations should run in parallel");
});
