import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStallWatch } from "../src/stall-watch.js";

test("stall watcher detects terminal metadata rewrite when mtime is unchanged but size differs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-stall-mtime-"));
  try {
    let now = 1000;
    const watch = createStallWatch([{ id: "wfa-chatgpt-1", provider: "chatgpt" }], dir, 5, () => now);
    const jobDir = path.join(dir, "wfa-chatgpt-1");
    const metadataPath = path.join(jobDir, "metadata.json");
    const pinnedTime = new Date(1_700_000_000_000);

    await mkdir(jobDir);
    watch.progress("job wfa-chatgpt-1 running");
    await writeFile(metadataPath, JSON.stringify({ state: "in_progress" }));
    await utimes(metadataPath, pinnedTime, pinnedTime);

    assert.equal(await watch.check(), null);

    // Unchanged file must not reset the silence clock.
    now = 7000;
    const stalled = await watch.check();
    assert.ok(stalled?.chatgpt);
    assert.ok(stalled.chatgpt.silentSeconds >= 5);

    // Rewrite with terminal state while pinning the exact same mtime.
    await writeFile(metadataPath, JSON.stringify({ state: "completed" }));
    await utimes(metadataPath, pinnedTime, pinnedTime);

    assert.equal(await watch.check(), null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("stall watcher re-reads metadata when removed and recreated with identical content and mtime", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-stall-recreate-"));
  try {
    let now = 1000;
    const watch = createStallWatch([{ id: "wfa-chatgpt-1", provider: "chatgpt" }], dir, 5, () => now);
    const jobDir = path.join(dir, "wfa-chatgpt-1");
    const metadataPath = path.join(jobDir, "metadata.json");
    const pinnedTime = new Date(1_700_000_000_000);
    const payload = JSON.stringify({ state: "in_progress" });

    await mkdir(jobDir);
    await writeFile(metadataPath, payload);
    await utimes(metadataPath, pinnedTime, pinnedTime);

    assert.equal(await watch.check(), null);

    now = 7000;
    const stalled = await watch.check();
    assert.ok(stalled?.chatgpt);
    assert.equal(watch.snapshot()[0].idleSeconds, 6);

    // Remove metadata and observe the missing-file poll.
    await rm(metadataPath);
    now = 8000;
    const stalledWhileMissing = await watch.check();
    assert.ok(stalledWhileMissing?.chatgpt);

    // Recreate with identical content and mtime; must be re-read and reset silence clock.
    await writeFile(metadataPath, payload);
    await utimes(metadataPath, pinnedTime, pinnedTime);
    now = 9000;
    assert.equal(await watch.check(), null);
    assert.equal(watch.snapshot()[0].idleSeconds, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
