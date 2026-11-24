import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getBrokerPaths } from "./lifecycle.js";

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A permission or unexpected probe error is not proof of death.
    return error?.code !== "ESRCH";
  }
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

// Each contender owns a unique file for its entire lifetime. An empty record
// means "choosing a ticket"; a complete record is published by atomic rename.
// This is a filesystem-backed bakery lock on a local filesystem. No contender
// ever deletes a reusable shared pathname based on a stale read.
async function readClaim(dir, name, pid) {
  const file = path.join(dir, name);
  if (!pidAlive(pid)) {
    await fs.rm(file, { force: true });
    await fs.rm(`${file}.ready`, { force: true });
    return null;
  }
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!raw.trim()) return { choosing: true };
  const record = JSON.parse(raw);
  if (record.pid !== pid || !Number.isSafeInteger(record.ticket) || record.ticket < 1) {
    throw coded("TURN_LOCK_CORRUPT", `Invalid lock claim ${name}`);
  }
  return record;
}

export async function acquireTurnLock(home, provider = "default", {
  timeoutMs = 900000,
  pollIntervalMs = 200,
  turnId = null,
  conversationId = null,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw coded("INVALID_ARGUMENT", "Invalid turn lock timing");
  }
  const providerKey = String(provider).toLowerCase();
  const convId = typeof conversationId === "string" && conversationId.trim()
    ? conversationId : null;
  const lockId = randomUUID();
  const identity = convId === null
    ? [providerKey, "anonymous", lockId]
    : [providerKey, "named", convId];
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const dir = path.join(getBrokerPaths(home).home, "cdp-turn-locks-v2");
  const prefix = `${key}-`;
  const ownName = `${prefix}${process.pid}-${lockId}.lock`;
  const lockPath = path.join(dir, ownName);
  const readyPath = `${lockPath}.ready`;
  const deadline = now() + timeoutMs;
  let created = false;
  let acquired = false;

  function check() {
    if (signal?.aborted) throw coded("CANCELLED", "Operation cancelled while acquiring turn lock");
    if (now() >= deadline) {
      throw coded("CONCURRENT_TURN_BUSY", `Conversation ${convId || "new"} on provider ${providerKey} is busy executing another turn`);
    }
  }

  async function contenders({ reapOtherKeys = false } = {}) {
    const names = await fs.readdir(dir);
    const claims = [];
    for (const name of names) {
      if (name === ownName) continue;
      const match = /^([0-9a-f]{64})-(\d+)-[0-9a-f-]{36}\.lock$/i.exec(name);
      if (!match) continue;
      const pid = Number(match[2]);
      if (name.startsWith(prefix)) claims.push({ name, pid });
      else if (reapOtherKeys && !pidAlive(pid)) {
        // Also reap dead anonymous/retired keys that may never recur.
        const file = path.join(dir, name);
        await fs.rm(file, { force: true });
        await fs.rm(`${file}.ready`, { force: true });
      }
    }
    return claims;
  }

  try {
    check();
    await fs.mkdir(dir, { recursive: true });
    const handle = await fs.open(lockPath, "wx", 0o600);
    created = true;
    await handle.close();

    // Publish choosing before taking a ticket. Ties are broken by the
    // immutable contender name, not clock time or filesystem timestamps.
    let highest = 0;
    for (const { name, pid } of await contenders({ reapOtherKeys: true })) {
      check();
      const claim = await readClaim(dir, name, pid);
      if (claim && !claim.choosing) highest = Math.max(highest, claim.ticket);
    }
    if (highest >= Number.MAX_SAFE_INTEGER) {
      throw coded("TURN_LOCK_CORRUPT", "Turn lock ticket exhausted");
    }
    const ticket = highest + 1;
    await fs.writeFile(readyPath, JSON.stringify({
      pid: process.pid, lockId, turnId, conversationId: convId,
      provider: providerKey, ticket, acquiredAt: Date.now(),
    }) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(readyPath, lockPath);

    for (;;) {
      check();
      let blocked = false;
      for (const { name, pid } of await contenders()) {
        check();
        const claim = await readClaim(dir, name, pid);
        if (!claim) continue;
        if (claim.choosing || claim.ticket < ticket ||
            (claim.ticket === ticket && name < ownName)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
    check();
    acquired = true;
    let released = false;
    return {
      lockId,
      lockPath,
      async release() {
        if (released) return;
        // The pathname is unique to this acquisition, even after release.
        await fs.rm(lockPath, { force: true });
        released = true;
      },
    };
  } finally {
    if (created && !acquired) {
      await fs.rm(readyPath, { force: true }).finally(() => fs.rm(lockPath, { force: true }));
    }
  }
}
