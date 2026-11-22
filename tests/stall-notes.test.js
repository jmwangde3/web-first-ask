import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { refreshTask } from "../src/runner.js";

test("refreshTask records the PID when it sends SIGTERM to a stalled detached child", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-stall-note-"));
  const oldBrowserLog = process.env.ASK_BRIDGE_BROWSER_LOG;
  const fakePid = 88776655;
  const signals = [];
  const realKill = process.kill.bind(process);

  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === fakePid) {
      if (signal === "SIGTERM") signals.push(pid);
      return true;
    }
    return realKill(pid, signal);
  });

  process.env.ASK_BRIDGE_BROWSER_LOG = path.join(home, "nonexistent-browser.log");

  try {
    const store = new Store(home);
    const runDir = path.join(home, "runs", "detached-stall-test");
    const outputDir = path.join(runDir, "ask-bridge-output");
    const jobId = "wfa-chatgpt-stall-test";
    const metadataPath = path.join(outputDir, jobId, "metadata.json");
    const oldTime = new Date(Date.now() - 120000);

    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify({
      id: jobId,
      provider: "chatgpt",
      state: "in_progress",
    }), "utf8");
    await utimes(metadataPath, oldTime, oldTime);

    await store.transaction(({ tasks }) => {
      tasks.tasks["detached-stall-test"] = {
        taskId: "detached-stall-test",
        workspace: "stall-demo",
        kind: "ask",
        state: "running",
        createdAt: oldTime.toISOString(),
        runDir,
        outputDir,
        detached: true,
        serialWorker: false,
        executionPending: true,
        childPid: fakePid,
        stallTimeoutSeconds: 1,
        children: {
          chatgpt: {
            provider: "chatgpt",
            jobId,
            state: "running",
            watchLastLifeAt: oldTime.toISOString(),
          },
        },
      };
    });

    const refreshed = await refreshTask("detached-stall-test", { home, store });
    assert.deepEqual(signals, [fakePid]);
    assert.deepEqual(refreshed.killedStalledPids, [fakePid]);
    assert.equal(refreshed.children.chatgpt.state, "stalled");

    const saved = (await store.snapshot()).tasks.tasks["detached-stall-test"];
    assert.deepEqual(saved.killedStalledPids, [fakePid]);

    // Once the child is recorded as stalled, another refresh must not
    // send another termination signal or duplicate the recorded PID.
    const again = await refreshTask("detached-stall-test", { home, store });
    assert.deepEqual(signals, [fakePid]);
    assert.deepEqual(again.killedStalledPids, [fakePid]);

    // The note survives serialization, not just the returned object.
    const ledger = JSON.parse(await readFile(path.join(home, "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks["detached-stall-test"].killedStalledPids, [fakePid]);
  } finally {
    if (oldBrowserLog === undefined) delete process.env.ASK_BRIDGE_BROWSER_LOG;
    else process.env.ASK_BRIDGE_BROWSER_LOG = oldBrowserLog;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
