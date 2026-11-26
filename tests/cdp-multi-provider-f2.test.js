import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FANOUT_MAX_TOTAL,
  fanoutPromptSha256,
  fanoutRunState,
  isRetryableFanoutFailure,
  normalizeFanoutProviders,
  retryFanoutProvider,
  runCdpFanout,
} from "../src/engines/cdp-engine.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { executeTask } from "../src/runner.js";
import { isRetryableLegacyProvider, retryTaskProvider } from "../src/runner-retry.js";
import { Store } from "../src/store.js";

function createMockStream() {
  let content = "";
  return {
    write: (chunk) => { content += chunk; return true; },
    get output() { return content; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Fake runTurn with per-provider canned results and concurrency tracking.
// No timers and no polling: each provider's gate opens only when the test
// releases it, and waitForStart() resolves when that provider's runTurn is
// entered (awaiting it leaves the loop idle, so file I/O in front of a turn
// — e.g. the retry path reading fanout.json — is never starved).
function fakeTurnRunner(resultsByProvider, tracker = {}) {
  const calls = [];
  let inFlight = 0;
  const gates = new Map();
  const starters = new Map();
  const waitForStart = (provider) => {
    if (!starters.has(provider)) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      starters.set(provider, { promise, resolve });
    }
    return starters.get(provider).promise;
  };
  const runTurn = async (args) => {
    calls.push(args);
    inFlight += 1;
    tracker.maxInFlight = Math.max(tracker.maxInFlight ?? 0, inFlight);
    tracker.inFlight = inFlight;
    const gate = deferred();
    gates.set(args.provider, gate);
    tracker.gates = gates;
    tracker.started = [...(tracker.started ?? []), args.provider];
    waitForStart(args.provider);
    starters.get(args.provider).resolve(args.provider);
    await gate.promise;
    inFlight -= 1;
    tracker.inFlight = inFlight;
    const canned = resultsByProvider[args.provider];
    if (canned instanceof Error) throw canned;
    return { id: `turn-${args.provider}`, status: "completed", reason: "completed",
      text: `Answer from ${args.provider}`, conversationUrl: `https://${args.provider}.example/c/1`,
      sendCommittedAt: 1000, elapsedMs: 10, ...(canned ?? {}) };
  };
  return { runTurn, calls, tracker, gates, waitForStart };
}

function releaseAll(gates) {
  for (const gate of gates.values()) gate.resolve();
}


async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-f2-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("fanout: two providers run in parallel (max two in flight), each answer to its own file", async () => {
  await withHome(async (home) => {
    const runner = fakeTurnRunner({});
    const { runTurn, tracker, gates } = runner;
    const promise = runCdpFanout({
      providers: ["chatgpt", "gemini"], prompt: "Say hi", home, runTurn,
    });
    await Promise.all([runner.waitForStart("chatgpt"), runner.waitForStart("gemini")]);
    assert.equal(tracker.maxInFlight, 2, "both providers must be in flight at once");
    releaseAll(gates);
    const fanout = await promise;
    assert.equal(fanout.state, "completed");
    assert.equal(tracker.maxInFlight, 2);
    assert.ok(tracker.maxInFlight <= FANOUT_MAX_TOTAL);
    for (const provider of ["chatgpt", "gemini"]) {
      const body = await readFile(path.join(fanout.runDir, provider, "response.md"), "utf8");
      assert.equal(body, `Answer from ${provider}`);
    }
    const record = JSON.parse(await readFile(path.join(fanout.runDir, "fanout.json"), "utf8"));
    assert.equal(record.state, "completed");
    assert.deepEqual(record.results.map((r) => [r.provider, r.status]),
      [["chatgpt", "completed"], ["gemini", "completed"]]);
    assert.equal(record.promptSha256, fanoutPromptSha256("Say hi"));
    // The run record must not contain the prompt text.
    assert.ok(!JSON.stringify(record).includes("Say hi"));
    assert.equal(record.results[0].requestId, `${record.baseRequestId}:chatgpt`);
  });
});

test("fanout: --serial runs providers one at a time, in input order", async () => {
  await withHome(async (home) => {
    const runner = fakeTurnRunner({});
    const { runTurn, calls, tracker, gates } = runner;
    const promise = runCdpFanout({
      providers: ["gemini", "chatgpt"], prompt: "Say hi", home, serial: true, runTurn,
    });
    await runner.waitForStart("gemini");
    assert.equal(tracker.maxInFlight, 1, "serial fan-out must never overlap providers");
    assert.deepEqual(tracker.started, ["gemini"]);
    gates.get("gemini").resolve();
    await runner.waitForStart("chatgpt");
    assert.deepEqual(tracker.started, ["gemini", "chatgpt"]);
    assert.equal(tracker.maxInFlight, 1);
    gates.get("chatgpt").resolve();
    const fanout = await promise;
    assert.equal(fanout.state, "completed");
    assert.deepEqual(fanout.results.map((r) => r.provider), ["gemini", "chatgpt"]);
    assert.deepEqual(calls.map((c) => c.provider), ["gemini", "chatgpt"]);
  });
});

test("fanout: one definite failure does not touch the other provider's artifact", async () => {
  await withHome(async (home) => {
    const { runTurn, gates, waitForStart } = fakeTurnRunner({
      chatgpt: { status: "failed", reason: "login_required", text: "", sendCommittedAt: null },
    });
    const promise = runCdpFanout({ providers: ["chatgpt", "gemini"], prompt: "Say hi", home, runTurn });
    await Promise.all([waitForStart("chatgpt"), waitForStart("gemini")]);
    releaseAll(gates);
    const fanout = await promise;
    assert.equal(fanout.state, "partial");
    assert.equal(fanout.results.find((r) => r.provider === "chatgpt").status, "failed");
    assert.equal(fanout.results.find((r) => r.provider === "gemini").status, "completed");
    assert.equal(await readFile(path.join(fanout.runDir, "gemini", "response.md"), "utf8"), "Answer from gemini");
    await assert.rejects(
      readFile(path.join(fanout.runDir, "chatgpt", "response.md"), "utf8"),
      (err) => err?.code === "ENOENT",
    );
    assert.equal(fanout.results.find((r) => r.provider === "chatgpt").resultPath, null);
  });
});

test("fanout: a throwing provider is recorded as failed and never aborts the other", async () => {
  await withHome(async (home) => {
    const boom = new Error("boom");
    boom.code = "CDP_CLOSED";
    const { runTurn, gates, waitForStart } = fakeTurnRunner({ gemini: boom });
    const promise = runCdpFanout({ providers: ["chatgpt", "gemini"], prompt: "Say hi", home, runTurn });
    await Promise.all([waitForStart("chatgpt"), waitForStart("gemini")]);
    releaseAll(gates);
    const fanout = await promise;
    assert.equal(fanout.state, "partial");
    assert.equal(fanout.results.find((r) => r.provider === "gemini").status, "failed");
    assert.equal(fanout.results.find((r) => r.provider === "gemini").reason, "cdp_closed");
    assert.equal(await readFile(path.join(fanout.runDir, "chatgpt", "response.md"), "utf8"), "Answer from chatgpt");
  });
});

test("fanout: duplicate providers run once; unknown or empty provider lists are rejected", async () => {
  await withHome(async (home) => {
    const { runTurn, calls, gates, waitForStart } = fakeTurnRunner({});
    const promise = runCdpFanout({ providers: ["chatgpt", "chatgpt", "gemini"], prompt: "Say hi", home, runTurn });
    await Promise.all([waitForStart("chatgpt"), waitForStart("gemini")]);
    releaseAll(gates);
    const fanout = await promise;
    assert.deepEqual(fanout.results.map((r) => r.provider), ["chatgpt", "gemini"]);
    assert.equal(calls.length, 2);
    await assert.rejects(
      runCdpFanout({ providers: ["claude"], prompt: "Say hi", home, runTurn }),
      (err) => err?.code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      runCdpFanout({ providers: [], prompt: "Say hi", home, runTurn }),
      (err) => err?.code === "INVALID_ARGUMENT",
    );
  });
  assert.deepEqual(normalizeFanoutProviders(["ChatGPT", "gemini,chatgpt"]), ["chatgpt", "gemini"]);
  assert.equal(fanoutRunState([{ status: "completed" }, { status: "failed" }]), "partial");
  assert.equal(fanoutRunState([{ status: "failed" }, { status: "failed" }]), "failed");
});

test("fanout retry gate: only definite pre-submit failures may be retried", () => {
  const retryable = (status, reason, sendCommittedAt = null) =>
    isRetryableFanoutFailure({ status, reason, sendCommittedAt });
  assert.equal(retryable("failed", "login_required"), true);
  assert.equal(retryable("needs_human", "login_required"), true);
  assert.equal(retryable("failed", "send_button_missing"), true);
  assert.equal(retryable("failed", "prompt_not_typed"), true);
  assert.equal(retryable("failed", "editor_not_found"), true);
  assert.equal(retryable("failed", "timed_out"), false);
  assert.equal(retryable("failed", "send_unconfirmed"), false);
  assert.equal(retryable("failed", "provider_error"), false);
  assert.equal(retryable("stalled", "no_progress"), false);
  assert.equal(retryable("failed", "cancelled"), false);
  assert.equal(retryable("completed", "completed"), false);
  // A definite reason is not enough once anything was submitted.
  assert.equal(retryable("failed", "login_required", 1234), false);
});

test("fanout retry: only the failed provider re-runs, with a derived request id; the other artifact is untouched", async () => {
  await withHome(async (home) => {
    const first = fakeTurnRunner({
      chatgpt: { status: "failed", reason: "login_required", text: "", sendCommittedAt: null },
    });
    const firstRun = runCdpFanout({ providers: ["chatgpt", "gemini"], prompt: "Say hi", home, runTurn: first.runTurn });
    await Promise.all([first.waitForStart("chatgpt"), first.waitForStart("gemini")]);
    releaseAll(first.gates);
    const fanout = await firstRun;
    assert.equal(fanout.state, "partial");
    const geminiPath = path.join(fanout.runDir, "gemini", "response.md");
    const geminiBefore = await readFile(geminiPath, "utf8");
    const geminiStatBefore = await stat(geminiPath);

    const second = fakeTurnRunner({});
    const retried = retryFanoutProvider({
      runDir: fanout.runDir, provider: "chatgpt", prompt: "Say hi", home, runTurn: second.runTurn,
    });
    await second.waitForStart("chatgpt");
    releaseAll(second.gates);
    const done = await retried;
    assert.equal(done.result.status, "completed");
    assert.equal(done.result.requestId, `${fanout.record.baseRequestId}:chatgpt:retry:1`);
    assert.deepEqual(second.calls.map((c) => c.provider), ["chatgpt"]);
    assert.equal(done.record.state, "completed");
    assert.equal(done.result.attempts.length, 1);
    assert.equal(await readFile(path.join(fanout.runDir, "chatgpt", "response.md"), "utf8"), "Answer from chatgpt");
    assert.equal(await readFile(geminiPath, "utf8"), geminiBefore);
    assert.equal((await stat(geminiPath)).mtimeMs, geminiStatBefore.mtimeMs);
  });
});

test("fanout retry: uncertain failures and a changed brief are refused without running anything", async () => {
  await withHome(async (home) => {
    const first = fakeTurnRunner({
      chatgpt: { status: "failed", reason: "timed_out", text: "", sendCommittedAt: 999 },
      gemini: { status: "completed" },
    });
    const firstRun = runCdpFanout({ providers: ["chatgpt", "gemini"], prompt: "Say hi", home, runTurn: first.runTurn });
    await Promise.all([first.waitForStart("chatgpt"), first.waitForStart("gemini")]);
    releaseAll(first.gates);
    const fanout = await firstRun;
    const second = fakeTurnRunner({});
    await assert.rejects(
      retryFanoutProvider({ runDir: fanout.runDir, provider: "chatgpt", prompt: "Say hi", home, runTurn: second.runTurn }),
      (err) => err?.code === "FANOUT_RETRY_REFUSED",
    );
    assert.equal(second.calls.length, 0, "a refused retry must not start a turn");
    await assert.rejects(
      retryFanoutProvider({ runDir: fanout.runDir, provider: "gemini", prompt: "Say hi", home, runTurn: second.runTurn }),
      (err) => err?.code === "FANOUT_RETRY_REFUSED",
    );
    await assert.rejects(
      retryFanoutProvider({ runDir: fanout.runDir, provider: "chatgpt", prompt: "Different brief", home, runTurn: second.runTurn }),
      (err) => err?.code === "FANOUT_PROMPT_MISMATCH",
    );
    assert.equal(second.calls.length, 0);
  });
});

// --- CLI: wfa cdp ask --providers / --retry-provider -----------------------

function mockBrokerDeps(turnsByProvider) {
  const record = { instanceId: "mock-inst", pid: 5000, port: 9444, host: "127.0.0.1", token: "tok" };
  const createdById = new Map();
  const attempts = new Map();
  return {
    ensureBroker: async () => record,
    createTurn: async (_record, payload) => {
      const attempt = (attempts.get(payload.provider) ?? 0) + 1;
      attempts.set(payload.provider, attempt);
      const id = `turn-${payload.provider}-${attempt}`;
      createdById.set(id, payload.provider);
      return { status: 202, json: { id, requestId: payload.requestId } };
    },
    waitForTurn: async ({ turnId }) => {
      const provider = createdById.get(turnId);
      const queue = turnsByProvider[provider];
      const turn = Array.isArray(queue) ? queue.shift() : queue;
      return {
        id: turnId, provider, state: turn?.state ?? "completed",
        text: turn?.text ?? `Answer from ${provider}`,
        reason: turn?.reason ?? "completed",
        conversationUrl: turn?.conversationUrl ?? `https://${provider}.example/c/1`,
        // Preserve an explicit null: a failed turn that never submitted must
        // keep sendCommittedAt null so the retry gate can see it.
        sendCommittedAt: turn && "sendCommittedAt" in turn ? turn.sendCommittedAt : 1000,
        startedAt: "2026-11-26T00:00:00.000Z", finishedAt: "2026-11-26T00:00:01.000Z",
      };
    },
  };
}

test("cli fanout: wfa cdp ask --providers writes per-provider files and a run record", async () => {
  await withHome(async (home) => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const deps = {
      home, stdout, stderr, requestId: "base-1",
      ...mockBrokerDeps({}),
    };
    const res = await runCdpCommand(
      ["ask", "--providers", "chatgpt,gemini", "--prompt", "Say hi", "--json"], deps);
    assert.equal(res.code, 0);
    const output = JSON.parse(stdout.output);
    assert.equal(output.state, "completed");
    assert.deepEqual(output.results.map((r) => r.provider), ["chatgpt", "gemini"]);
    assert.equal(output.results[0].requestId, "base-1:chatgpt");
    assert.equal(output.results[1].requestId, "base-1:gemini");
    for (const provider of ["chatgpt", "gemini"]) {
      assert.equal(await readFile(path.join(output.runDir, provider, "response.md"), "utf8"), `Answer from ${provider}`);
      assert.ok(!("text" in output.results.find((r) => r.provider === provider)), "answer text stays in the artifact file, not stdout");
    }
    const record = JSON.parse(await readFile(path.join(output.runDir, "fanout.json"), "utf8"));
    assert.equal(record.state, "completed");
    assert.ok(!JSON.stringify(record).includes("Say hi"));
  });
});

test("cli fanout: --provider and --providers conflict; --serial is honoured", async () => {
  await withHome(async (home) => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const res = await runCdpCommand(
      ["ask", "--provider", "chatgpt", "--providers", "chatgpt,gemini", "--prompt", "Say hi"],
      { home, stdout, stderr });
    assert.equal(res.code, 1);
    assert.match(stderr.output, /exactly one of --provider or --providers/);

    // Serial: the second provider's createTurn must wait for the first turn.
    const order = [];
    const record = { instanceId: "mock-inst", pid: 5000, port: 9444, host: "127.0.0.1", token: "tok" };
    const serialDeps = {
      home, stdout: createMockStream(), stderr: createMockStream(), requestId: "base-serial",
      ensureBroker: async () => record,
      createTurn: async (_record, payload) => {
        order.push(`create:${payload.provider}`);
        return { status: 202, json: { id: `turn-${payload.provider}` } };
      },
      waitForTurn: async ({ turnId }) => {
        const provider = turnId.replace("turn-", "");
        order.push(`wait:${provider}`);
        return { id: turnId, provider, state: "completed", text: `Answer from ${provider}`,
          reason: "completed", sendCommittedAt: 1000 };
      },
    };
    const serialRes = await runCdpCommand(
      ["ask", "--providers", "chatgpt,gemini", "--prompt", "Say hi", "--serial", "--json"], serialDeps);
    assert.equal(serialRes.code, 0);
    assert.deepEqual(order, ["create:chatgpt", "wait:chatgpt", "create:gemini", "wait:gemini"]);
  });
});

test("cli fanout retry: --retry-provider re-runs only the failed provider from the run record", async () => {
  await withHome(async (home) => {
    const failing = {
      chatgpt: [{ state: "failed", reason: "login_required", text: "", sendCommittedAt: null }],
      gemini: [{ state: "completed" }],
    };
    const firstDeps = {
      home, stdout: createMockStream(), stderr: createMockStream(), requestId: "base-retry",
      ...mockBrokerDeps(failing),
    };
    const first = await runCdpCommand(
      ["ask", "--providers", "chatgpt,gemini", "--prompt", "Say hi", "--json"], firstDeps);
    assert.equal(first.code, 1);
    const firstOut = JSON.parse(firstDeps.stdout.output);
    assert.equal(firstOut.state, "partial");
    const runDir = firstOut.runDir;
    const geminiBefore = await readFile(path.join(runDir, "gemini", "response.md"), "utf8");

    const retryDeps = {
      home, stdout: createMockStream(), stderr: createMockStream(),
      ...mockBrokerDeps({ chatgpt: [{ state: "completed" }] }),
    };
    const retried = await runCdpCommand(
      ["ask", "--retry-provider", "chatgpt", "--run-dir", runDir, "--prompt", "Say hi", "--json"], retryDeps);
    assert.equal(retried.code, 0);
    const retryOut = JSON.parse(retryDeps.stdout.output);
    assert.equal(retryOut.results[0].status, "completed");
    assert.match(retryOut.results[0].requestId, /:retry:1$/);
    assert.equal(await readFile(path.join(runDir, "chatgpt", "response.md"), "utf8"), "Answer from chatgpt");
    assert.equal(await readFile(path.join(runDir, "gemini", "response.md"), "utf8"), geminiBefore);
    const record = JSON.parse(await readFile(path.join(runDir, "fanout.json"), "utf8"));
    assert.equal(record.state, "completed");

    const wrongPromptDeps = {
      home, stdout: createMockStream(), stderr: createMockStream(),
      ...mockBrokerDeps({}),
    };
    const wrong = await runCdpCommand(
      ["ask", "--retry-provider", "chatgpt", "--run-dir", runDir, "--prompt", "Different brief", "--json"], wrongPromptDeps);
    assert.equal(wrong.code, 1);
    assert.match(wrongPromptDeps.stderr.output, /FANOUT_PROMPT_MISMATCH/);
  });
});

test("cli fanout: help documents the fan-out verbs", async () => {
  const stdout = createMockStream();
  const res = await runCdpCommand(["--help"], { stdout, stderr: createMockStream() });
  assert.equal(res.code, 0);
  assert.match(stdout.output, /--providers <chatgpt,gemini>/);
  assert.match(stdout.output, /--retry-provider <chatgpt\|gemini>/);
  assert.match(stdout.output, /--serial/);
});

// --- Legacy ask-bridge path: retryTaskProvider -----------------------------

const legacyConfig = {
  defaultProvider: "chatgpt",
  defaultTimeoutSeconds: 1200,
  maxTimeoutSeconds: 7200,
  maxConcurrency: 3,
  downloadImages: false,
};

function legacyRunProcess(outcomes) {
  return async (_command, args) => {
    const inputFile = args[args.indexOf("--input") + 1];
    const outputDir = args[args.indexOf("--output-dir") + 1];
    const jobs = (await readFile(inputFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await Promise.all(jobs.map(async (job) => {
      const outcome = outcomes[job.provider];
      const jobDir = path.join(outputDir, job.id);
      await mkdir(jobDir, { recursive: true });
      if (outcome?.response) {
        await writeFile(path.join(jobDir, "response.md"), outcome.response);
      }
      await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
        id: job.id, provider: job.provider, state: outcome?.state ?? "completed",
        ...(outcome?.threadUrl ? { threadUrl: outcome.threadUrl } : {}),
        ...(outcome?.error ? { error: outcome.error } : {}),
        elapsedSeconds: 5,
      }));
    }));
    return { code: 0, signal: null, stdout: "done", stderr: "", spawnError: null };
  };
}

test("legacy retry: a definite pre-submit failure is retried alone; the other provider is untouched", async () => {
  await withHome(async (home) => {
    const store = new Store(home);
    const first = await executeTask({
      kind: "compare", prompt: "Compare independently.", providers: ["chatgpt", "gemini"],
      workspace: "sample-repo", timeoutSeconds: 1200, requestId: "legacy-f2-001",
    }, {
      home, store, config: legacyConfig, skipPreflight: true,
      runProcess: legacyRunProcess({
        chatgpt: { state: "failed", error: "Failed to open tab: boom" },
        gemini: { response: "Answer from gemini", threadUrl: "https://gemini.google.com/app/g1" },
      }),
    });
    assert.equal(first.task.state, "partial");
    assert.equal(first.task.children.chatgpt.state, "failed");
    assert.equal(first.task.children.gemini.state, "completed");
    assert.equal(isRetryableLegacyProvider(first.task.children.chatgpt), true);
    assert.equal(isRetryableLegacyProvider(first.task.children.gemini), false);

    let retryLaunches = 0;
    const retried = await retryTaskProvider({
      taskId: first.task.taskId, provider: "chatgpt", home, store, config: legacyConfig,
      runProcess: async (...args) => {
        retryLaunches += 1;
        return legacyRunProcess({
          chatgpt: { response: "Answer from chatgpt, retried", threadUrl: "https://chatgpt.com/c/c1" },
        })(...args);
      },
    });
    assert.equal(retryLaunches, 1);
    assert.equal(retried.child.state, "completed");
    assert.equal(retried.task.children.gemini.state, "completed");
    const geminiResult = await readFile(retried.task.children.gemini.resultPath, "utf8");
    assert.equal(geminiResult, "Answer from gemini");
    assert.equal(await readFile(retried.child.resultPath, "utf8"), "Answer from chatgpt, retried");
    assert.equal(retried.child.retriedAsSingleBatch, true);
  });
});

test("legacy retry: timed_out is refused and never launches a batch", async () => {
  await withHome(async (home) => {
    const store = new Store(home);
    const first = await executeTask({
      kind: "compare", prompt: "Compare independently.", providers: ["chatgpt", "gemini"],
      workspace: "sample-repo", timeoutSeconds: 1200, requestId: "legacy-f2-002",
    }, {
      home, store, config: legacyConfig, skipPreflight: true,
      runProcess: legacyRunProcess({
        chatgpt: { state: "timed_out", error: "response did not complete", threadUrl: "https://chatgpt.com/c/pending" },
        gemini: { response: "Answer from gemini", threadUrl: "https://gemini.google.com/app/g1" },
      }),
    });
    assert.equal(isRetryableLegacyProvider(first.task.children.chatgpt), false);
    let launches = 0;
    await assert.rejects(
      retryTaskProvider({
        taskId: first.task.taskId, provider: "chatgpt", home, store, config: legacyConfig,
        runProcess: async (...args) => { launches += 1; return legacyRunProcess({})(...args); },
      }),
      (err) => err?.code === "RETRY_REFUSED",
    );
    assert.equal(launches, 0, "a refused retry must not launch anything");
  });
});
