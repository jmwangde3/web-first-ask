import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCdpCommand } from "../src/engines/cdp-cli.js";
import { startBroker } from "../src/broker/server.js";
import { loadSession, saveSession } from "../src/browser/conversation-store.js";

const CHATGPT_CREATED_1 = "https://chatgpt.com/c/created-1";
const CHATGPT_CREATED_2 = "https://chatgpt.com/c/created-2";
const CHATGPT_PREEXISTING = "https://chatgpt.com/c/pre-existing-1";
const GEMINI_CREATED = "https://gemini.google.com/app/created-1";

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

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cleanup-f7f8-"));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function seedCleanupSessions(home) {
  await saveSession(home, "chatgpt", "run-created", {
    conversationUrl: CHATGPT_CREATED_1,
    turnCount: 1,
    createdByRun: true,
    createdRunId: "run-1",
  });
  await saveSession(home, "chatgpt", "run-created-2", {
    conversationUrl: CHATGPT_CREATED_2,
    turnCount: 1,
    createdByRun: true,
    createdRunId: "run-2",
  });
  await saveSession(home, "chatgpt", "pre", {
    conversationUrl: CHATGPT_PREEXISTING,
    turnCount: 1,
  });
  await saveSession(home, "gemini", "g-created", {
    conversationUrl: GEMINI_CREATED,
    turnCount: 1,
    createdByRun: true,
    createdRunId: "run-1",
  });
}

function throwingBrowser() {
  return async () => {
    throw new Error("browser must not launch");
  };
}

// --- F7: explicit cleanup trigger ---

test("F7 cleanup dry-run lists only created-by-run conversations; pre-existing never listed", async () => {
  await withHome(async (home) => {
    await seedCleanupSessions(home);
    const stdout = createMockStream();
    const res = await runCdpCommand(["cleanup", "--dry-run", "--json"], {
      home,
      stdout,
      stderr: createMockStream(),
      recoverBrowser: throwingBrowser(),
    });
    assert.equal(res.code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.status, "done");
    assert.deepEqual(parsed.deleted, []);
    assert.deepEqual([...parsed.wouldDelete].sort(), [CHATGPT_CREATED_1, CHATGPT_CREATED_2, GEMINI_CREATED].sort());
    assert.ok(!parsed.wouldDelete.includes(CHATGPT_PREEXISTING));
  });
});

test("F7 cleanup dry-run: --conversation-id scopes to one session; --run-id narrows to one run", async () => {
  await withHome(async (home) => {
    await seedCleanupSessions(home);

    const scopedOut = createMockStream();
    const scoped = await runCdpCommand(
      ["cleanup", "--provider", "chatgpt", "--conversation-id", "run-created", "--dry-run", "--json"],
      { home, stdout: scopedOut, stderr: createMockStream(), recoverBrowser: throwingBrowser() },
    );
    assert.equal(scoped.code, 0);
    assert.deepEqual(JSON.parse(scopedOut.output).wouldDelete, [CHATGPT_CREATED_1]);

    const runOut = createMockStream();
    const byRun = await runCdpCommand(
      ["cleanup", "--run-id", "run-2", "--dry-run", "--json"],
      { home, stdout: runOut, stderr: createMockStream(), recoverBrowser: throwingBrowser() },
    );
    assert.equal(byRun.code, 0);
    assert.deepEqual(JSON.parse(runOut.output).wouldDelete, [CHATGPT_CREATED_2]);

    const otherRunOut = createMockStream();
    const otherRun = await runCdpCommand(
      ["cleanup", "--run-id", "no-such-run", "--dry-run", "--json"],
      { home, stdout: otherRunOut, stderr: createMockStream(), recoverBrowser: throwingBrowser() },
    );
    assert.equal(otherRun.code, 0);
    assert.deepEqual(JSON.parse(otherRunOut.output).wouldDelete, []);
  });
});

test("F7 cleanup: --conversation-id without --provider is rejected", async () => {
  await withHome(async (home) => {
    const res = await runCdpCommand(
      ["cleanup", "--conversation-id", "run-created", "--dry-run", "--json"],
      { home, stdout: createMockStream(), stderr: createMockStream() },
    );
    assert.equal(res.code, 1);
    assert.equal(res.error?.code, "INVALID_ARGUMENT");
  });
});

test("F7 cleanup deletes exactly the created set, is idempotent, never touches pre-existing", async () => {
  await withHome(async (home) => {
    await seedCleanupSessions(home);
    const evaluateCalls = [];
    let recoverCalls = 0;
    const fakeCdp = {
      send: async (method, params) => {
        if (method === "Runtime.evaluate") {
          evaluateCalls.push(params.expression);
          return { result: { value: { success: true } } };
        }
        if (method === "Target.closeTarget") return {};
        throw new Error(`unexpected CDP ${method}`);
      },
      close: () => {},
    };
    const deps = {
      home,
      stdout: createMockStream(),
      stderr: createMockStream(),
      recoverBrowser: async () => {
        recoverCalls += 1;
        return { chrome: { port: 9222 } };
      },
      connectCdp: async (port) => {
        assert.equal(port, 9222);
        return fakeCdp;
      },
      driver: {
        openTab: async (_cdp, url) => ({ targetId: `tab-${url}`, sessionId: "s1" }),
      },
      adapters: {
        chatgpt: { buildDeleteConversationJs: (url) => `delete(${JSON.stringify(url)})` },
        gemini: { buildDeleteConversationJs: (url) => `delete(${JSON.stringify(url)})` },
        claude: { buildDeleteConversationJs: (url) => `delete(${JSON.stringify(url)})` },
      },
    };

    const out1 = createMockStream();
    const first = await runCdpCommand(["cleanup", "--provider", "chatgpt", "--json"], { ...deps, stdout: out1 });
    assert.equal(first.code, 0);
    const parsed1 = JSON.parse(out1.output);
    assert.deepEqual([...parsed1.deleted].sort(), [CHATGPT_CREATED_1, CHATGPT_CREATED_2].sort());
    assert.deepEqual(parsed1.failed, []);
    assert.deepEqual(parsed1.wouldDelete, []);
    // Each created URL was evaluated exactly once, via the adapter's script.
    for (const url of [CHATGPT_CREATED_1, CHATGPT_CREATED_2]) {
      assert.equal(evaluateCalls.filter((expr) => expr.includes(url)).length, 1);
    }
    assert.ok(!evaluateCalls.some((expr) => expr.includes("pre-existing")));
    assert.equal(recoverCalls, 1);

    // The gemini created conversation is untouched by a chatgpt-scoped run.
    assert.equal((await loadSession(home, "gemini", "g-created")).createdByRun, true);
    const geminiOut = createMockStream();
    await runCdpCommand(["cleanup", "--provider", "gemini", "--dry-run", "--json"], {
      home, stdout: geminiOut, stderr: createMockStream(), recoverBrowser: throwingBrowser(),
    });
    assert.deepEqual(JSON.parse(geminiOut.output).wouldDelete, [GEMINI_CREATED]);

    // Idempotent: a second run deletes nothing and does not launch Chrome.
    const out2 = createMockStream();
    const second = await runCdpCommand(["cleanup", "--provider", "chatgpt", "--json"], { ...deps, stdout: out2 });
    assert.equal(second.code, 0);
    const parsed2 = JSON.parse(out2.output);
    assert.deepEqual(parsed2.deleted, []);
    assert.deepEqual(parsed2.wouldDelete, []);
    assert.equal(recoverCalls, 1, "no browser launch when nothing is left to delete");

    // The pre-existing session record is byte-identical in meaning: still
    // pre-existing, still pointing at its URL, never marked deleted.
    const pre = await loadSession(home, "chatgpt", "pre");
    assert.equal(pre.createdByRun, false);
    assert.equal(pre.conversationUrl, CHATGPT_PREEXISTING);
    assert.deepEqual(pre.retired, []);
  });
});

// --- F8: automatic REPO_UNREADABLE fallback on the CDP path ---

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

async function makeGitRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-f8-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "a@example.test");
  git(root, "config", "user.name", "Test");
  await writeFile(path.join(root, "app.js"), "export const answer = 42;\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  return root;
}

function mockBroker({ parentTurn, fallbackTurn }) {
  const created = [];
  const waits = [];
  const record = { instanceId: "test", pid: 1, port: 1 };
  return {
    record,
    created,
    waits,
    ensureBroker: async () => record,
    createTurn: async (_record, payload) => {
      created.push(payload);
      const id = created.length === 1 ? "parent-turn-id" : "fallback-turn-id";
      return { status: 202, json: { id, requestId: payload.requestId, state: "queued" } };
    },
    waitForTurn: async ({ turnId }) => {
      waits.push(turnId);
      if (turnId === "parent-turn-id") return parentTurn;
      return fallbackTurn;
    },
  };
}

const PARENT_SENTINEL = {
  id: "parent-turn-id",
  state: "completed",
  text: "REPO_UNREADABLE",
  reason: null,
  conversationId: "conv-1",
  provider: "chatgpt",
};
const FALLBACK_ANSWER = {
  id: "fallback-turn-id",
  state: "completed",
  text: "bundled answer",
  reason: null,
  conversationId: "conv-1",
  provider: "chatgpt",
};

test("F8 CDP ask detects REPO_UNREADABLE and issues exactly one fallback turn with new request id and bundled input", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-f8-home-"));
  const repoRoot = await makeGitRepo();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  const broker = mockBroker({ parentTurn: PARENT_SENTINEL, fallbackTurn: FALLBACK_ANSWER });
  const stdout = createMockStream();
  const stderr = createMockStream();
  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "read the repo and answer the question",
      "--request-id", "parent-req-1", "--conversation-id", "conv-1",
      "--workspace", repoRoot, "--no-stage", "--json"],
    {
      home, stdout, stderr,
      ensureBroker: broker.ensureBroker,
      createTurn: broker.createTurn,
      waitForTurn: broker.waitForTurn,
    },
  );

  assert.equal(res.code, 0);
  assert.equal(broker.created.length, 2, "exactly one fallback turn after the parent");
  assert.deepEqual(broker.waits, ["parent-turn-id", "fallback-turn-id"]);

  const [parentPayload, fallbackPayload] = broker.created;
  assert.equal(parentPayload.requestId, "parent-req-1");
  assert.ok(fallbackPayload.requestId.startsWith("repo-fallback-"), "new request id");
  assert.notEqual(fallbackPayload.requestId, "parent-req-1");
  assert.equal(fallbackPayload.conversationId, "conv-1", "same conversation");
  assert.ok(!fallbackPayload.prompt.includes("read the repo and answer the question"), "never the original prompt");
  assert.ok(fallbackPayload.prompt.includes("Extract the attached repository archive"), "bundled instruction");
  assert.equal(fallbackPayload.files.length, 1, "attached archive");
  assert.ok(fallbackPayload.files[0].endsWith(".zip"));
  const archive = await readFile(fallbackPayload.files[0]);
  assert.equal(archive.subarray(0, 2).toString("latin1"), "PK", "archive is a zip");

  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.text, "bundled answer", "fallback turn result replaces the parent's");
  assert.equal(parsed.repoFallback.action, "retry-with-bundle");
  assert.equal(parsed.repoFallback.transport, "zip");
  assert.equal(parsed.repoFallback.newRequestId, fallbackPayload.requestId);
  assert.equal(parsed.repoFallback.parentTurnId, "parent-turn-id");
  assert.equal(parsed.repoFallback.fallbackTurnId, "fallback-turn-id");
  assert.equal(parsed.repoFallback.fallbackStatus, "completed");
});

test("F8 CDP ask issues no fallback turn when the sentinel is absent", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-f8-home-"));
  const repoRoot = await makeGitRepo();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  const broker = mockBroker({
    parentTurn: { ...PARENT_SENTINEL, text: "a normal answer" },
    fallbackTurn: FALLBACK_ANSWER,
  });
  const stdout = createMockStream();
  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "read the repo and answer the question",
      "--request-id", "parent-req-1", "--conversation-id", "conv-1",
      "--workspace", repoRoot, "--no-stage", "--json"],
    {
      home, stdout, stderr: createMockStream(),
      ensureBroker: broker.ensureBroker,
      createTurn: broker.createTurn,
      waitForTurn: broker.waitForTurn,
    },
  );

  assert.equal(res.code, 0);
  assert.equal(broker.created.length, 1, "no fallback turn without the sentinel");
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.text, "a normal answer");
  assert.equal(parsed.repoFallback, undefined);
});

test("F8 CDP ask does not loop when the fallback turn itself answers REPO_UNREADABLE", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-f8-home-"));
  const repoRoot = await makeGitRepo();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  const broker = mockBroker({
    parentTurn: PARENT_SENTINEL,
    fallbackTurn: { ...FALLBACK_ANSWER, text: "REPO_UNREADABLE" },
  });
  const stdout = createMockStream();
  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "read the repo and answer the question",
      "--request-id", "parent-req-1", "--conversation-id", "conv-1",
      "--workspace", repoRoot, "--no-stage", "--json"],
    {
      home, stdout, stderr: createMockStream(),
      ensureBroker: broker.ensureBroker,
      createTurn: broker.createTurn,
      waitForTurn: broker.waitForTurn,
    },
  );

  assert.equal(res.code, 0);
  assert.equal(broker.created.length, 2, "one fallback only, even when it also reports unreadable");
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.text, "REPO_UNREADABLE");
  assert.equal(parsed.repoFallback.action, "retry-with-bundle");
});

test("F8 CDP ask reports no fallback when there is no local repository to bundle", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-f8-home-"));
  const plainDir = await mkdtemp(path.join(os.tmpdir(), "wfa-f8-plain-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(plainDir, { recursive: true, force: true });
  });

  const broker = mockBroker({ parentTurn: PARENT_SENTINEL, fallbackTurn: FALLBACK_ANSWER });
  const stdout = createMockStream();
  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "read the repo and answer the question",
      "--request-id", "parent-req-1", "--conversation-id", "conv-1",
      "--workspace", plainDir, "--no-stage", "--json"],
    {
      home, stdout, stderr: createMockStream(),
      ensureBroker: broker.ensureBroker,
      createTurn: broker.createTurn,
      waitForTurn: broker.waitForTurn,
    },
  );

  assert.equal(res.code, 0);
  assert.equal(broker.created.length, 1, "no fallback without a local repository");
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.text, "REPO_UNREADABLE", "parent answer is kept");
  assert.equal(parsed.repoFallback.action, "none");
  assert.equal(parsed.repoFallback.reason, "no-local-repository");
});

test("F8 broker forwards files through POST /turns so the runner receives the attachment", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-f8-files-"));
  const seenTurns = [];
  const server = await startBroker({
    home,
    mode: "tray",
    runner: {
      run: async (turn) => {
        seenTurns.push(turn);
        return { status: "completed", text: "ok" };
      },
    },
  });
  t.after(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });

  const attachment = path.join(home, "note.txt");
  await writeFile(attachment, "hello\n", "utf8");
  const stdout = createMockStream();
  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "use the attachment",
      "--file", attachment, "--no-stage", "--json"],
    { home, stdout, stderr: createMockStream() },
  );

  assert.equal(res.code, 0);
  assert.equal(seenTurns.length, 1);
  assert.deepEqual(seenTurns[0].files, [attachment]);
  assert.ok(await lstat(attachment).then((s) => s.isFile()));
});
