import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import {
  normalizeCleanupUrlKey,
  readDeletedLedger,
  recordDeletedUrl,
} from "../src/browser/cleanup-ledger.js";
import {
  classifyCleanupCandidate,
  collectCleanupCandidates,
  parseDeleteEvalResult,
  waitForNavigationReady,
} from "../src/engines/cdp-cli.js";
import { runCdpTurn } from "../src/engines/cdp-engine.js";
import * as defaultDriver from "../src/browser/driver.js";

function makeEl(tag, attrs = {}, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    innerText: opts.innerText ?? "",
    textContent: opts.textContent ?? opts.innerText ?? "",
    className: opts.className ?? "",
    isConnected: opts.isConnected ?? true,
    parentElement: null,
    children: [],
    scrollHeight: opts.scrollHeight ?? 100,
    clientHeight: opts.clientHeight ?? 100,
    scrollTop: 0,
    overflowY: opts.overflowY ?? "visible",
    clicked: 0,
    events: [],
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    getBoundingClientRect() { return opts.hidden ? { width: 0, height: 0 } : { width: 120, height: 32 }; },
    scrollIntoView() {},
    focus() {},
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesSimple(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    click() {
      this.clicked += 1;
      if (typeof opts.onClick === "function") opts.onClick(this);
    },
    dispatchEvent(ev) {
      this.events.push(ev?.type || "");
      if (ev?.type === "scroll" && typeof opts.onScroll === "function") opts.onScroll(this);
      return true;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (matchesSimple(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
  };
  return el;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function matchesSimple(el, selectorList) {
  const parts = String(selectorList).split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (matchOne(el, part)) return true;
  }
  return false;
}

function matchOne(el, sel) {
  let rest = sel;
  const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[1].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  const attrRe = /\[([a-zA-Z0-9_-]+)(?:(\^=|\*=|=)"([^"]*)"(\s+i)?)?\]/g;
  let m;
  while ((m = attrRe.exec(rest)) !== null) {
    const [, attr, op, val, ci] = m;
    const actual = el.getAttribute(attr);
    if (actual === null) return false;
    if (!op) continue;
    const a = ci ? actual.toLowerCase() : actual;
    const v = ci ? val.toLowerCase() : val;
    if (op === "=" && a !== v) return false;
    if (op === "^=" && !a.startsWith(v)) return false;
    if (op === "*=" && !a.includes(v)) return false;
  }
  return true;
}

function runScriptInMockDom(js, { pathname, root, title = "Gemini" }) {
  const location = { pathname };
  const document = {
    title,
    body: { innerText: "" },
    querySelectorAll(sel) { return root.querySelectorAll(sel); },
  };
  const window = {
    getComputedStyle(el) {
      return { display: "block", visibility: "visible", opacity: "1", overflowY: el.overflowY || "visible" };
    },
  };
  const ctx = vm.createContext({
    window,
    document,
    location,
    URL,
    Event: class MockEvent { constructor(type) { this.type = type; } },
    setTimeout,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
  });
  return vm.runInContext(js, ctx);
}

const FAST_OPTS = {
  headerWaitMs: 60,
  initialWaitMs: 60,
  maxScrollSteps: 5,
  scrollSettleMs: 80,
  maxNoGrowthSteps: 2,
  totalLinkTimeoutMs: 600,
  pollIntervalMs: 15,
  menuWaitMs: 200,
  menuRetryMs: 60,
};

test("gemini delete: accepts /u/0/app/<id> equivalent path and zh-CN header menu button", async () => {
  const root = makeEl("div");
  const header = append(root, makeEl("header"));
  const menu = append(root, makeEl("div", { role: "menu" }, { hidden: true }));
  const delItem = append(menu, makeEl("button", { role: "menuitem" }, {
    innerText: "删除",
    hidden: true,
    onClick() {
      dlg.attrs["aria-label"] = "Delete chat";
      dlg._hidden = false;
    },
  }));
  const dlg = append(root, makeEl("div", { role: "dialog" }, { innerText: "删除对话" }));
  dlg._hidden = true;
  dlg.getBoundingClientRect = () => (dlg._hidden ? { width: 0, height: 0 } : { width: 300, height: 200 });
  const confirmBtn = append(dlg, makeEl("button", {}, {
    innerText: "删除",
    onClick() {
      // Simulate route change via location mutation below
    },
  }));
  confirmBtn.getBoundingClientRect = () => (dlg._hidden ? { width: 0, height: 0 } : { width: 80, height: 32 });

  const hdrBtn = append(header, makeEl("button", { "aria-label": "打开对话操作菜单" }, {
    onClick() {
      menu.getBoundingClientRect = () => ({ width: 120, height: 80 });
      delItem.getBoundingClientRect = () => ({ width: 100, height: 28 });
    },
  }));

  const js = geminiAdapter.buildDeleteConversationJs("https://gemini.google.com/app/abc123", FAST_OPTS);
  const location = { pathname: "/u/0/app/abc123" };
  confirmBtn.click = () => {
    confirmBtn.clicked += 1;
    location.pathname = "/u/0/app";
  };
  const document = {
    title: "Gemini",
    body: { innerText: "" },
    querySelectorAll(sel) { return root.querySelectorAll(sel); },
  };
  const window = { getComputedStyle: (el) => ({ display: "block", visibility: "visible", opacity: "1", overflowY: el.overflowY || "visible" }) };
  const res = await vm.runInContext(js, vm.createContext({
    window, document, location, URL,
    Event: class { constructor(t) { this.type = t; } },
    setTimeout, Date, Number, String, Boolean, Array, Object,
  }));

  assert.equal(res.success, true);
  assert.equal(res.verified, "route_changed");
  assert.equal(hdrBtn.clicked, 1);
  assert.equal(confirmBtn.clicked, 1);

  // Mismatched conversation ID must still fail closed with target_url_mismatch
  const bad = await runScriptInMockDom(
    geminiAdapter.buildDeleteConversationJs("https://gemini.google.com/app/other999", FAST_OPTS),
    { pathname: "/u/0/app/abc123", root: makeEl("div") },
  );
  assert.equal(bad.success, false);
  assert.equal(bad.reason, "target_url_mismatch");
});

test("gemini delete: scrolls lazy-loaded sidebar to find older entry row menu when header button absent", async () => {
  const root = makeEl("div");
  const nav = append(root, makeEl("nav"));
  let pagesLoaded = 0;
  const scroller = append(nav, makeEl("div", {}, {
    scrollHeight: 1000,
    clientHeight: 500,
    overflowY: "auto",
    onScroll(el) {
      pagesLoaded += 1;
      if (pagesLoaded === 1) {
        const row = append(el, makeEl("div"));
        append(row, makeEl("a", { href: "/app/old-item-1" }));
        el.scrollHeight += 300;
      } else if (pagesLoaded === 2) {
        const row = append(el, makeEl("div"));
        append(row, makeEl("a", { href: "/app/target-old-99" }));
        append(row, targetRowBtn);
        el.scrollHeight += 300;
      }
    },
  }));
  // Initial 2 items without target
  for (let i = 0; i < 2; i += 1) {
    const r = append(scroller, makeEl("div"));
    append(r, makeEl("a", { href: `/app/recent-${i}` }));
    append(r, makeEl("button", { "data-test-id": "actions-menu-button" }));
  }

  let menuVisible = false;
  let dlgVisible = false;
  const menu = append(root, makeEl("div", { role: "menu" }));
  menu.getBoundingClientRect = () => (menuVisible ? { width: 140, height: 80 } : { width: 0, height: 0 });
  const delItem = append(menu, makeEl("button", { role: "menuitem" }, {
    innerText: "Delete",
    onClick() { dlgVisible = true; },
  }));
  delItem.getBoundingClientRect = () => (menuVisible ? { width: 100, height: 30 } : { width: 0, height: 0 });
  const dlg = append(root, makeEl("div", { role: "dialog", "aria-label": "Delete chat" }, { innerText: "Delete chat?" }));
  dlg.getBoundingClientRect = () => (dlgVisible ? { width: 300, height: 180 } : { width: 0, height: 0 });
  const confirmBtn = append(dlg, makeEl("button", {}, { innerText: "Delete" }));
  confirmBtn.getBoundingClientRect = () => (dlgVisible ? { width: 90, height: 32 } : { width: 0, height: 0 });

  const targetRowBtn = makeEl("button", { "data-test-id": "actions-menu-button" }, {
    onClick() { menuVisible = true; },
  });

  const location = { pathname: "/app/target-old-99" };
  confirmBtn.click = () => {
    confirmBtn.clicked += 1;
    location.pathname = "/app";
  };
  const document = { title: "Gemini", body: { innerText: "" }, querySelectorAll: (s) => root.querySelectorAll(s) };
  const window = { getComputedStyle: (el) => ({ display: "block", visibility: "visible", opacity: "1", overflowY: el.overflowY || "visible" }) };

  const js = geminiAdapter.buildDeleteConversationJs("https://gemini.google.com/app/target-old-99", FAST_OPTS);
  const res = await vm.runInContext(js, vm.createContext({
    window, document, location, URL,
    Event: class { constructor(t) { this.type = t; } },
    setTimeout, Date, Number, String, Boolean, Array, Object,
  }));

  assert.equal(res.success, true);
  assert.equal(res.verified, "route_changed");
  assert.equal(res.scrolledSteps, 2);
  assert.equal(targetRowBtn.clicked, 1);
});

test("chatgpt delete: retries opening Radix menu once with pointer events if first click does not open menu", async () => {
  const root = makeEl("div");
  const nav = append(root, makeEl("nav"));
  const row = append(nav, makeEl("div"));
  append(row, makeEl("a", { href: "/c/retry-menu-1", "aria-current": "page" }));

  let menuOpen = false;
  let dlgOpen = false;
  const menuBtn = append(row, makeEl("button", { "aria-label": "聊天操作" }, {
    onClick(btn) {
      // Simulate Radix ignoring first plain click and opening only after pointerdown retry
      if (btn.events.includes("pointerdown")) {
        menuOpen = true;
      }
    },
  }));
  const menu = append(root, makeEl("div", { role: "menu" }));
  menu.getBoundingClientRect = () => (menuOpen ? { width: 160, height: 90 } : { width: 0, height: 0 });
  const delItem = append(menu, makeEl("div", { role: "menuitem" }, {
    innerText: "删除\nCtrl+D",
    onClick() { dlgOpen = true; },
  }));
  delItem.getBoundingClientRect = () => (menuOpen ? { width: 120, height: 32 } : { width: 0, height: 0 });
  const dlg = append(root, makeEl("div", { role: "dialog", "aria-modal": "true" }, { innerText: "删除聊天？" }));
  dlg.getBoundingClientRect = () => (dlgOpen ? { width: 320, height: 180 } : { width: 0, height: 0 });
  const confirmBtn = append(dlg, makeEl("button", {}, { innerText: "删除" }));
  confirmBtn.getBoundingClientRect = () => (dlgOpen ? { width: 90, height: 32 } : { width: 0, height: 0 });

  const location = { pathname: "/c/retry-menu-1" };
  confirmBtn.click = () => {
    confirmBtn.clicked += 1;
    location.pathname = "/";
  };
  const document = { title: "Chat", body: { innerText: "" }, querySelectorAll: (s) => root.querySelectorAll(s) };
  const window = { getComputedStyle: (el) => ({ display: "block", visibility: "visible", opacity: "1", overflowY: "visible" }) };

  const js = chatgptAdapter.buildDeleteConversationJs("https://chatgpt.com/c/retry-menu-1", FAST_OPTS);
  const res = await vm.runInContext(js, vm.createContext({
    window, document, location, URL,
    Event: class { constructor(t) { this.type = t; } },
    setTimeout, Date, Number, String, Boolean, Array, Object,
  }));

  assert.equal(res.success, true);
  assert.equal(res.menuRetried, true);
  assert.equal(res.scrolledSteps, 0);
  assert.equal(menuBtn.clicked, 2);
});

test("cleanup ledger skips already-deleted URLs and normalizes Gemini /u/0/app/<id> keys", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-ledger-"));
  try {
    assert.equal(
      normalizeCleanupUrlKey("https://gemini.google.com/u/0/app/abc123/"),
      "https://gemini.google.com/app/abc123",
    );
    await recordDeletedUrl(home, "https://gemini.google.com/u/0/app/abc123/", { provider: "gemini", verified: "route_changed" });
    const ledger = await readDeletedLedger(home);
    assert.ok(ledger["https://gemini.google.com/app/abc123"]);

    const candidates = await collectCleanupCandidates(home, {
      resultStore: {
        readResults: async () => [
          { turnId: "t1", provider: "gemini", conversationUrl: "https://gemini.google.com/app/abc123", createdByWfa: true, state: "completed" },
          { turnId: "t2", provider: "chatgpt", conversationUrl: "https://chatgpt.com/c/auto-del", createdByWfa: true, state: "completed", createdCleanup: { status: "deleted" } },
          { turnId: "t3", provider: "chatgpt", conversationUrl: "https://chatgpt.com/c/still-alive", createdByWfa: true, state: "completed" },
        ],
      },
      cleanupLedger: { readDeletedLedger },
    });

    const d1 = classifyCleanupCandidate(candidates.find((c) => c.turnId === "t1"), { all: true });
    const d2 = classifyCleanupCandidate(candidates.find((c) => c.turnId === "t2"), { all: true });
    const d3 = classifyCleanupCandidate(candidates.find((c) => c.turnId === "t3"), { all: true });
    assert.deepEqual(d1, { eligible: false, reason: "already_deleted" });
    assert.deepEqual(d2, { eligible: false, reason: "already_deleted" });
    assert.equal(d3.eligible, true);

    const parsed = parseDeleteEvalResult({ result: { value: { success: true, verified: "route_changed", scrolledSteps: 3, menuRetried: true } } });
    assert.equal(parsed.status, "deleted");
    assert.equal(parsed.scrolledSteps, 3);
    assert.equal(parsed.menuRetried, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("waitForNavigationReady accepts Gemini /u/0/app/<id> for target /app/<id>", async () => {
  const cdp = {
    async send(method) {
      if (method === "Runtime.evaluate") {
        return { result: { value: { readyState: "complete", pathname: "/u/0/app/conv42" } } };
      }
      return {};
    },
  };
  const nav = await waitForNavigationReady(cdp, "sess-1", "https://gemini.google.com/app/conv42", {
    timeoutMs: 200,
    pollMs: 10,
    settleMs: 0,
    sleepFn: async () => {},
  });
  assert.equal(nav.ready, true);
});

test("runCdpTurn closes work tab on pre-submit failure (no tab leak) while retaining post-submit failures", async () => {
  const closed = [];
  const cdp = {
    wsUrl: "ws://127.0.0.1:9222/devtools/browser/presubmit-close",
    targets: [],
    async send(method, params = {}) {
      if (method === "Target.getTargets") return { targetInfos: this.targets.map((t) => ({ ...t })) };
      if (method === "Target.createTarget") {
        this.targets.push({ targetId: "anchor", type: "page", url: "about:blank" });
        return { targetId: "anchor" };
      }
      if (method === "Target.closeTarget") {
        closed.push(params.targetId);
        return { success: true };
      }
      return {};
    },
    close() {},
  };

  const res = await runCdpTurn({
    provider: "chatgpt",
    prompt: "hello",
    files: ["/tmp/nonexistent-test.txt"],
    mode: "background",
    minIntervalMs: 0,
    deps: {
      skipTurnLock: true,
      enforceCooldown: async () => {},
      recordLastTurn: async () => {},
      withSendSlot: async (_p, fn) => fn(),
      pace: async () => {},
      conversationStore: {
        loadSession: async () => null,
        saveSession: async () => {},
        markInvalid: async () => {},
      },
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 10, port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        ...defaultDriver,
        openTab: async () => ({ targetId: "work-presubmit", sessionId: "s-1" }),
        ensurePageReady: async () => ({ ready: true }),
        waitForEditor: async () => {},
        attachFiles: async () => {
          const err = new Error("Attachment chip not visible");
          err.code = "ATTACH_UPLOAD_FAILED";
          throw err;
        },
      },
    },
  });

  assert.equal(res.status, "failed");
  assert.equal(res.reason, "ATTACH_UPLOAD_FAILED");
  assert.deepEqual(closed, ["work-presubmit"]);
});
