import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/ask-bridge.js";

test("local process watchdog terminates a stuck child and reports timeout", async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    timeoutMs: 50,
    killGraceMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2000);
});

test("process wait settles after main child exits when a descendant keeps inherited stdio open", async () => {
  const descendantScript = "setTimeout(() => process.exit(0), 1200)";
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "inherit", detached: true });`,
    'process.stdout.write("parent-finished\\n");',
    "setTimeout(() => process.exit(0), 30);",
  ].join("\n");

  const result = await runProcess(process.execPath, ["-e", parentScript], {
    timeoutMs: 5000,
    drainGraceMs: 100,
  });

  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdioDrainTimedOut, true);
  assert.match(result.stdout, /parent-finished/);
});
