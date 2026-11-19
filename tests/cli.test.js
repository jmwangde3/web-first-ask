import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import { buildComparePrompt } from "../src/prompts.js";
import { executeTask } from "../src/runner.js";

const deprecatedCases = [
  ["--reasoning", ["ask", "--reasoning", "high", "--prompt", "test"]],
  ["--reasoning-map", ["compare", "--reasoning-map", "chatgpt=high", "--prompt", "test"]],
  ["--reasoning=value", ["ask", "--reasoning=high", "--prompt", "test"]],
];

for (const [label, args] of deprecatedCases) {
  test(`rejects disabled reasoning option ${label}`, async () => {
    await assert.rejects(
      () => main(args),
      (error) => error?.code === "REASONING_DISABLED",
    );
  });
}

test("compare replay returns nonzero for a partial batch without losing the successful result", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-"));
  try {
    const prompt = "Compare the smoke-test inputs.";
    const { task } = await executeTask({
      kind: "compare", providers: ["chatgpt", "gemini"], prompt: buildComparePrompt(prompt),
      workspace: "repo", requestId: "partial-example",
    }, {
      home,
      skipPreflight: true,
      runProcess: async (_command, args) => {
        const input = await readFile(args[args.indexOf("--input") + 1], "utf8");
        const output = args[args.indexOf("--output-dir") + 1];
        for (const line of input.trim().split("\n")) {
          const job = JSON.parse(line);
          const jobDir = path.join(output, job.id);
          const completed = job.provider === "chatgpt";
          await mkdir(jobDir, { recursive: true });
          if (completed) await writeFile(path.join(jobDir, "response.md"), "Sample answer");
          await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
            state: completed ? "completed" : "failed",
          }));
        }
        return { code: 1, spawnError: null };
      },
    });
    const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
    const options = { env: { ...process.env, WFA_HOME: home }, encoding: "utf8" };
    const result = spawnSync(process.execPath, [
      bin, "compare", "--providers", "chatgpt,gemini", "--workspace", "repo",
      "--request-id", "partial-example", "--prompt", prompt, "--json",
    ], options);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.replayed, true);
    assert.equal(summary.state, "partial");
    assert.equal(await readFile(summary.providers.chatgpt.result, "utf8"), "Sample answer");
    assert.equal(summary.providers.gemini.state, "failed");
    const inspection = spawnSync(process.execPath, [bin, "status", task.taskId, "--json"], options);
    assert.equal(inspection.status, 0);
    assert.equal(JSON.parse(inspection.stdout).state, "partial");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
