import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getHomeDir } from "../paths.js";

export function hashPrompt(prompt) {
  return createHash("sha256").update(String(prompt ?? "")).digest("hex");
}

export function getJournalDir(home) {
  return path.join(home || getHomeDir(), "turns");
}

export async function recordCommit(home, { turnId, provider, promptSha256, conversationId, submittedAt } = {}) {
  if (!turnId || typeof turnId !== "string") {
    throw new Error("INVALID_TURN_ID");
  }
  const dir = getJournalDir(home);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${turnId}.json`);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const record = {
    schema: 1,
    turnId,
    provider: provider ?? "unknown",
    promptSha256: promptSha256 ?? "",
    conversationId: conversationId ?? null,
    submittedAt: submittedAt ?? new Date().toISOString(),
  };
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await rename(temporary, target);
        return record;
      } catch (err) {
        if (attempt || !["EPERM", "EBUSY"].includes(err?.code)) throw err;
        await sleep(50);
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function clearCommit(home, turnId) {
  if (!turnId) return;
  const target = path.join(getJournalDir(home), `${turnId}.json`);
  try {
    await rm(target, { force: true });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export async function readCommit(home, turnId) {
  if (!turnId || typeof turnId !== "string" ||
      turnId.includes("/") || turnId.includes("\\") || turnId.includes("..")) {
    return null;
  }
  const target = path.join(getJournalDir(home), `${turnId}.json`);
  try {
    const content = await readFile(target, "utf8");
    const record = JSON.parse(content);
    if (record?.schema === 1 && record?.turnId === turnId && record?.provider && record?.promptSha256 && record?.submittedAt) {
      return record;
    }
    return null;
  } catch {
    return null;
  }
}

export async function listOrphans(home) {
  const dir = getJournalDir(home);
  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const orphans = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      const record = JSON.parse(content);
      if (record?.schema === 1 && record?.turnId && record?.provider && record?.promptSha256 && record?.submittedAt) {
        orphans.push(record);
      }
    } catch {
      // Ignored: a truncated journal file must not crash the broker
    }
  }
  orphans.sort((a, b) => {
    const timeA = typeof a.submittedAt === "number" ? a.submittedAt : Date.parse(a.submittedAt);
    const timeB = typeof b.submittedAt === "number" ? b.submittedAt : Date.parse(b.submittedAt);
    const tA = Number.isFinite(timeA) ? timeA : 0;
    const tB = Number.isFinite(timeB) ? timeB : 0;
    return tA - tB;
  });
  return orphans;
}

// Same-conversation test for the orphan gate. An orphan only blocks a
// retry when the conversation identity is the same — or unknown on either
// side. Unknown stays conservative: a turn submitted without a
// conversation key, or an orphan recorded before keys were stored, must
// still block, because it might be the same conversation and the prompt
// must never be auto-resent while its submission is uncertain.
function sameConversation(stored, queried) {
  const s = typeof stored === "string" && stored.trim() ? stored : null;
  const q = typeof queried === "string" && queried.trim() ? queried : null;
  if (s === null || q === null) return true;
  return s === q;
}

export async function findCommitted(home, { provider, promptSha256, conversationId } = {}) {
  if (!provider || !promptSha256) return null;
  const orphans = await listOrphans(home);
  for (const orphan of orphans) {
    if (orphan.provider === provider && orphan.promptSha256 === promptSha256 &&
        sameConversation(orphan.conversationId, conversationId)) {
      return orphan;
    }
  }
  return null;
}
