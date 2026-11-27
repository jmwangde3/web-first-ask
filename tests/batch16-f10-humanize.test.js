import test from "node:test";
import assert from "node:assert/strict";
import {
  generateMousePath,
  humanTypeText,
  isHumanizeEnabled,
  computeKeystrokeDelay,
} from "../src/browser/humanize.js";
import { humanClickAt } from "../src/browser/driver.js";

test("F10: humanize is auto-disabled under node --test unless explicitly enabled", () => {
  assert.equal(isHumanizeEnabled(), false);
  assert.equal(isHumanizeEnabled({ enabled: true }), true);
  assert.equal(isHumanizeEnabled({ enabled: false }), false);
});

test("F10: generateMousePath builds a curved non-linear trajectory ending exactly on target", () => {
  const from = { x: 100, y: 120 };
  const to = { x: 520, y: 440 };
  const path = generateMousePath(from, to, { random: () => 0.3 });

  assert.ok(path.length >= 8 && path.length <= 22, `expected 8..22 steps, got ${path.length}`);
  const last = path[path.length - 1];
  assert.equal(last.x, to.x);
  assert.equal(last.y, to.y);

  // Verify points deviate from straight line (curved Bezier arc)
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const maxPerpDist = Math.max(
    ...path.slice(0, -1).map((pt) => Math.abs((pt.x - from.x) * dy - (pt.y - from.y) * dx) / len),
  );
  assert.ok(maxPerpDist > 10, `expected curved deviation > 10px, got ${maxPerpDist}`);
});

test("F10: humanClickAt dispatches multi-step curved mouseMoved sequence when curved=true", async () => {
  const events = [];
  const sleeps = [];
  const mockCdp = {
    async send(method, params) {
      if (method === "Input.dispatchMouseEvent") events.push(params);
      return {};
    },
  };

  await humanClickAt(mockCdp, "sess-f10", 480, 360, {
    curved: true,
    from: { x: 100, y: 100 },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.4,
  });

  const moves = events.filter((e) => e.type === "mouseMoved");
  const presses = events.filter((e) => e.type === "mousePressed");
  const releases = events.filter((e) => e.type === "mouseReleased");
  assert.ok(moves.length >= 6, `expected curved multi-step mouseMoved, got ${moves.length}`);
  assert.equal(presses.length, 1);
  assert.equal(releases.length, 1);
  assert.equal(events[events.length - 2].type, "mousePressed");
  assert.equal(events[events.length - 1].type, "mouseReleased");
  assert.ok(sleeps.length >= moves.length + 1);
});

test("F10: humanTypeText types short prompts char-by-char and bulk-pastes long prompts", async () => {
  const shortChunks = [];
  const shortSleeps = [];
  const shortRes = await humanTypeText(
    { async send(method, params) { if (method === "Input.insertText") shortChunks.push(params.text); } },
    "sess-1",
    "你好 wfa!",
    { enabled: true, sleep: async (ms) => shortSleeps.push(ms), random: () => 0.5 },
  );
  assert.equal(shortRes.mode, "keystroke");
  assert.deepEqual(shortChunks, ["你", "好", " ", "w", "f", "a", "!"]);
  assert.equal(shortSleeps.length, 6);
  assert.ok(shortSleeps.every((ms) => ms >= 45 && ms <= 270));

  const longText = "x".repeat(200);
  const longChunks = [];
  const longRes = await humanTypeText(
    { async send(method, params) { if (method === "Input.insertText") longChunks.push(params.text); } },
    "sess-1",
    longText,
    { enabled: true, sleep: async () => {} },
  );
  assert.equal(longRes.mode, "paste");
  assert.deepEqual(longChunks, [longText]);

  assert.ok(computeKeystrokeDelay("a", () => 0.5) >= 45);
  assert.ok(computeKeystrokeDelay(" ", () => 0.5) >= 95);
});
