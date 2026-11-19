import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { executeTask } from "../src/runner.js";
import { updateAskBridge } from "../src/maintenance.js";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("updaters and task launches share a gate, including a live background helper", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-upstream-"));
  try {
    const store = new Store(home);
    const started = deferred();
    const finish = deferred();
    const update = updateAskBridge({}, store, async () => {
      started.resolve();
      await finish.promise;
      return { code: 0 };
    });
    const runTask = (runProcess) => executeTask({
      prompt: "Gate test", workspace: "repo", providers: ["chatgpt"],
    }, { home, store, skipPreflight: true, runProcess });
    const rejectLaunch = () => assert.rejects(
      () => runTask(() => assert.fail("must not launch during maintenance")),
      { code: "UPSTREAM_UPDATE_ACTIVE" },
    );

    try {
      await Promise.race([started.promise, update]);
      await rejectLaunch();
    } finally {
      finish.resolve();
    }
    await update;
    await store.transaction(({ tasks }) => {
      tasks.upstreamUpdate = { ownerPid: null, helperPid: process.pid };
    });
    await rejectLaunch();
    await store.transaction(({ tasks }) => { tasks.upstreamUpdate.helperPid = null; });

    const result = await runTask(async () => {
      await assert.rejects(
        () => updateAskBridge({}, store, () => assert.fail("must not update during a task")),
        { code: "UPSTREAM_UPDATE_BLOCKED" },
      );
      return { code: 1 };
    });
    assert.equal(result.task.state, "needs_recovery");
    assert.equal((await store.snapshot()).tasks.upstreamUpdate, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
