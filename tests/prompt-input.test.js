import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "wfa.js");

function run(args, { stdin, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 30000,
    stdio: [stdin ?? "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });
}

const dryAsk = (extra = []) => ["ask", "--provider", "chatgpt", "--workspace", "prompt-probe", "--dry-run", ...extra];

