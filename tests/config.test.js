import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("legacy defaultReasoning config is ignored", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-config-"));
  try {
    await writeFile(path.join(home, "config.json"), JSON.stringify({
      defaultProvider: "gemini",
      defaultReasoning: { chatgpt: "high" },
    }), "utf8");

    const config = await loadConfig(home);
    assert.equal(config.defaultProvider, "gemini");
    assert.equal(Object.hasOwn(config, "defaultReasoning"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});