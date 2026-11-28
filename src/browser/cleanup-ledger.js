import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const LEDGER_FILENAME = "cleanup-deleted.json";

export function normalizeCleanupUrlKey(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
  try {
    const u = new URL(rawUrl.trim());
    let pathname = u.pathname;
    while (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    // Canonicalize Gemini /u/<n>/app/<id> -> /app/<id> so multi-account prefix never duplicates keys.
    if (u.hostname === "gemini.google.com") {
      const m = pathname.match(/^\/u\/\d+(\/app\/[^/]+)$/);
      if (m) pathname = m[1];
    }
    return `${u.origin}${pathname}`;
  } catch {
    let s = rawUrl.trim();
    while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  }
}

export function getDeletedLedgerPath(home) {
  return path.join(home, LEDGER_FILENAME);
}

export async function readDeletedLedger(home) {
  if (!home || typeof home !== "string") return {};
  try {
    const raw = await readFile(getDeletedLedgerPath(home), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}

export async function recordDeletedUrl(home, url, { provider = null, verified = true } = {}) {
  if (!home || typeof home !== "string") return false;
  const key = normalizeCleanupUrlKey(url);
  if (!key) return false;
  try {
    await mkdir(home, { recursive: true });
    const ledger = await readDeletedLedger(home);
    ledger[key] = {
      deletedAt: new Date().toISOString(),
      provider: provider ? String(provider).toLowerCase() : null,
      verified,
    };
    const targetPath = getDeletedLedgerPath(home);
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(tmpPath, targetPath);
    return true;
  } catch {
    return false;
  }
}
