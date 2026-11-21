import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

test("store transactions serialize concurrent writes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-store-"));
  try {
    const store = new Store(home);
    // 12 serialized transactions at a 50ms poll interval can exceed the 15s
    // default when the whole suite runs in parallel on a busy machine.
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.transaction(({ tasks }) => {
        tasks.tasks[`task-${index}`] = { taskId: `task-${index}` };
      }, 120000)
    ));
    const snapshot = await store.snapshot();
    assert.equal(Object.keys(snapshot.tasks.tasks).length, 12);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
