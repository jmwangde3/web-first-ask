import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBrokerCommand } from "../src/broker/cli.js";

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

test("1. status when nothing runs -> broker: not running, code 0", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runBrokerCommand(["status"], {
    stdout,
    stderr,
    discoverBroker: async () => null,
  });

  assert.equal(res.code, 0);
  assert.equal(stdout.output, "broker: not running\n");
});

test("2. status --json with an injected live broker -> prints the /status body", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };
  const mockStatusBody = {
    instanceId: "inst-123",
    pid: 9999,
    port: 5050,
    mode: "tray",
    startedAt: "2026-11-23T00:00:00.000Z",
    chrome: { pid: 8888, port: 9222 },
  };

  const res = await runBrokerCommand(["status", "--json"], {
    stdout,
    stderr,
    discoverBroker: async () => mockRecord,
    getStatus: async () => ({ status: 200, json: mockStatusBody }),
  });

  assert.equal(res.code, 0);
  const parsed = JSON.parse(stdout.output);
  assert.deepEqual(parsed, mockStatusBody);
});

test("3. stop success -> prints broker stopping; unreachable -> code 1 and no broker.json deletion", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };

  // Success path
  let shutdownCalled = false;
  const resSuccess = await runBrokerCommand(["stop"], {
    stdout,
    stderr,
    discoverBroker: async () => mockRecord,
    request: async (rec, method, route) => {
      assert.equal(method, "POST");
      assert.equal(route, "/shutdown");
      shutdownCalled = true;
      return { status: 200, json: { ok: true } };
    },
  });
  assert.equal(resSuccess.code, 0);
  assert.equal(shutdownCalled, true);
  assert.equal(stdout.output, "broker stopping\n");

  // Unreachable path
  stdout.clear();
  stderr.clear();
  let clearBrokerCalled = false;
  const resFail = await runBrokerCommand(["stop"], {
    stdout,
    stderr,
    discoverBroker: async () => mockRecord,
    request: async () => {
      const err = new Error("ECONNREFUSED");
      err.code = "BROKER_UNREACHABLE";
      throw err;
    },
    clearBrokerRecord: async () => {
      clearBrokerCalled = true;
    },
  });
  assert.equal(resFail.code, 1);
  assert.equal(clearBrokerCalled, false, "Must not delete broker.json when broker is unreachable");
  assert.match(stderr.output, /BROKER_UNREACHABLE/);
});

test("4. turns --state rejects an unknown state with INVALID_ARGUMENT on stderr, code 1", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runBrokerCommand(["turns", "--state", "bogus_state"], {
    stdout,
    stderr,
  });

  assert.equal(res.code, 1);
  assert.match(stderr.output, /INVALID_ARGUMENT/);
});

test("5. wait returns the terminal text, and needs_human exits 1", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };

  // Success path: completed
  const resCompleted = await runBrokerCommand(["wait", "turn-1"], {
    stdout,
    stderr,
    discoverBroker: async () => mockRecord,
    getTurn: async () => ({
      status: 200,
      json: { id: "turn-1", state: "completed", text: "Answer text" },
    }),
  });
  assert.equal(resCompleted.code, 0);
  assert.equal(stdout.output, "Answer text\n");

  // Failure path: needs_human
  stdout.clear();
  stderr.clear();
  const resNeedsHuman = await runBrokerCommand(["wait", "turn-2"], {
    stdout,
    stderr,
    discoverBroker: async () => mockRecord,
    getTurn: async () => ({
      status: 200,
      json: { id: "turn-2", state: "needs_human", reason: "captcha_detected" },
    }),
  });
  assert.equal(resNeedsHuman.code, 1);
  assert.match(stderr.output, /needs_human/);
});

test("6. unknown subcommand -> code 2", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const res = await runBrokerCommand(["unknown_cmd"], {
    stdout,
    stderr,
  });

  assert.equal(res.code, 2);
  assert.match(stderr.output, /UNKNOWN_COMMAND/);
});

test("7. start --detach spawns with log in <home>/logs, stdio[1] === stdio[2], detached === true", async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "wfa-broker-cli-test-"));
  const stdout = createMockStream();
  const stderr = createMockStream();

  let capturedSpawn = null;
  let discoverCalls = 0;
  const mockRecord = { host: "127.0.0.1", port: 5050, pid: 1234, token: "tok" };

  try {
    const res = await runBrokerCommand(["start", "--detach", "--mode", "visible"], {
      home: tmpHome,
      stdout,
      stderr,
      discoverBroker: async () => {
        discoverCalls++;
        return discoverCalls >= 2 ? mockRecord : null;
      },
      spawn: (command, args, options) => {
        capturedSpawn = { command, args, options };
        return {
          unref: () => {},
        };
      },
      sleep: async () => {},
    });

    assert.equal(res.code, 0);
    assert.ok(capturedSpawn, "spawn must be called");
    assert.equal(capturedSpawn.options.detached, true, "detached === true");
    assert.equal(capturedSpawn.options.stdio[0], "ignore");
    assert.equal(capturedSpawn.options.stdio[1], capturedSpawn.options.stdio[2], "stdio[1] === stdio[2]");

    const logsDir = path.join(tmpHome, "logs");
    const logFiles = await readdir(logsDir);
    assert.ok(logFiles.length >= 1, "Log file must exist under <home>/logs");
    assert.match(logFiles[0], /^broker-.*\.log$/);
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test("8. wait prints (prompt was already sent; do not resend) when sendCommittedAt is set", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };

  const res = await runBrokerCommand(["wait", "turn-cancelled"], {
    stdout,
    stderr,
    discoverBroker: async () => mockRecord,
    getTurn: async () => ({
      status: 200,
      json: {
        id: "turn-cancelled",
        state: "failed",
        reason: "cancelled",
        sendCommittedAt: 1700000000000,
      },
    }),
  });

  assert.equal(res.code, 1);
  assert.match(stderr.output, /\(prompt was already sent; do not resend\)/);
});

test("9. ask without --wait returns turn ID and exit 0", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };

  let createdPayload = null;
  const res = await runBrokerCommand(["ask", "--provider", "chatgpt", "--prompt", "Hello world"], {
    stdout,
    stderr,
    ensureBroker: async () => mockRecord,
    createTurn: async (rec, payload) => {
      createdPayload = payload;
      return { status: 202, json: { id: "turn-abc", state: "accepted" } };
    },
  });

  assert.equal(res.code, 0);
  assert.equal(stdout.output, "turn turn-abc\n");
  assert.equal(createdPayload.provider, "chatgpt");
  assert.equal(createdPayload.prompt, "Hello world");
});

test("10. ask without --wait and --json returns json object and exit 0", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };

  const res = await runBrokerCommand(["ask", "--provider", "gemini", "--prompt", "Hello", "--json"], {
    stdout,
    stderr,
    ensureBroker: async () => mockRecord,
    createTurn: async () => ({ status: 202, json: { id: "turn-xyz", state: "accepted" } }),
  });

  assert.equal(res.code, 0);
  const parsed = JSON.parse(stdout.output);
  assert.deepEqual(parsed, { id: "turn-xyz", state: "accepted" });
});

test("11. ask with --wait polls until completed, prints answer, and exit 0", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };

  let pollCount = 0;
  const res = await runBrokerCommand(["ask", "--provider", "chatgpt", "--prompt", "Explain quantum computing", "--wait"], {
    stdout,
    stderr,
    ensureBroker: async () => mockRecord,
    createTurn: async () => ({ status: 202, json: { id: "turn-wait-1", state: "accepted" } }),
    getTurn: async (rec, id) => {
      pollCount++;
      if (pollCount === 1) {
        return { status: 200, json: { id, state: "running" } };
      }
      return { status: 200, json: { id, state: "completed", text: "Quantum computing is..." } };
    },
    sleep: async () => {},
  });

  assert.equal(res.code, 0);
  assert.equal(stdout.output, "Quantum computing is...\n");
  assert.ok(pollCount >= 2);
});

test("12. ask with --wait on failed turn with sendCommittedAt prints warning and exit 1", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const mockRecord = { host: "127.0.0.1", port: 5050, token: "test-token" };

  const res = await runBrokerCommand(["ask", "--provider", "chatgpt", "--prompt", "Write code", "--wait"], {
    stdout,
    stderr,
    ensureBroker: async () => mockRecord,
    createTurn: async () => ({ status: 202, json: { id: "turn-wait-fail", state: "accepted" } }),
    getTurn: async (rec, id) => ({
      status: 200,
      json: {
        id,
        state: "failed",
        reason: "cancelled",
        sendCommittedAt: 1700000000000,
      },
    }),
  });

  assert.equal(res.code, 1);
  assert.match(stderr.output, /\(prompt was already sent; do not resend\)/);
});

test("13. ask missing provider or prompt returns exit 2 with INVALID_ARGUMENT", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  // Missing provider
  const res1 = await runBrokerCommand(["ask", "--prompt", "Hello"], { stdout, stderr });
  assert.equal(res1.code, 2);
  assert.match(stderr.output, /INVALID_ARGUMENT/);

  // Invalid provider
  stdout.clear();
  stderr.clear();
  const res2 = await runBrokerCommand(["ask", "--provider", "invalid", "--prompt", "Hello"], { stdout, stderr });
  assert.equal(res2.code, 2);
  assert.match(stderr.output, /INVALID_ARGUMENT/);

  // Missing prompt
  stdout.clear();
  stderr.clear();
  const res3 = await runBrokerCommand(["ask", "--provider", "chatgpt"], {
    stdout,
    stderr,
    stdin: { isTTY: true },
  });
  assert.equal(res3.code, 2);
  assert.match(stderr.output, /INVALID_ARGUMENT/);

  // Invalid mode
  stdout.clear();
  stderr.clear();
  const res4 = await runBrokerCommand(["ask", "--provider", "chatgpt", "--prompt", "Hi", "--mode", "bad"], { stdout, stderr });
  assert.equal(res4.code, 2);
  assert.match(stderr.output, /INVALID_ARGUMENT/);
});

test("14. status prints port from record when /status body omits it", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const mockRecord = { host: "127.0.0.1", port: 5151, token: "test-token" };
  const mockStatusBodyWithoutPort = {
    instanceId: "inst-456",
    pid: 1234,
    mode: "tray",
    startedAt: "2026-11-23T00:00:00.000Z",
  };

  const res = await runBrokerCommand(["status"], {
    stdout,
    stderr,
    discoverBroker: async () => mockRecord,
    getStatus: async () => ({ status: 200, json: mockStatusBodyWithoutPort }),
  });

  assert.equal(res.code, 0);
  assert.match(stdout.output, /port: 5151/);
});

test("15. start returns { code: 0 } when serverInstance.closed resolves", async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

  const mockInstance = {
    instanceId: "inst-test",
    port: 5252,
    token: "tok",
    url: "http://127.0.0.1:5252",
    closed: closedPromise,
    close: async () => resolveClosed(),
  };

  const startPromise = runBrokerCommand(["start"], {
    stdout,
    stderr,
    discoverBroker: async () => null,
    startBroker: async () => mockInstance,
    createCdpRunner: () => ({}),
  });

  resolveClosed();

  const res = await startPromise;
  assert.equal(res.code, 0);
});
