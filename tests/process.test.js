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
