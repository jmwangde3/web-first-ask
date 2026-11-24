// Turn 级文件锁（三方裁决 2026-11-24）：防止多个独立 wfa cdp ask 进程
// 共用同一 native Chrome profile / 登录态时互相导航、污染页面。
// wx 排他创建 + pid 存活探测 + stale TTL 自愈；冲突排队，超时明确报错，绝不静默抢占。
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getBrokerPaths } from "./lifecycle.js";

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireTurnLock(home, provider = "default", {
  timeoutMs = 120000,
  pollIntervalMs = 200,
  staleTimeoutMs = 15 * 60 * 1000,
  turnId = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const dir = getBrokerPaths(home).home;
  const lockPath = path.join(dir, `cdp-turn-${String(provider).replace(/[^a-z0-9_-]/gi, "_")}.lock`);
  await fs.mkdir(dir, { recursive: true });

  const lockId = randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const payload = JSON.stringify({
      pid: process.pid,
      lockId,
      turnId,
      provider,
      acquiredAt: Date.now(),
    }) + "\n";

    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        lockId,
        lockPath,
        async release() {
          if (released) return;
          released = true;
          try {
            const raw = await fs.readFile(lockPath, "utf8");
            const data = JSON.parse(raw);
            if (data.lockId === lockId) {
              await fs.rm(lockPath, { force: true });
            }
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      // 锁被占用：检查 stale（pid 已死或超过 TTL）则安全清理后重试
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const current = JSON.parse(raw);
        const dead = !pidAlive(current.pid);
        const expired = Date.now() - (current.acquiredAt || 0) > staleTimeoutMs;
        if (dead || expired) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (readErr) {
        if (readErr?.code === "ENOENT") continue;
        // 锁文件损坏，清理后重试
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      await sleep(pollIntervalMs);
    }
  }

  const err = new Error(`Provider ${provider} is busy executing another turn`);
  err.code = "CONCURRENT_TURN_BUSY";
  throw err;
}
