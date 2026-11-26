import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCdpCommand, CODE_TASK_VERIFY_DIRECTIVE } from "../src/engines/cdp-cli.js";

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

test("provider-capabilities.md documents ChatGPT, Gemini Chat, and Gemini Task environments", async () => {
  const doc = await readFile(new URL("../docs/provider-capabilities.md", import.meta.url), "utf8");
  for (const needle of [
    "Git `2.47.3`", "Node `22.16.0`", "npm `10.9.2`",
    "Python `3.10`", "Node `18.20.4`", "npm `9.2.0`",
    "git apply --check", "npm test",
  ]) {
    assert.ok(doc.includes(needle), `docs/provider-capabilities.md missing ${needle}`);
  }
});

test("wfa cdp --help documents --code-task and new flags", async () => {
  const stdout = createMockStream();
  const res = await runCdpCommand(["--help"], { stdout, stderr: createMockStream() });
  assert.equal(res.code, 0);
  assert.ok(stdout.output.includes("--code-task"));
  assert.ok(stdout.output.includes("--providers"));
  assert.ok(stdout.output.includes("--download-dir"));
  assert.ok(stdout.output.includes("--fallback-bundle"));
});

test("--code-task attaches a repo bundle and appends git apply --check + npm test directive", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-code-task-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakeBundle = path.join(dir, "repo.bundle");
  await writeFile(fakeBundle, "# v2 git bundle\n");

  let captured = null;
  const res = await runCdpCommand(
    ["ask", "--provider", "chatgpt", "--code-task", "--prompt", "Fix bug X", "--json"],
    {
      home: dir,
      cwd: dir,
      stdout: createMockStream(),
      stderr: createMockStream(),
      createCodeTaskBundle: async () => fakeBundle,
      ensureBroker: async () => ({ host: "127.0.0.1", port: 12345, token: "tok" }),
      createTurn: async (_rec, body) => {
        captured = body;
        return { status: 202, json: { id: "t-code-1", state: "queued" } };
      },
      waitForTurn: async ({ turnId }) => ({ id: turnId, provider: "chatgpt", state: "completed", text: "patch ok" }),
    },
  );

  assert.equal(res.code, 0);
  assert.deepEqual(captured.files, [fakeBundle]);
  assert.ok(captured.prompt.includes("git apply --check"));
  assert.ok(captured.prompt.includes("npm test"));
  assert.ok(captured.prompt.endsWith(CODE_TASK_VERIFY_DIRECTIVE));
});
