import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  enforceDensityBudget,
  recordDensityAction,
  resolveDensityConfig,
  isDensityGuardEnabled,
  getDensityStorePath,
  DEFAULT_DENSITY_WINDOW_MS,
  DEFAULT_DENSITY_MAX_PER_WINDOW,
} from "../src/browser/density-guard.js";

test("density-guard: disabled by default under node --test unless explicitly enabled", () => {
  assert.equal(isDensityGuardEnabled(), false, "must auto-disable under node --test without NODE_ENV=test");
  assert.equal(isDensityGuardEnabled({ enabled: true }), true);
  assert.equal(isDensityGuardEnabled({ enabled: false }), false);
});

test("density-guard: allows concurrent big tasks within budget with zero wait and throttles short-window burst", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-density-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.deepEqual(resolveDensityConfig(), {
    windowMs: DEFAULT_DENSITY_WINDOW_MS,
    maxPerWindow: DEFAULT_DENSITY_MAX_PER_WINDOW,
  });

  let clock = 1_000_000;
  const now = () => clock;
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); clock += ms; };

  for (let i = 0; i < 3; i += 1) {
    const before = await enforceDensityBudget(home, "gemini", {
      enabled: true,
      windowMs: 60_000,
      maxPerWindow: 3,
      now,
      sleep,
    });
    assert.equal(before.sleptMs, 0, `action ${i + 1} must not wait`);
    await recordDensityAction(home, "gemini", {
      enabled: true,
      windowMs: 60_000,
      maxPerWindow: 3,
      now,
    });
    clock += 5_000;
  }

  const waited = await enforceDensityBudget(home, "gemini", {
    enabled: true,
    windowMs: 60_000,
    maxPerWindow: 3,
    now,
    sleep,
    random: () => 0.5, // jitter = 2000ms
  });
  assert.equal(waited.countInWindow, 3);
  assert.equal(waited.sleptMs, 47_000);
  assert.deepEqual(slept, [47_000]);

  const otherProv = await enforceDensityBudget(home, "chatgpt", {
    enabled: true,
    windowMs: 60_000,
    maxPerWindow: 3,
    now,
    sleep,
  });
  assert.equal(otherProv.sleptMs, 0);
});

test("density-guard: real timer wait aborts immediately on signal without keeping event loop alive", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-density-abort-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const nowTs = Date.now();
  await writeFile(
    getDensityStorePath(home),
    JSON.stringify({ chatgpt: Array.from({ length: 12 }, () => nowTs) }),
    "utf8",
  );

  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 30);

  await assert.rejects(
    enforceDensityBudget(home, "chatgpt", {
      enabled: true,
      windowMs: 300_000,
      maxPerWindow: 12,
      signal: ac.signal,
    }),
    (err) => err?.code === "CANCELLED",
  );
  assert.ok(Date.now() - started < 500, "aborted density wait must settle immediately");
});

test("density-guard: respects maxPerWindow=0 (disabled)", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-density-off-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const off = await enforceDensityBudget(home, "gemini", {
    enabled: true,
    windowMs: 60_000,
    maxPerWindow: 0,
  });
  assert.equal(off.sleptMs, 0);
});
