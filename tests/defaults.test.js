import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { executeTask } from "../src/runner.js";

const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));

async function withHome(prefix, fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function dryRunCli(home, args) {
  const run = spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, WFA_HOME: home },
    encoding: "utf8",
  });
  return { status: run.status, stderr: run.stderr, preview: run.stdout ? JSON.parse(run.stdout) : null };
}

test("config defaults to both providers, serial execution and a single login provider", async () => {
  await withHome("wfa-defaults-", async (home) => {
    const config = await loadConfig(home);
    assert.deepEqual(config.defaultProviders, ["gemini", "chatgpt"]);
    // compare must not silently prefer a different first provider than ask.
    assert.deepEqual(config.defaultCompareProviders, ["gemini", "chatgpt"]);
    assert.equal(config.defaultConcurrency, 2);
    assert.equal(config.defaultProvider, "chatgpt");
    // Gemini runs in Task mode by default, so the pair is "gemini task + chatgpt".
    assert.equal(config.geminiMode, "task");

    await writeFile(path.join(home, "config.json"), JSON.stringify({
      defaultProviders: "claude,chatgpt",
      defaultConcurrency: 2,
    }));
    const overridden = await loadConfig(home);
    assert.deepEqual(overridden.defaultProviders, ["claude", "chatgpt"]);
    assert.equal(overridden.defaultConcurrency, 2);
  });
});

function dryRunCliWithFiles(home, paths) {
  const args = ["ask", "--provider", "chatgpt", "--prompt", "x", "--dry-run"];
  for (const filePath of paths) args.push("--file", filePath);
  return dryRunCli(home, args);
}

