import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireInstanceLock } from "../src/broker/lifecycle.js";

const DEAD_PID = 2147483647;

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function createStaleLock(t) {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "wfa-instance-stale-")
  );

  t.after(() => fs.rm(home, {
    recursive: true,
    force: true,
  }));

  // Match the dead-PID fixture used by the existing broker lifecycle tests.
  assert.throws(
    () => process.kill(DEAD_PID, 0),
    { code: "ESRCH" }
  );

  const lockPath = path.join(home, "broker.lock");
  const stale = {
    pid: DEAD_PID,
    instanceId: "stale-owner",
  };

  await fs.writeFile(
    lockPath,
    JSON.stringify(stale) + "\n",
    "utf8"
  );

  return { home, lockPath, stale };
}

function pauseOwnerRead(t, lockPath, ordinal) {
  const originalReadFile = fs.readFile.bind(fs);
  const reached = deferred();
  const resume = deferred();

  let reads = 0;
  let paused = false;

  t.mock.method(fs, "readFile", async (...args) => {
    const raw = await originalReadFile(...args);

    if (!paused && args[0] === lockPath) {
      reads++;

      if (reads === ordinal) {
        paused = true;
        reached.resolve(raw);
        await resume.promise;
      }
    }

    return raw;
  });

  return {
    reached: reached.promise,
    resume: resume.resolve,
    originalReadFile,
  };
}

test("instance-lock: eight simultaneous contenders for one stale lock produce exactly one owner", {
  timeout: 10000,
}, async (t) => {
  const { home, lockPath } = await createStaleLock(t);

  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () => acquireInstanceLock(home)
    )
  );

  const winners = results.filter(Boolean);

  try {
    assert.equal(
      winners.length,
      1,
      "Exactly one contender may own the broker instance lock"
    );

    assert.equal(
      results.filter((result) => result === null).length,
      7
    );

    const owner = JSON.parse(
      await fs.readFile(lockPath, "utf8")
    );

    assert.deepEqual(owner, {
      pid: process.pid,
      instanceId: winners[0].instanceId,
    });

    assert.equal(
      await acquireInstanceLock(home),
      null,
      "A live owner must not be reclaimed"
    );

    const guardDir = path.join(
      home,
      "cdp-turn-locks-v2"
    );

    assert.deepEqual(
      await fs.readdir(guardDir),
      [],
      "Temporary recovery guard claims must be released"
    );
  } finally {
    await Promise.all(
      winners.map((lock) => lock.release())
    );
  }

  await assert.rejects(
    fs.access(lockPath),
    { code: "ENOENT" }
  );
});

test("instance-lock: an optimistic stale observation cannot overwrite a live successor", {
  timeout: 10000,
}, async (t) => {
  const { home, lockPath, stale } =
    await createStaleLock(t);

  // Stop contender A immediately after it has read the old owner,
  // but before it can acquire the reclamation guard.
  const barrier = pauseOwnerRead(t, lockPath, 1);

  const pendingA = acquireInstanceLock(home);
  let ownerB = null;
  let ownerC = null;

  try {
    const observed = JSON.parse(await barrier.reached);
    assert.deepEqual(observed, stale);

    // Contender B wins while A still holds the stale observation.
    ownerB = await acquireInstanceLock(home);
    assert.ok(ownerB);

    const published = JSON.parse(
      await barrier.originalReadFile(lockPath, "utf8")
    );

    assert.deepEqual(published, {
      pid: process.pid,
      instanceId: ownerB.instanceId,
    });

    // A resumes with stale data, then must re-read under the guard.
    barrier.resume();

    const ownerA = await pendingA;

    assert.equal(
      ownerA,
      null,
      "A stale observation must not authorize replacing B"
    );

    assert.deepEqual(
      JSON.parse(
        await barrier.originalReadFile(lockPath, "utf8")
      ),
      published,
      "B's live lock must remain intact"
    );

    await ownerB.release();

    ownerC = await acquireInstanceLock(home);
    assert.ok(ownerC);

    // A repeated release by an old owner must not affect its successor.
    await ownerB.release();

    assert.deepEqual(
      JSON.parse(
        await barrier.originalReadFile(lockPath, "utf8")
      ),
      {
        pid: process.pid,
        instanceId: ownerC.instanceId,
      }
    );
  } finally {
    barrier.resume();

    const ownerA = await pendingA;
    await ownerA?.release();
    await ownerB?.release();
    await ownerC?.release();
  }
});

test("instance-lock: the authoritative stale read and publication cannot be interleaved by another contender", {
  timeout: 10000,
}, async (t) => {
  const { home, lockPath, stale } =
    await createStaleLock(t);

  // Stop A after the second owner read. In the old implementation,
  // this is the final stale check immediately preceding fs.rm().
  // In the fixed implementation, A already owns the recovery guard.
  const barrier = pauseOwnerRead(t, lockPath, 2);

  const competingTicketPublished = deferred();
  const originalRename = fs.rename.bind(fs);

  let observeCompetingTicket = false;

  t.mock.method(fs, "rename", async (source, destination) => {
    const result = await originalRename(source, destination);

    if (
      observeCompetingTicket &&
      String(source).endsWith(".lock.ready") &&
      String(destination).endsWith(".lock")
    ) {
      competingTicketPublished.resolve();
    }

    return result;
  });

  const pendingA = acquireInstanceLock(home);
  let pendingB = null;

  try {
    const observed = JSON.parse(await barrier.reached);
    assert.deepEqual(observed, stale);

    observeCompetingTicket = true;

    pendingB = acquireInstanceLock(home);

    const firstEvent = await Promise.race([
      competingTicketPublished.promise.then(
        () => "ticket-published"
      ),
      pendingB.then(
        () => "contender-returned"
      ),
    ]);

    assert.equal(
      firstEvent,
      "ticket-published",
      "B must participate in the guard protocol instead of replacing the owner"
    );

    assert.deepEqual(
      JSON.parse(
        await barrier.originalReadFile(lockPath, "utf8")
      ),
      stale,
      "B must not publish a new owner while A holds the guard"
    );

    barrier.resume();

    const [ownerA, ownerB] = await Promise.all([
      pendingA,
      pendingB,
    ]);

    assert.ok(ownerA);
    assert.equal(ownerB, null);

    assert.deepEqual(
      JSON.parse(
        await barrier.originalReadFile(lockPath, "utf8")
      ),
      {
        pid: process.pid,
        instanceId: ownerA.instanceId,
      }
    );
  } finally {
    barrier.resume();

    const owners = await Promise.all([
      pendingA,
      pendingB ?? Promise.resolve(null),
    ]);

    await Promise.all(
      owners.filter(Boolean).map(
        (owner) => owner.release()
      )
    );
  }
});

test("instance-lock: an unreadable owner record cannot authorize reclamation", async (t) => {
  const { home, lockPath } = await createStaleLock(t);

  const corrupted = '{"pid":';

  await fs.writeFile(
    lockPath,
    corrupted,
    "utf8"
  );

  assert.equal(
    await acquireInstanceLock(home),
    null
  );

  assert.equal(
    await fs.readFile(lockPath, "utf8"),
    corrupted,
    "A malformed owner must not be silently overwritten"
  );
});
