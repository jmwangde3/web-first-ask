import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { recoverBrowser } from "../src/browser/recovery.js";
import { readLock } from "../src/browser/lock.js";
import { findProfileOwner, isPidAlive, probeProfileLock,
  terminateProcessAndWait, waitForProcessExit } from "../src/browser/proc.js";

const keep = process.argv.includes("--keep");
const headful = process.argv.includes("--headful");
const home = await mkdtemp(path.join(os.tmpdir(), "wfa-browser-probe-"));
const lockPath = path.join(home, "browser.lock");
const profileDir = path.join(home, "chrome-profile");
const mode = headful ? "headful" : "headless";
const tracked = new Set();
let stage = "init";
let lastResult = null;
let failure = null;

async function awaitProfileFree() {
  const deadline = Date.now() + 3000;
  do {
    const owner = await findProfileOwner(profileDir);
    const status = await probeProfileLock(profileDir);
    if (!owner && status === "free") return;
    if (status === "unknown" || Date.now() >= deadline) {
      throw new Error(`Profile not released: lock=${status} owner=${owner?.pid ?? "none"}`);
    }
    await sleep(100);
  } while (true);
}

async function killTracked(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isPidAlive(pid)) return;
  await terminateProcessAndWait(pid, { force: true });
  assert.equal(await waitForProcessExit(pid, 3000), true, `Chrome PID ${pid} remains alive`);
}

try {
  stage = "cold-start";
  lastResult = await recoverBrowser({ home, hasUncollectedWork: false, mode });
  assert.equal(lastResult.action, "SAFE_START", JSON.stringify(lastResult));
  assert.ok(lastResult.chrome?.pid);
  const firstPid = lastResult.chrome.pid;
  tracked.add(firstPid);
  let disk = await readLock(lockPath);
  assert.equal(disk.status, "ok");
  assert.equal(disk.lock.phase, "ready");
  assert.equal(disk.lock.chromePid, firstPid);

  stage = "adopt";
  const impossiblePid = 2147483600;
  assert.equal(isPidAlive(impossiblePid), false);
  await writeFile(lockPath, `${JSON.stringify({ ...disk.lock, brokerPid: impossiblePid }, null, 2)}\n`, "utf8");
  lastResult = await recoverBrowser({ home, hasUncollectedWork: false, mode });
  assert.equal(lastResult.action, "ADOPT", JSON.stringify(lastResult));
  assert.equal(lastResult.chrome?.pid, firstPid);
  assert.equal((await findProfileOwner(profileDir))?.pid, firstPid,
    "Adoption must reuse the same Chrome root process");

  stage = "restart-after-cdp-loss";
  lastResult = await recoverBrowser({ home, hasUncollectedWork: false, mode,
    probes: { readDevToolsActivePort: async () => null } });
  assert.equal(lastResult.action, "SAFE_START", JSON.stringify(lastResult));
  assert.equal(lastResult.reason, "cdp_unreachable_no_work");
  assert.ok(lastResult.chrome?.pid > 0);
  const secondPid = lastResult.chrome.pid;
  tracked.add(secondPid);
  assert.notEqual(secondPid, firstPid, "Restart must replace the old Chrome root process");
  assert.equal(isPidAlive(firstPid), false, "Old Chrome must have exited before restart");
  disk = await readLock(lockPath);
  assert.equal(disk.status, "ok");
  assert.equal(disk.lock.phase, "ready");
  assert.equal(disk.lock.chromePid, secondPid);

  stage = "abandoned-launch";
  await killTracked(secondPid);
  await awaitProfileFree();
  const abandoned = {
    ...disk.lock, phase: "launching", chromePid: null, chromeStartedAt: null,
    actualDebugPort: null, brokerStartedAt: new Date().toISOString(),
  };
  await writeFile(lockPath, `${JSON.stringify(abandoned, null, 2)}\n`, "utf8");
  lastResult = await recoverBrowser({ home, hasUncollectedWork: false, mode });
  assert.equal(lastResult.action, "SAFE_START", JSON.stringify(lastResult));
  assert.ok(lastResult.chrome?.pid > 0);
  tracked.add(lastResult.chrome.pid);
  assert.notEqual(lastResult.chrome.pid, secondPid);
  disk = await readLock(lockPath);
  assert.equal(disk.status, "ok");
  assert.equal(disk.lock.phase, "ready");
  assert.equal(disk.lock.chromePid, lastResult.chrome.pid);

  stage = "phase-less-lock";
  const { phase, ...withoutPhase } = disk.lock;
  await writeFile(lockPath, `${JSON.stringify(withoutPhase, null, 2)}\n`, "utf8");
  assert.equal((await readLock(lockPath)).status, "corrupt");
  lastResult = await recoverBrowser({ home, hasUncollectedWork: false, mode });
  assert.equal(lastResult.action, "RECOVERY_REQUIRED", JSON.stringify(lastResult));
  assert.equal(lastResult.reason, "lock_corrupt");
  assert.equal(lastResult.chrome, null);
  assert.equal(isPidAlive(disk.lock.chromePid), true, "Corrupt lock must not terminate Chrome");
  await writeFile(lockPath, `${JSON.stringify(disk.lock, null, 2)}\n`, "utf8");
} catch (error) {
  failure = error;
  console.error(JSON.stringify({ stage, error: error?.stack ?? String(error), lastResult, home }, null, 2));
} finally {
  if (keep) {
    console.log(`KEPT ${home}`);
  } else {
    stage = "cleanup";
    for (const pid of tracked) {
      try {
        await killTracked(pid);
      } catch (error) {
        failure ??= error;
        console.error(JSON.stringify({ stage, pid, error: error?.message ?? String(error) }));
      }
    }
    try {
      await awaitProfileFree();
      let cleaned = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await rm(home, { recursive: true, force: true });
          cleaned = true;
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await sleep(200);
        }
      }
      assert.ok(cleaned);
      await readFile(lockPath).then(() => { throw new Error("Temporary directory remains"); },
        (error) => { if (error?.code !== "ENOENT") throw error; });
    } catch (error) {
      failure ??= error;
      console.error(JSON.stringify({ stage, error: error?.message ?? String(error), home }));
    }
  }
}
if (failure) process.exitCode = 1;
else console.log("OK");
