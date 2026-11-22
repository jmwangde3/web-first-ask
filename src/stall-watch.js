import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// Milliseconds since ask-bridge last wrote to its browser log, or null when the
// file is unavailable. Used as a veto: silence in wfa's own output during a long
// generation is normal, silence in this log is not.
export async function browserIdleMs(logPath, now = Date.now()) {
  if (!logPath) return null;
  const info = await stat(logPath).catch(() => null);
  if (!info?.isFile()) return null;
  return Math.max(0, now - info.mtimeMs);
}

// A stall is only real when the browser is quiet too. `null` idle (no log at
// all) keeps the original behaviour: silence in wfa's output is all we have.
// The window is fixed rather than tied to --stall-timeout: while a page
// generates, ask-bridge writes this log every ~200 ms, so two quiet minutes is
// already a strong signal, and a long --stall-timeout must not widen it.
export const BROWSER_QUIET_WINDOW_SECONDS = 120;

export function browserStillWorking(idleMs, windowSeconds = BROWSER_QUIET_WINDOW_SECONDS) {
  return idleMs !== null && idleMs < windowSeconds * 1000;
}

export function createStallWatch(jobs, outputDir, timeoutSeconds = 300, clock = () => Date.now()) {
  const observed = new Map(jobs.map((job) => [job.provider, {
    id: job.id, active: false, lastLife: clock(), lastProgressLine: null,
    metadataMtime: null, metadataState: undefined,
  }]));

  function progress(line) {
    const message = String(line);
    for (const item of observed.values()) {
      if (!message.includes(item.id)) continue;
      item.lastLife = clock();
      item.lastProgressLine = message.slice(0, 500);
      if (/\brunning\b|\bstarted\b|\bin_progress\b/i.test(message)) item.active = true;
    }
  }

  async function check() {
    if (!timeoutSeconds) return null;
    const now = clock();
    const stalled = {};
    for (const [provider, item] of observed) {
      const metadataPath = path.join(outputDir, item.id, "metadata.json");
      const info = await stat(metadataPath).catch(() => null);
      const exists = info?.isFile();
      if (exists && info.mtimeMs !== item.metadataMtime) {
        item.metadataMtime = info.mtimeMs;
        item.lastLife = now;
        try {
          item.metadataState = JSON.parse(await readFile(metadataPath, "utf8")).state;
        } catch {
          item.metadataState = undefined;
        }
      }
      // A missing file must not reuse a cached terminal state.
      const state = exists ? item.metadataState : undefined;
      if (["completed", "failed", "timed_out", "recoverable", "cancelled"].includes(state)) {
        item.active = false;
        continue;
      }
      if (["in_progress", "running"].includes(state)) item.active = true;
      if (item.active && now - item.lastLife >= timeoutSeconds * 1000) {
        stalled[provider] = {
          lastProgressLine: item.lastProgressLine,
          silentSeconds: Math.floor((now - item.lastLife) / 1000),
          metadataMtime: item.metadataMtime,
        };
      }
    }
    return Object.keys(stalled).length ? stalled : null;
  }

  // A run that prints nothing for ten minutes is indistinguishable from a dead
  // one, because ask-bridge emits no lines while a page generates. Report the
  // silence instead of letting the caller guess.
  function snapshot() {
    const now = clock();
    return [...observed.entries()].map(([provider, item]) => ({
      provider, active: item.active, idleSeconds: Math.floor((now - item.lastLife) / 1000),
    }));
  }

  return { progress, check, snapshot };
}
