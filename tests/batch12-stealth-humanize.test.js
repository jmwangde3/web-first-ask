import test from "node:test";
import assert from "node:assert/strict";
import { buildChromeArgs } from "../src/browser/launch.js";
import { PACE_CONFIG, resolvePaceRange } from "../src/browser/pacer.js";
import {
  DEFAULT_TARGET_TIMEZONE,
  openTab,
  pickHumanPoint,
  humanClickAt,
  evaluateInWorld,
  submitTurn,
} from "../src/browser/driver.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

test("timezone auto-detect: skips Emulation.setTimezoneOverride when host is already Asia/Tokyo, overrides otherwise", async () => {
  const callsTokyo = [];
  const makeCdp = (calls) => ({
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "t1" };
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      return {};
    },
  });

  await openTab(makeCdp(callsTokyo), "https://chatgpt.com/", { systemTimezone: DEFAULT_TARGET_TIMEZONE });
  assert.equal(
    callsTokyo.some((c) => c.method === "Emulation.setTimezoneOverride"),
    false,
    "must skip Emulation.setTimezoneOverride when host timezone is already Asia/Tokyo",
  );

  const callsUtc = [];
  await openTab(makeCdp(callsUtc), "https://chatgpt.com/", { systemTimezone: "UTC" });
  const tzCall = callsUtc.find((c) => c.method === "Emulation.setTimezoneOverride");
  assert.ok(tzCall, "must call Emulation.setTimezoneOverride when host timezone differs");
  assert.deepEqual(tzCall.params, { timezoneId: "Asia/Tokyo" });
});

test("launch args subtraction: omits noisy automation flags while preserving background mode", () => {
  const args = buildChromeArgs({ userDataDir: "/tmp/p", mode: "background" });
  for (const forbidden of [
    "--disable-background-networking",
    "--enable-automation",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--restore-last-session",
  ]) {
    assert.ok(!args.includes(forbidden), `must not include ${forbidden}`);
  }
  assert.ok(args.includes("--window-position=-2000,-2000"), "background mode stays untouched");
  assert.ok(args.includes("--disable-blink-features=AutomationControlled"));
  assert.ok(args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
});

test("evaluateInWorld uses Page.createIsolatedWorld and passes contextId without Runtime.enable", async () => {
  const calls = [];
  const mockCdp = {
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
      if (method === "Runtime.evaluate") return { result: { value: { ok: true } } };
      return {};
    },
  };

  const res = await evaluateInWorld(mockCdp, "sess-1", "({ ok: true })");
  assert.deepEqual(res.result.value, { ok: true });
  const evalCall = calls.find((c) => c.method === "Runtime.evaluate");
  assert.equal(evalCall.params.contextId, 42);
  assert.equal(calls.some((c) => ["Runtime.enable", "Console.enable", "Page.setBypassCSP"].includes(c.method)), false);
});

test("humanClickAt and submitTurn dispatch trusted CDP Input.dispatchMouseEvent sequence inside bounding box", async () => {
  const pt = pickHumanPoint({ left: 100, top: 200, width: 40, height: 20 }, () => 0.5);
  assert.equal(pt.x, 120);
  assert.equal(pt.y, 210);

  const mouseEvents = [];
  const mockCdp = {
    async send(method, params) {
      if (method === "Input.dispatchMouseEvent") mouseEvents.push(params);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "f1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") {
        if (String(params.expression).includes("disabled:")) {
          return { result: { value: { exists: true, visible: true, disabled: false } } };
        }
        return { result: { value: { readyToClick: true, rect: { left: 300, top: 400, width: 40, height: 30 } } } };
      }
      return {};
    },
  };

  const res = await submitTurn(mockCdp, "sess-1", { id: "chatgpt", sendSelector: "button[data-testid='send-button']" }, {
    sleep: async () => {},
  });
  assert.equal(res.method, "click");
  assert.deepEqual(mouseEvents.map((e) => e.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(mouseEvents[1].button, "left");
  assert.equal(mouseEvents[1].clickCount, 1);
  assert.ok(mouseEvents[0].x >= 310 && mouseEvents[0].x <= 330);
  assert.ok(mouseEvents[0].y >= 407.5 && mouseEvents[0].y <= 422.5);
});

test("bulk cleanup triggers batch_pause after every --batch-size items", async () => {
  assert.deepEqual(PACE_CONFIG.batch_pause, { min: 60000, max: 180000 });
  assert.deepEqual(resolvePaceRange("batch_pause"), { min: 60000, max: 180000 });

  const paceCalls = [];
  const stdout = createMockStream();
  let currentUrl = "https://gemini.google.com/app/1";
  const res = await runCdpCommand(["cleanup", "--all", "--batch-size", "2", "--batch-pause-sec", "90-120", "--json"], {
    home: "/tmp/wfa-b12-pause",
    stdout,
    stderr: createMockStream(),
    sleep: async () => {},
    pace: async (kind, opts) => { paceCalls.push({ kind, range: opts?.range }); return 0; },
    resultStore: {
      readResults: async () => [
        { turnId: "t1", provider: "gemini", state: "completed", createdByWfa: true, conversationUrl: "https://gemini.google.com/app/1" },
        { turnId: "t2", provider: "gemini", state: "completed", createdByWfa: true, conversationUrl: "https://gemini.google.com/app/2" },
        { turnId: "t3", provider: "gemini", state: "completed", createdByWfa: true, conversationUrl: "https://gemini.google.com/app/3" },
      ],
    },
    adapters: {
      gemini: { buildDeleteConversationJs: () => "Promise.resolve({ success: true })" },
    },
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { port: 9222 } }),
    connectCdp: async () => ({
      async send(method, params) {
        if (method === "Page.navigate") currentUrl = params.url;
        if (method === "Runtime.evaluate") {
          if (String(params.expression).includes("document.readyState")) {
            return { result: { value: { readyState: "complete", pathname: new URL(currentUrl).pathname } } };
          }
          return { result: { value: { success: true, verified: "route_changed" } } };
        }
        return {};
      },
      close() {},
    }),
    driver: {
      openTab: async () => ({ targetId: "tab-1", sessionId: "sess-1" }),
      closeTab: async () => {},
    },
  });

  assert.equal(res.code, 0);
  assert.deepEqual(paceCalls, [
    { kind: "batch", range: undefined },
    { kind: "batch_pause", range: { min: 90000, max: 120000 } },
  ]);
});
