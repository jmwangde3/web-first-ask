import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export function createStallWatch(jobs, outputDir, timeoutSeconds = 300, clock = () => Date.now()) {
  const observed = new Map(jobs.map((job) => [job.provider, {
    id: job.id, active: false, lastLife: clock(), lastProgressLine: null, metadataMtime: null,
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
      if (info?.isFile() && info.mtimeMs !== item.metadataMtime) {
        item.metadataMtime = info.mtimeMs;
        item.lastLife = now;
      }
      let state;
      if (info?.isFile()) {
        try { state = JSON.parse(await readFile(metadataPath, "utf8")).state; } catch {}
      }
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

  return { progress, check };
}
