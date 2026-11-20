import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
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

test("failure to signal a spawned process is not classified as a spawn failure", async (t) => {
  const failure = new Error("simulated failed termination");
  t.mock.method(ChildProcess.prototype, "kill", function () {
    this.emit("error", failure);
    return false;
  });

  const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
    timeoutMs: 150,
    killGraceMs: 100,
  });
  try {
    assert.equal(result.timedOut, true);
    assert.equal(result.spawnError, null);
    assert.equal(result.processError, failure);
    assert.ok(result.pid > 0);
  } finally {
    if (result.pid && result.code === null && !result.signal) {
      try { process.kill(result.pid); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
});


test("runProcess can provide a prompt on stdin while capturing streamed output", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write('received:'+s));"], {
    input: "provider-stdin-prompt",
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "received:provider-stdin-prompt");
});
