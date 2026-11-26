import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { WfaError } from "../errors.js";

// F4 — download attachments produced by providers.
//
// Upload (D3) and download are separate paths; this module only handles the
// download side: enable the browser download behavior, click a provider
// download control (via the adapter hook), capture the file that lands in a
// directory, and verify it by size and SHA-256.
//
// Turn-record shape: a captured download is one entry of the existing
// `downloads` field (an array, `null` when nothing was captured). One entry:
//   { fileName, path, sizeBytes, sha256, provider, downloadedAt }
// No parallel record is invented; see buildDownloadRecord().
// Wiring that is NOT in this module (owned by the engine/broker):
//   - `runCdpTurn` must accept a download directory, call
//     downloadFromProvider() after completion, and return `downloads`;
//   - the broker must copy `result.downloads` into the finished turn
//     (src/broker/server.js runTurn currently only copies text/reason/
//     evidence/conversationUrl/targetId/sendCommittedAt).
// Until that wiring lands, the helper below is usable standalone and the
// turn store already persists `downloads` when present.

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000;
export const DEFAULT_DOWNLOAD_POLL_MS = 250;

const DOWNLOAD_TEMP_SUFFIXES = [".crdownload", ".part", ".download", ".tmp"];

export function isTempDownloadName(fileName) {
  const lower = String(fileName).toLowerCase();
  return DOWNLOAD_TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function buildDownloadRecord({ fileName, path: filePath, sizeBytes, sha256, provider = null }) {
  return {
    fileName,
    path: filePath,
    sizeBytes,
    sha256,
    provider,
    downloadedAt: new Date().toISOString(),
  };
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

// Size/hash verification of a captured file. Expected values are optional:
// with neither given this only proves the file exists, is a file, and hashes.
export async function verifyDownloadedFile(filePath, {
  expectedSizeBytes = null,
  expectedSha256 = null,
} = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch (err) {
    throw new WfaError("DOWNLOAD_VERIFY_FAILED", `Downloaded file is not readable: ${filePath}`, {
      details: { message: err?.message || String(err) },
    });
  }
  if (!info?.isFile()) {
    throw new WfaError("DOWNLOAD_VERIFY_FAILED", `Downloaded path is not a file: ${filePath}`);
  }
  const sha256 = await sha256File(filePath);
  if (expectedSizeBytes != null && info.size !== expectedSizeBytes) {
    throw new WfaError("DOWNLOAD_VERIFY_FAILED",
      `Download size mismatch for ${path.basename(filePath)}: expected ${expectedSizeBytes} bytes, got ${info.size}`, {
        details: { fileName: path.basename(filePath), expectedSizeBytes, sizeBytes: info.size, sha256 },
      });
  }
  if (expectedSha256 != null && sha256 !== String(expectedSha256).toLowerCase()) {
    throw new WfaError("DOWNLOAD_VERIFY_FAILED",
      `Download hash mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${sha256}`, {
        details: { fileName: path.basename(filePath), expectedSha256, sizeBytes: info.size, sha256 },
      });
  }
  return {
    fileName: path.basename(filePath),
    path: path.resolve(filePath),
    sizeBytes: info.size,
    sha256,
  };
}

// Page.setDownloadBehavior is target-session scoped, which fits this
// codebase's CDP client (send(method, params, sessionId)); newer Chrome
// builds removed it, so fall back to the browser-level
// Browser.setDownloadBehavior (default browser context, no session).
export async function enableDownloadBehavior(cdp, sessionId, downloadPath, {
  mkdir: makeDir = mkdir,
} = {}) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new WfaError("DOWNLOAD_CAPTURE_FAILED", "A CDP client is required to enable downloads");
  }
  const absolute = path.resolve(downloadPath);
  await makeDir(absolute, { recursive: true });
  try {
    await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: absolute }, sessionId);
    return { downloadPath: absolute, method: "Page.setDownloadBehavior" };
  } catch (pageErr) {
    try {
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: absolute });
      return { downloadPath: absolute, method: "Browser.setDownloadBehavior" };
    } catch (browserErr) {
      throw new WfaError("DOWNLOAD_CAPTURE_FAILED",
        `Could not enable downloads via Page or Browser.setDownloadBehavior: ${browserErr?.message || pageErr?.message || "unknown"}`, {
          details: {
            pageError: pageErr?.message || String(pageErr),
            browserError: browserErr?.message || String(browserErr),
          },
        });
    }
  }
}

export async function snapshotDownloadDir(downloadDir, {
  readdir: readDir = readdir,
  stat: statFile = stat,
} = {}) {
  const snapshot = new Map();
  let names;
  try {
    names = await readDir(downloadDir);
  } catch {
    return snapshot;
  }
  for (const name of names) {
    try {
      const info = await statFile(path.join(downloadDir, name));
      if (info?.isFile?.()) snapshot.set(name, { size: info.size, mtimeMs: info.mtimeMs });
    } catch {}
  }
  return snapshot;
}

// Wait for a file that was not in `before` (or changed since) to appear and
// stay the same size across two consecutive polls. In-progress Chrome
// downloads live in `*.crdownload` and are ignored until the final file
// appears; a file that never stabilises is a timeout, not a success.
export async function waitForDownloadedFile(downloadDir, {
  before = new Map(),
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_DOWNLOAD_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  readdir: readDir = readdir,
  stat: statFile = stat,
} = {}) {
  const deadline = now() + timeoutMs;
  const stable = new Map();
  while (now() < deadline) {
    let names;
    try {
      names = await readDir(downloadDir);
    } catch (err) {
      throw new WfaError("DOWNLOAD_CAPTURE_FAILED", `Cannot list download directory ${downloadDir}: ${err?.message || String(err)}`);
    }
    for (const name of [...names].sort()) {
      if (isTempDownloadName(name)) continue;
      let info;
      try {
        info = await statFile(path.join(downloadDir, name));
      } catch {
        continue;
      }
      if (!info?.isFile?.() || info.size <= 0) continue;
      const prev = before.get(name);
      if (prev && prev.size === info.size && prev.mtimeMs === info.mtimeMs) continue;
      if (stable.get(name) === info.size) {
        return { fileName: name, path: path.join(downloadDir, name), sizeBytes: info.size };
      }
      stable.set(name, info.size);
    }
    await sleep(pollIntervalMs);
  }
  throw new WfaError("DOWNLOAD_TIMEOUT", `No new download appeared in ${downloadDir} within ${timeoutMs}ms`);
}

// Full F4 flow: enable download behavior, click the provider's download
// control via the adapter hook, capture the landed file, verify it.
// Throws DOWNLOAD_NOT_SUPPORTED when the adapter has no download hook,
// DOWNLOAD_CONTROL_NOT_FOUND when nothing was clicked, DOWNLOAD_TIMEOUT
// when no file lands, and DOWNLOAD_VERIFY_FAILED on a size/hash mismatch.
// Never returns a record for a file that was not captured and verified.
export async function downloadFromProvider(cdp, sessionId, adapter, {
  downloadDir,
  fileName = null,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_DOWNLOAD_POLL_MS,
  expectedSizeBytes = null,
  expectedSha256 = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  signal,
} = {}) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new WfaError("DOWNLOAD_CAPTURE_FAILED", "A CDP client is required to download a provider attachment");
  }
  if (typeof adapter?.buildDownloadClickJs !== "function") {
    throw new WfaError("DOWNLOAD_NOT_SUPPORTED", `Provider ${adapter?.id || "unknown"} does not expose a download control hook`);
  }
  if (!downloadDir || typeof downloadDir !== "string") {
    throw new WfaError("DOWNLOAD_CAPTURE_FAILED", "A download directory is required to capture a provider attachment");
  }
  if (signal?.aborted) {
    const err = new Error("Operation cancelled");
    err.code = "CANCELLED";
    throw err;
  }

  const { downloadPath } = await enableDownloadBehavior(cdp, sessionId, downloadDir);
  const before = await snapshotDownloadDir(downloadPath);

  const clickRes = await cdp.send("Runtime.evaluate", {
    expression: adapter.buildDownloadClickJs(fileName),
    returnByValue: true,
  }, sessionId);
  const clicked = clickRes?.result?.value;
  if (!clicked?.clicked) {
    throw new WfaError("DOWNLOAD_CONTROL_NOT_FOUND",
      `No download control${fileName ? ` for ${fileName}` : ""} found for ${adapter?.id || "unknown"}${clicked?.reason ? `: ${clicked.reason}` : ""}`, {
        details: { matchedCount: clicked?.matchedCount ?? 0, reason: clicked?.reason ?? null },
      });
  }

  const found = await waitForDownloadedFile(downloadPath, {
    before, timeoutMs, pollIntervalMs, sleep, now,
  });
  const verified = await verifyDownloadedFile(found.path, { expectedSizeBytes, expectedSha256 });
  return buildDownloadRecord({ ...verified, provider: adapter?.id || null });
}
