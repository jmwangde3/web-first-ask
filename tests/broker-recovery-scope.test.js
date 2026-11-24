import assert from "node:assert/strict";
import test from "node:test";
import { createCdpRunner } from "../src/broker/runner.js";

test("recovery scope: startup and alternating providers share one live Chrome recovery", async () => {
  const recoverCalls = [];
  const engineRecoveries = [];

  const runner = createCdpRunner({
    mode: "background",

    deps: {
      recoverBrowser: async (options) => {
        recoverCalls.push(options);

        return {
          action: "SAFE_START",
          chrome: {
            pid: process.pid,
            port: 9222,
            wsPath: "/devtools/browser/shared",
          },
        };
      },

      fetch: async () => ({
        ok: true,
        status: 200,
      }),

      runCdpTurn: async ({
        provider,
        home,
        mode,
        chromePath,
        deps,
      }) => {
        // Match the actual recovery invocation in cdp-engine.js.
        const recovery = await deps.recoverBrowser({
          home,
          mode,
          chromePath,
          probes: deps.probes,
        });

        engineRecoveries.push({
          provider,
          recovery,
        });

        return {
          status: "completed",
          text: provider,
        };
      },
    },
  });

  // Match the provider-independent startup recovery in server.js.
  const startupRecovery = await runner.recover();

  assert.equal(
    startupRecovery.action,
    "SAFE_START"
  );

  const providers = [
    "chatgpt",
    "gemini",
    "chatgpt",
    "gemini",
  ];

  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];

    const result = await runner.run({
      id: `alternating-${index}`,
      provider,
      prompt: `prompt-${index}`,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.text, provider);
  }

  assert.equal(
    recoverCalls.length,
    1,
    "Different providers using one live Chrome must share recovery"
  );

  assert.deepEqual(
    engineRecoveries.map((entry) => entry.provider),
    providers
  );

  for (const entry of engineRecoveries) {
    assert.strictEqual(
      entry.recovery,
      startupRecovery,
      "The engine must reuse the same instance-level recovery result"
    );
  }

  assert.deepEqual(runner.chrome, {
    pid: process.pid,
    port: 9222,
    mode: "background",
  });
});

test("recovery scope: cross-provider PID or port failure invalidates the shared recovery", async () => {
  const recoveries = [];
  const engineRecoveries = [];

  const deadPids = new Set();
  const unreachablePorts = new Set();

  const runner = createCdpRunner({
    deps: {
      isPidAlive: (pid) => !deadPids.has(pid),

      fetch: async (url) => {
        const port = Number(new URL(url).port);

        if (unreachablePorts.has(port)) {
          throw new Error("connection refused");
        }

        return {
          ok: true,
          status: 200,
        };
      },

      recoverBrowser: async () => {
        const generation = recoveries.length + 1;

        const recovery = {
          action: generation === 1
            ? "SAFE_START"
            : "ADOPT",

          chrome: {
            pid: 10000 + generation,
            port: 9200 + generation,
          },
        };

        recoveries.push(recovery);
        return recovery;
      },

      runCdpTurn: async ({
        provider,
        home,
        mode,
        chromePath,
        deps,
      }) => {
        const recovery = await deps.recoverBrowser({
          home,
          mode,
          chromePath,
          probes: deps.probes,
        });

        engineRecoveries.push({
          provider,
          recovery,
        });

        return {
          status: "completed",
          text: provider,
        };
      },
    },
  });

  let turnNumber = 0;

  async function run(provider) {
    turnNumber++;

    const result = await runner.run({
      id: `recovery-${turnNumber}`,
      provider,
      prompt: `prompt-${turnNumber}`,
    });

    assert.equal(result.status, "completed");

    return engineRecoveries[
      engineRecoveries.length - 1
    ].recovery;
  }

  // Generation 1: ChatGPT initializes the shared Chrome recovery.
  const first = await run("chatgpt");

  assert.equal(recoveries.length, 1);
  assert.strictEqual(first, recoveries[0]);

  // Gemini must reuse the same valid recovery.
  assert.strictEqual(
    await run("gemini"),
    first
  );

  assert.equal(recoveries.length, 1);

  // The PID dies, but the port probe would still succeed.
  // The next provider must not reuse the stale Chrome record.
  deadPids.add(first.chrome.pid);

  const second = await run("gemini");

  assert.equal(recoveries.length, 2);
  assert.strictEqual(second, recoveries[1]);
  assert.notStrictEqual(second, first);

  // ChatGPT must observe the replacement rather than retain a
  // provider-local copy of the old recovery.
  assert.strictEqual(
    await run("chatgpt"),
    second
  );

  assert.equal(recoveries.length, 2);

  // The PID remains alive, but the CDP port becomes unreachable.
  unreachablePorts.add(second.chrome.port);

  const third = await run("chatgpt");

  assert.equal(recoveries.length, 3);
  assert.strictEqual(third, recoveries[2]);
  assert.notStrictEqual(third, second);

  assert.strictEqual(
    await run("gemini"),
    third
  );

  assert.equal(recoveries.length, 3);

  assert.deepEqual(runner.chrome, {
    pid: third.chrome.pid,
    port: third.chrome.port,
    mode: "background",
  });
});
