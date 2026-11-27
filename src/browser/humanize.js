// F10: Humanized curved mouse trajectories (cubic Bezier + Fitts' law easing)
// and short-prompt keystroke pacing (long prompts stay bulk-inserted like real paste).

const DEFAULT_HUMAN_TYPE_MAX_CHARS = 120;
const lastCursorBySession = new Map();

export function isNodeTestRunner() {
  return Boolean(process.env.NODE_TEST_CONTEXT) ||
    (Array.isArray(process.execArgv) && process.execArgv.includes("--test"));
}

export function isHumanizeEnabled(options = {}) {
  if (options.enabled === false) return false;
  if (options.enabled === true) return true;
  if (process.env.WFA_NO_PACE === "1") return false;
  if (process.env.WFA_NO_HUMANIZE === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  if (isNodeTestRunner()) return false;
  return true;
}

export function resolveHumanTypeMaxChars(override) {
  const raw = Number(override ?? process.env.WFA_HUMAN_TYPE_MAX_CHARS);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_HUMAN_TYPE_MAX_CHARS;
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return (u ** 3) * p0 + 3 * (u ** 2) * t * p1 + 3 * u * (t ** 2) * p2 + (t ** 3) * p3;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Generates a curved mouse trajectory from `from` to `to` using a cubic Bezier
 * curve with Fitts'-law-inspired step count/duration and subtle hand micro-jitter.
 */
export function generateMousePath(from, to, { random = Math.random } = {}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 2) {
    return [{ x: round2(to.x), y: round2(to.y), delayMs: 0 }];
  }

  const steps = Math.max(6, Math.min(22, Math.round(dist / 35) + 5));
  // Fitts' law inspired total travel duration: ~120ms for short moves up to ~420ms for long moves
  const totalDurationMs = Math.round(
    110 + 75 * Math.log2(1 + dist / 24) + (clamp01(random()) - 0.5) * 60,
  );

  // Perpendicular arc offset for cubic Bezier control points
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const side = clamp01(random()) < 0.5 ? -1 : 1;
  const arcMag = Math.min(140, Math.max(12, dist * (0.12 + clamp01(random()) * 0.14))) * side;

  const p1 = {
    x: from.x + dx * (0.25 + clamp01(random()) * 0.15) + perpX * arcMag,
    y: from.y + dy * (0.25 + clamp01(random()) * 0.15) + perpY * arcMag,
  };
  const p2 = {
    x: from.x + dx * (0.65 + clamp01(random()) * 0.15) + perpX * arcMag * 0.55,
    y: from.y + dy * (0.65 + clamp01(random()) * 0.15) + perpY * arcMag * 0.55,
  };

  const points = [];
  const baseStepDelay = totalDurationMs / steps;
  for (let i = 1; i <= steps; i += 1) {
    const rawT = i / steps;
    const t = smoothstep(rawT);
    const isLast = i === steps;
    const jitterX = isLast ? 0 : (clamp01(random()) - 0.5) * 2.4;
    const jitterY = isLast ? 0 : (clamp01(random()) - 0.5) * 2.4;
    const x = isLast ? to.x : cubicBezier(from.x, p1.x, p2.x, to.x, t) + jitterX;
    const y = isLast ? to.y : cubicBezier(from.y, p1.y, p2.y, to.y, t) + jitterY;
    // Slight speed variation (slower at start/end, faster in middle)
    const speedFactor = 1.35 - 0.7 * Math.sin(Math.PI * rawT);
    const delayMs = Math.max(8, Math.round(baseStepDelay * speedFactor));
    points.push({ x: round2(x), y: round2(y), delayMs });
  }
  return points;
}

export function getLastCursor(sessionId, random = Math.random) {
  if (sessionId && lastCursorBySession.has(sessionId)) {
    return lastCursorBySession.get(sessionId);
  }
  return {
    x: round2(180 + clamp01(random()) * 420),
    y: round2(180 + clamp01(random()) * 320),
  };
}

export function setLastCursor(sessionId, point) {
  if (!sessionId || !point) return;
  if (lastCursorBySession.size > 64) {
    const firstKey = lastCursorBySession.keys().next().value;
    if (firstKey !== undefined) lastCursorBySession.delete(firstKey);
  }
  lastCursorBySession.set(sessionId, { x: round2(point.x), y: round2(point.y) });
}

export function computeKeystrokeDelay(ch, random = Math.random) {
  const r = clamp01(random());
  if (/[\s.,!?;:，。！？；：]/.test(ch)) {
    return 95 + Math.floor(r * 95); // 95-190ms after space/punctuation
  }
  if (r > 0.92) {
    return 160 + Math.floor(clamp01(random()) * 110); // occasional brief hesitation
  }
  return 45 + Math.floor(r * 85); // 45-130ms typical keystroke interval
}

/**
 * Types short prompts character-by-character with human-like cadence;
 * pastes long prompts (> maxHumanChars) in a single Input.insertText call
 * just as a real user pastes code/context.
 */
export async function humanTypeText(cdp, sessionId, text, {
  enabled,
  maxHumanChars,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
} = {}) {
  const active = isHumanizeEnabled({ enabled });
  const limit = resolveHumanTypeMaxChars(maxHumanChars);
  const chars = Array.from(String(text));

  if (!active || limit <= 0 || chars.length > limit || chars.includes("\n") || chars.includes("\r")) {
    await cdp.send("Input.insertText", { text }, sessionId);
    return { mode: "paste", chunks: 1 };
  }

  for (let i = 0; i < chars.length; i += 1) {
    await cdp.send("Input.insertText", { text: chars[i] }, sessionId);
    if (i + 1 < chars.length) {
      await sleep(computeKeystrokeDelay(chars[i], random));
    }
  }
  return { mode: "keystroke", chunks: chars.length };
}
