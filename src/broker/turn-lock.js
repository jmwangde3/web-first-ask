// src/broker/turn-lock.js
// 会话级文件锁（需求6定稿）：
// 锁粒度：按 (provider, conversationId) 会话级互斥。
// 同一会话严格串行、不同会话完全并行、跨 provider 互不干扰；无会话 ID 则独立键互不阻塞。
// wx 排他创建 + pid 存活探测 + stale TTL 自愈；冲突排队，超时明确抛出 CONCURRENT_TURN_BUSY。
import { createHash, randomUUID } from "node:crypto";
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

function sanitizeKey(str) {
  return String(str || "").replace(/[^a-z0-9_-]/gi, "_");
}

function computeLockFileName(provider, conversationId) {
  const safeProvider = sanitizeKey(provider || "default");
  if (!conversationId) {
    // 无 conversationId 的新请求互不阻塞，使用独立 UUID
    return `cdp-turn-${safeProvider}-new-${randomUUID()}.lock`;
  }
  // 存在 conversationId 则按 hash 规整，确保跨平台文件名安全与严格互斥
  const hash = createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 16);
  return `cdp-turn-${safeProvider}-${hash}.lock`;
}

export async function acquireTurnLock(home, provider = "default", {
  timeoutMs = 900000, // 对齐 hardTimeoutMs (900s)
  pollIntervalMs = 200,
  staleTimeoutMs = 15 * 60 * 1000,
  turnId = null,
  conversationId = null,
  signal,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  const dir = getBrokerPaths(home).home;
  // 兼容老调用：若未显式传 conversationId，尝试从 turnId 兜底
  const convId = conversationId ?? turnId ?? null;
  const lockFileName = computeLockFileName(provider, convId);
  const lockPath = path.join(dir, lockFileName);
  await fs.mkdir(dir, { recursive: true });

  const lockId = randomUUID();
  const startTime = now();
  const deadline = startTime + timeoutMs;

  while (now() < deadline) {
    if (signal?.aborted) {
      const err = new Error("Operation cancelled while acquiring turn lock");
      err.code = "CANCELLED";
      throw err;
    }

    const payload = JSON.stringify({
      pid: process.pid,
      lockId,
      turnId,
      conversationId: convId,
      provider,
      acquiredAt: now(),
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
        const expired = now() - (current.acquiredAt || 0) > staleTimeoutMs;
        if (dead || expired) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (readErr) {
        if (readErr?.code === "ENOENT") continue;
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }

      await sleep(pollIntervalMs);
    }
  }

  const err = new Error(`Conversation ${convId || "new"} on provider ${provider} is busy executing another turn`);
  err.code = "CONCURRENT_TURN_BUSY";
  throw err;
}
