import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_MIN_INTERVAL_MS,
  enforceCooldown,
  getLastTurnPath,
  recordLastTurn,
} from "../src/browser/cooldown.js";

test("DEFAULT_MIN_INTERVAL_MS defaults are configured correctly", () => {
  assert.equal(DEFAULT_MIN_INTERVAL_MS.chatgpt, 5000);
  assert.equal(DEFAULT_MIN_INTERVAL_MS.gemini, 2000);
});

test("enforceCooldown: sleeps remaining delta when called within interval", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    const finishedAt = 10000;
    await recordLastTurn(tmpDir, "chatgpt", { finishedAt, status: "completed", countsForCooldown: true });

    let sleptMs = 0;
    let onWaitCalledWith = null;

    const res = await enforceCooldown(tmpDir, "chatgpt", {
      minIntervalMs: 5000,
      now: () => 12000, // 2000ms elapsed since finishedAt -> 3000ms remaining
      sleep: async (ms) => {
        sleptMs = ms;
      },
      onWait: (rem) => {
        onWaitCalledWith = rem;
      },
    });

    assert.equal(sleptMs, 3000);
    assert.equal(onWaitCalledWith, 3000);
    assert.equal(res.sleptMs, 3000);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("enforceCooldown: does not sleep when elapsed time exceeds interval", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    const finishedAt = 10000;
    await recordLastTurn(tmpDir, "gemini", { finishedAt, status: "completed", countsForCooldown: true });

    let slept = false;
    const res = await enforceCooldown(tmpDir, "gemini", {
      minIntervalMs: 2000,
      now: () => 13000, // 3000ms elapsed -> 0ms remaining
      sleep: async () => {
        slept = true;
      },
    });

    assert.equal(slept, false);
    assert.equal(res.sleptMs, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("enforceCooldown: minIntervalMs 0 disables cooldown completely", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    const finishedAt = 10000;
    await recordLastTurn(tmpDir, "chatgpt", { finishedAt, status: "completed", countsForCooldown: true });

    let slept = false;
    const res = await enforceCooldown(tmpDir, "chatgpt", {
      minIntervalMs: 0,
      now: () => 10100,
      sleep: async () => {
        slept = true;
      },
    });

    assert.equal(slept, false);
    assert.equal(res.sleptMs, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("enforceCooldown: handles missing or corrupt last-turn.json gracefully", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // 1. Missing file
    const res1 = await enforceCooldown(tmpDir, "chatgpt", {
      minIntervalMs: 5000,
      now: () => 20000,
    });
    assert.equal(res1.sleptMs, 0);

    // 2. Corrupt file content
    await writeFile(path.join(tmpDir, "last-turn.json"), "{ NOT_VALID_JSON", "utf8");
    const res2 = await enforceCooldown(tmpDir, "chatgpt", {
      minIntervalMs: 5000,
      now: () => 20000,
    });
    assert.equal(res2.sleptMs, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("recordLastTurn: persists entries per provider and preserves other providers", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    await recordLastTurn(tmpDir, "chatgpt", { finishedAt: 1000, status: "completed" });
    await recordLastTurn(tmpDir, "gemini", { finishedAt: 2000, status: "needs_human" });

    const raw = await readFile(path.join(tmpDir, "last-turn.json"), "utf8");
    const map = JSON.parse(raw);

    assert.equal(map.chatgpt?.finishedAt, 1000);
    assert.equal(map.chatgpt?.status, "completed");
    assert.equal(map.gemini?.finishedAt, 2000);
    assert.equal(map.gemini?.status, "needs_human");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("recordLastTurn: countsForCooldown false preserves previous cooldownFinishedAt", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // Turn 1: submitted send -> advances cooldownFinishedAt to 1000
    await recordLastTurn(tmpDir, "chatgpt", { finishedAt: 1000, status: "completed", countsForCooldown: true });

    let raw = await readFile(path.join(tmpDir, "last-turn.json"), "utf8");
    let map = JSON.parse(raw);
    assert.equal(map.chatgpt?.finishedAt, 1000);
    assert.equal(map.chatgpt?.cooldownFinishedAt, 1000);

    // Turn 2: pre-send failure (e.g. RECOVERY_REQUIRED) -> finishedAt becomes 2000, cooldownFinishedAt remains 1000
    await recordLastTurn(tmpDir, "chatgpt", { finishedAt: 2000, status: "needs_human", countsForCooldown: false });

    raw = await readFile(path.join(tmpDir, "last-turn.json"), "utf8");
    map = JSON.parse(raw);
    assert.equal(map.chatgpt?.finishedAt, 2000);
    assert.equal(map.chatgpt?.cooldownFinishedAt, 1000);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("enforceCooldown: backward compatibility falls back to finishedAt when cooldownFinishedAt is undefined", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // Legacy file without cooldownFinishedAt field
    await writeFile(
      path.join(tmpDir, "last-turn.json"),
      JSON.stringify({ chatgpt: { finishedAt: 10000, status: "completed" } }),
      "utf8"
    );

    let sleptMs = 0;
    const res = await enforceCooldown(tmpDir, "chatgpt", {
      minIntervalMs: 5000,
      now: () => 12000,
      sleep: async (ms) => {
        sleptMs = ms;
      },
    });

    assert.equal(sleptMs, 3000);
    assert.equal(res.sleptMs, 3000);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("recordLastTurn: T2 - legacy entry without cooldownFinishedAt inherits finishedAt when countsForCooldown false; explicit 0 stays 0", async () => {
  const tmpDir = path.join(os.tmpdir(), `wfa-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // 1. Legacy entry without cooldownFinishedAt
    await writeFile(
      path.join(tmpDir, "last-turn.json"),
      JSON.stringify({ chatgpt: { finishedAt: 10000, status: "completed" } }),
      "utf8"
    );

    await recordLastTurn(tmpDir, "chatgpt", { finishedAt: 12000, status: "needs_human", countsForCooldown: false });
    let raw = await readFile(path.join(tmpDir, "last-turn.json"), "utf8");
    let map = JSON.parse(raw);
    assert.equal(map.chatgpt?.finishedAt, 12000);
    assert.equal(map.chatgpt?.cooldownFinishedAt, 10000, "cooldownFinishedAt must inherit 10000 from finishedAt, not 0");

    // 2. Explicit 0 in cooldownFinishedAt stays 0
    await writeFile(
      path.join(tmpDir, "last-turn.json"),
      JSON.stringify({ chatgpt: { finishedAt: 10000, cooldownFinishedAt: 0, status: "completed" } }),
      "utf8"
    );

    await recordLastTurn(tmpDir, "chatgpt", { finishedAt: 12000, status: "needs_human", countsForCooldown: false });
    raw = await readFile(path.join(tmpDir, "last-turn.json"), "utf8");
    map = JSON.parse(raw);
    assert.equal(map.chatgpt?.cooldownFinishedAt, 0, "explicit 0 in cooldownFinishedAt must stay 0");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

