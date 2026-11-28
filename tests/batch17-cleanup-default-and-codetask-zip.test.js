import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runCdpCommand, CODE_TASK_VERIFY_DIRECTIVE } from "../src/engines/cdp-cli.js";

const execFile = promisify(execFileCb);

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

test("cleanup default: one-shot defaults to cleanupCreated=true; --no-cleanup and named sessions default to false", async () => {
  const sentBodies = [];
  const runCase = async (args) => {
    const stdout = createMockStream();
    const res = await runCdpCommand(args, {
      stdout,
      stderr: createMockStream(),
      ensureBroker: async () => ({ host: "127.0.0.1", port: 12345, token: "t" }),
      createTurn: async (_rec, body) => {
        sentBodies.push(body);
        return { status: 202, json: { id: "t-1", state: "queued" } };
      },
      waitForTurn: async () => ({
        id: "t-1",
        provider: "chatgpt",
        state: "completed",
        text: "ok",
        conversationUrl: "https://chatgpt.com/c/abc",
        createdCleanup: bodyCleanup(sentBodies[sentBodies.length - 1]),
      }),
    });
    assert.equal(res.code, 0);
    return JSON.parse(stdout.output);
  };
  const bodyCleanup = (b) => (b.cleanupCreated ? { status: "deleted", url: "https://chatgpt.com/c/abc", createdByWfa: true } : null);

  // 1. One-shot (no flag) -> cleanupCreated: true
  const r1 = await runCase(["ask", "--provider", "chatgpt", "--prompt", "hi", "--json"]);
  assert.equal(sentBodies[0].cleanupCreated, true);
  assert.equal(r1.conversationUrl, "https://chatgpt.com/c/abc");
  assert.equal(r1.cleanup?.status, "deleted");

  // 2. One-shot with --no-cleanup -> cleanupCreated omitted/false
  const r2 = await runCase(["ask", "--provider", "chatgpt", "--no-cleanup", "--prompt", "hi", "--json"]);
  assert.equal(Boolean(sentBodies[1].cleanupCreated), false);
  assert.equal(r2.cleanup, undefined);

  // 3. Named session (no --cleanup) -> cleanupCreated omitted/false
  await runCase(["ask", "--provider", "chatgpt", "--conversation-id", "my-conv", "--prompt", "hi", "--json"]);
  assert.equal(Boolean(sentBodies[2].cleanupCreated), false);

  // 4. Named session with explicit --cleanup -> cleanupCreated: true
  await runCase(["ask", "--provider", "chatgpt", "--conversation-id", "my-conv", "--cleanup", "--prompt", "hi", "--json"]);
  assert.equal(sentBodies[3].cleanupCreated, true);

  // 5. Gemini result exposes geminiMode
  const rGem = await runCase(["ask", "--provider", "gemini", "--gemini-mode", "task", "--prompt", "hi", "--json"]);
  assert.equal(rGem.geminiMode, "task");
});

test("code-task: packages git repo as .zip containing repo.bundle (never raw .bundle)", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "wfa-ct-repo-"));
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "wfa-ct-home-"));
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  await execFile("git", ["init", "-q"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "test"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "test@local"], { cwd: repoDir });
  await writeFile(path.join(repoDir, "hello.txt"), "hello world\n", "utf8");
  await execFile("git", ["add", "hello.txt"], { cwd: repoDir });
  await execFile("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

  let captured = null;
  const stdout = createMockStream();
  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--code-task", "--workspace", repoDir, "--prompt", "Fix bug", "--json"],
    {
      home: homeDir,
      stdout,
      stderr: createMockStream(),
      ensureBroker: async () => ({ host: "127.0.0.1", port: 12345, token: "t" }),
      createTurn: async (_rec, body) => {
        captured = body;
        return { status: 202, json: { id: "t-ct", state: "queued" } };
      },
      waitForTurn: async () => ({ id: "t-ct", provider: "chatgpt", state: "completed", text: "done" }),
    },
  );

  assert.equal(res.code, 0);
  assert.ok(Array.isArray(captured?.files) && captured.files.length === 1);
  const attached = captured.files[0];
  assert.ok(attached.endsWith(".zip"), `expected .zip attachment for ChatGPT/Gemini compatibility, got ${attached}`);
  const zipBytes = await readFile(attached);
  assert.equal(zipBytes[0], 0x50); // 'P'
  assert.equal(zipBytes[1], 0x4b); // 'K'
  assert.ok(zipBytes.includes(Buffer.from("repo.bundle")), "zip must contain repo.bundle entry");
  assert.ok(captured.prompt.endsWith(CODE_TASK_VERIFY_DIRECTIVE));
});

test("chatgpt upload: buildUploadJs clicks uploadTriggerSelector and ATTACH_UPLOAD_FAILED reports inputDesc", async () => {
  const { attachFiles } = await import("../src/browser/driver.js");
  const chatgptAdapter = await import("../src/browser/adapters/chatgpt.js");
  const testFile = path.resolve("package.json");

  let uploadJsCalled = false;
  const mockCdp = {
    async send(method, params = {}) {
      if (method === "Runtime.evaluate") {
        const expr = String(params.expression || "");
        if (expr.includes("添加文件等内容")) {
          uploadJsCalled = true;
          return { result: { value: { success: true, triggered: true, inputDesc: { ariaLabel: "附加文件", accept: null, multiple: true, id: "_r_u_", inForm: true } } } };
        }
        if (expr.includes("filesAfterSet")) {
          return { result: { value: { found: true, filesAfterSet: 1, changeDispatched: true, inputDesc: { ariaLabel: "附加文件", accept: null, multiple: true, id: "_r_u_", inForm: true } } } };
        }
        return { result: { value: { present: false, matched: [false], chipCount: 0, chipTexts: [], inputFiles: [], inputDesc: { ariaLabel: "附加文件", accept: null, multiple: true, id: "_r_u_", inForm: true }, sendReady: false } } };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 99 };
      if (method === "DOM.setFileInputFiles") return {};
      return {};
    },
  };

  await assert.rejects(
    attachFiles(mockCdp, "sess-1", chatgptAdapter, [testFile], {
      attachmentVerifyTimeoutMs: 50,
      attachmentVerifyIntervalMs: 10,
      sleep: async () => {},
    }),
    (err) => {
      assert.equal(err.code, "ATTACH_UPLOAD_FAILED");
      assert.equal(err.details?.inputDesc?.ariaLabel, "附加文件");
      assert.equal(err.details?.inputDesc?.accept, null);
      assert.equal(err.details?.inputDesc?.multiple, true);
      assert.equal(err.details?.changeDispatched, true);
      return true;
    },
  );
  assert.equal(uploadJsCalled, true, "ChatGPT attachFiles must run buildUploadJs before DOM.setFileInputFiles");
});
