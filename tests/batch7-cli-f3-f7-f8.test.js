import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCdpCommand } from "../src/engines/cdp-cli.js";

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

test("F3 CLI: wfa cdp extract writes verified FILE blocks from --input and rejects truncated fences", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-extract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputMd = path.join(dir, "answer.md");
  const outDir = path.join(dir, "out");
  await writeFile(inputMd, "FILE: lib/a.js\n```js\nexport const a = 1;\n```\n");

  const stdout = createMockStream();
  const stderr = createMockStream();
  const res = await runCdpCommand(["extract", "--input", inputMd, "--out-dir", outDir, "--json"], { stdout, stderr });
  assert.equal(res.code, 0, stderr.output);
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.files.length, 1);
  assert.equal(await readFile(path.join(outDir, "lib/a.js"), "utf8"), "export const a = 1;\n");

  const badMd = path.join(dir, "bad.md");
  await writeFile(badMd, "FILE: lib/b.js\n```js\nexport const b = 2;\n");
  const badErr = createMockStream();
  const badRes = await runCdpCommand(["extract", "--input", badMd, "--out-dir", outDir], { stdout: createMockStream(), stderr: badErr });
  assert.equal(badRes.code, 1);
  assert.match(badErr.output, /INCOMPLETE_CODE_FENCE/);
});

test("F7 CLI: wfa cdp cleanup refuses pre-existing conversations and deletes createdByWfa conversations", async () => {
  const errOut = createMockStream();
  const refused = await runCdpCommand(["cleanup", "--task-id", "t-preexisting"], {
    stdout: createMockStream(),
    stderr: errOut,
    resultStore: {
      readResult: async () => ({
        turnId: "t-preexisting",
        provider: "chatgpt",
        conversationUrl: "https://chatgpt.com/c/old-1",
        createdByWfa: false,
      }),
    },
  });
  assert.equal(refused.code, 1);
  assert.match(errOut.output, /REFUSE_PREEXISTING_CONVERSATION/);

  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-cleanup-"));
  try {
  const okOut = createMockStream();
  const deleted = await runCdpCommand(["cleanup", "--task-id", "t-created", "--json"], {
    home: tmpHome,
    stdout: okOut,
    stderr: createMockStream(),
    resultStore: {
      readResult: async () => ({
        turnId: "t-created",
        provider: "chatgpt",
        conversationUrl: "https://chatgpt.com/c/new-1",
        createdByWfa: true,
      }),
    },
    adapters: {
      chatgpt: { buildDeleteConversationJs: () => "Promise.resolve({ deleted: true })" },
    },
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
    connectCdp: async () => ({
      async send(method) {
        if (method === "Runtime.evaluate") return { result: { value: { deleted: true } } };
        return {};
      },
      close() {},
    }),
    driver: {
      openTab: async () => ({ targetId: "t-del-1", sessionId: "s-del-1" }),
      closeTab: async () => {},
    },
  });
  assert.equal(deleted.code, 0);
  assert.equal(JSON.parse(okOut.output).status, "deleted");
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test("F8 CLI: wfa cdp ask --fallback-bundle auto-bundles and submits follow-up on REPO_UNREADABLE", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-fb-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakeZip = path.join(dir, "repo.zip");
  await writeFile(fakeZip, "PK");

  const createdBodies = [];
  const stdout = createMockStream();
  const stderr = createMockStream();
  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--prompt", "review repo", "--fallback-bundle", "--json"],
    {
      home: dir,
      cwd: dir,
      stdout,
      stderr,
      ensureBroker: async () => ({ host: "127.0.0.1", port: 12345, token: "tok" }),
      archiveRepository: async () => ({ archivePath: fakeZip }),
      createTurn: async (_rec, body) => {
        createdBodies.push(body);
        return { status: 202, json: { id: `turn-${createdBodies.length}`, state: "queued" } };
      },
      waitForTurn: async ({ turnId }) => {
        if (turnId === "turn-1") {
          return { id: "turn-1", provider: "chatgpt", state: "completed", text: "REPO_UNREADABLE" };
        }
        return { id: "turn-2", provider: "chatgpt", state: "completed", text: "Reviewed from zip!" };
      },
    },
  );

  assert.equal(res.code, 0, stderr.output);
  assert.equal(createdBodies.length, 2);
  assert.deepEqual(createdBodies[1].files, [fakeZip]);
  const parsed = JSON.parse(stdout.output);
  assert.equal(parsed.fallbackTriggered, true);
  assert.equal(parsed.text, "Reviewed from zip!");
});
