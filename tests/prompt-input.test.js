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

test("a positional argument is used as the prompt", () => {
  const result = run(dryAsk(["positional prompt text"]));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"promptBytes"/);
  assert.doesNotMatch(result.stderr, /Provide --prompt/);
});

test("piped stdin is still read as the prompt", () => {
  const result = run(dryAsk(), { input: "piped prompt text" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"promptBytes"/);
});

test("a stdin that never closes fails fast instead of hanging", () => {
  // A detached worker's stdin is not a pipe: no data, no EOF. Before this
  // guard the CLI waited forever and printed nothing.
  const started = Date.now();
  const result = run(dryAsk(), { stdin: "ignore" });
  const elapsed = Date.now() - started;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide --prompt/);
  assert.ok(elapsed < 20000, `expected a fast failure, took ${elapsed}ms`);
});
