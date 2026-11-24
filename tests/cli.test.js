import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("--version answers before any store, config or provider work", async () => {
  const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-version-"));
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const run = spawnSync(process.execPath, [bin, "--version"], {
      env: { ...process.env, WFA_HOME: home, NODE_OPTIONS: "" }, encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), `wfa ${pkg.version}`);
    // No store was created just to print a version.
    assert.deepEqual(await readdir(home).catch(() => []), []);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

