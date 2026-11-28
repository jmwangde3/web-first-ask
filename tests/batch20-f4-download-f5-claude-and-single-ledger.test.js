import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as claudeAdapter from "../src/browser/adapters/claude.js";
import {
  collectDownloads,
  snapshotDownloadDir,
  triggerAndWaitForDownloads,
} from "../src/browser/driver.js";
import { recordDeletedUrl } from "../src/browser/cleanup-ledger.js";
import { runCdpCommand } from "../src/engines/cdp-cli.js";

function createMockStream() {
  let buf = "";
  return { write(s) { buf += String(s); }, get output() { return buf; } };
}

function makeEl(tag, attrs = {}, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    innerText: opts.innerText ?? "",
    textContent: opts.textContent ?? opts.innerText ?? "",
    className: opts.className ?? attrs.class ?? "",
    isConnected: opts.isConnected ?? true,
    disabled: Boolean(opts.disabled),
    parentElement: null,
    children: [],
    clicked: 0,
    events: [],
    getAttribute(name) {
      if (name === "class") return this.className || null;
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    getBoundingClientRect() { return opts.hidden ? { width: 0, height: 0 } : { width: 100, height: 32 }; },
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
      return true;
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      }
    },
    cloneNode(deep) {
      const copy = makeEl(this.tagName, { ...this.attrs }, {
        innerText: this.innerText,
        textContent: this.textContent,
        className: this.className,
        isConnected: this.isConnected,
        disabled: this.disabled,
      });
      if (deep) {
        for (const c of this.children) {
          const cc = c.cloneNode(true);
          cc.parentElement = copy;
          copy.children.push(cc);
        }
        Object.defineProperty(copy, "innerText", {
          get() {
            if (this.children.length === 0) return this.textContent;
            return this.children.map((c) => c.innerText).filter(Boolean).join("\n");
          },
        });
      }
      return copy;
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
  const classMatches = [...rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
  for (const cm of classMatches) {
    const classes = String(el.className || "").split(/\s+/);
    if (!classes.includes(cm[1])) return false;
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

test("single cleanup --url skips already_deleted from ledger without launching Chrome, and --force overrides", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-single-ledger-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await recordDeletedUrl(home, "https://gemini.google.com/app/6e6f2f2efae04cae", { provider: "gemini", verified: "title_changed" });

  let browserCalled = 0;
  const out1 = createMockStream();
  const res1 = await runCdpCommand(
    ["cleanup", "--provider", "gemini", "--url", "https://gemini.google.com/u/0/app/6e6f2f2efae04cae", "--json"],
    {
      home,
      stdout: out1,
      stderr: createMockStream(),
      recoverBrowser: async () => { browserCalled += 1; return { chrome: { port: 9222 } }; },
    },
  );
  assert.equal(res1.code, 0);
  assert.equal(browserCalled, 0);
  assert.deepEqual(JSON.parse(out1.output), {
    status: "skipped",
    reason: "already_deleted",
    provider: "gemini",
    url: "https://gemini.google.com/u/0/app/6e6f2f2efae04cae",
  });

  // With --force, bypasses ledger and proceeds to delete
  const out2 = createMockStream();
  const res2 = await runCdpCommand(
    ["cleanup", "--provider", "gemini", "--url", "https://gemini.google.com/app/6e6f2f2efae04cae", "--force", "--json"],
    {
      home,
      stdout: out2,
      stderr: createMockStream(),
      adapters: { gemini: { buildDeleteConversationJs: () => "Promise.resolve({ success: true })" } },
      recoverBrowser: async () => { browserCalled += 1; return { chrome: { port: 9222 } }; },
      connectCdp: async () => ({
        async send(method) {
          if (method === "Runtime.evaluate") return { result: { value: { success: true, verified: "route_changed" } } };
          return {};
        },
        close() {},
      }),
      driver: {
        openTab: async () => ({ targetId: "t1", sessionId: "s1" }),
        closeTab: async () => {},
      },
    },
  );
  assert.equal(res2.code, 0);
  assert.equal(browserCalled, 1);
  assert.equal(JSON.parse(out2.output).status, "deleted");
});

test("F4: chatgpt buildDownloadTriggerJs clicks 下载文件 (not preview) and triggerAndWaitForDownloads waits for finalized file", async (t) => {
  const dlDir = await mkdtemp(path.join(os.tmpdir(), "wfa-f4-trigger-"));
  t.after(() => rm(dlDir, { recursive: true, force: true }));
  const beforeFiles = await snapshotDownloadDir(dlDir);

  const root = makeEl("div");
  const previewBtn = append(root, makeEl("button", { "aria-label": "打开 data.csv 的预览" }));
  const downloadBtn = append(root, makeEl("button", { "aria-label": "下载文件" }));

  const cdp = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        const res = vm.runInNewContext(params.expression, {
          document: { querySelectorAll: (s) => root.querySelectorAll(s) },
          window: { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
        });
        if (res.clickedCount > 0) {
          const partPath = path.join(dlDir, "data.csv.crdownload");
          const finalPath = path.join(dlDir, "data.csv");
          await writeFile(partPath, "a,b\n1,2\n", "utf8");
          setTimeout(() => { rename(partPath, finalPath).catch(() => {}); }, 30);
        }
        return { result: { value: res } };
      }
      return {};
    },
  };

  const trig = await triggerAndWaitForDownloads(cdp, "sess-1", chatgptAdapter, {
    downloadDir: dlDir,
    beforeFiles,
    timeoutMs: 2000,
    pollMs: 15,
  });
  assert.equal(trig.clickedCount, 1);
  assert.equal(downloadBtn.clicked, 1);
  assert.equal(previewBtn.clicked, 0);

  const collected = await collectDownloads({ downloadDir: dlDir, beforeFiles });
  assert.equal(collected?.length, 1);
  assert.equal(collected[0].name, "data.csv");
  assert.equal(collected[0].bytes, 8);
  assert.match(collected[0].sha256, /^[0-9a-f]{64}$/);
});

test("F5: claude buildReadStateJs strips h3.sr-only prefix like Claude 已回复：...", () => {
  const root = makeEl("div");
  const msg = append(root, makeEl("div", { "data-testid": "assistant-message", "data-is-streaming": "false" }));
  append(msg, makeEl("h3", { class: "sr-only select-none" }, { innerText: "Claude 已回复：P28_CLAUDE" }));
  append(msg, makeEl("p", {}, { innerText: "P28_CLAUDE" }));
  const actionsWrap = append(msg, makeEl("div"));
  const actions = append(actionsWrap, makeEl("div", { "data-testid": "message-actions" }));
  append(actions, makeEl("time", { datetime: "2026-11-28T12:09:52.773Z" }, { innerText: "现在" }));

  const raw = vm.runInNewContext(claudeAdapter.buildReadStateJs(), {
    document: {
      title: "P28_CLAUDE - Claude",
      querySelector: () => null,
      querySelectorAll: (s) => root.querySelectorAll(s),
    },
  });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.answerText, "P28_CLAUDE");
  assert.equal(parsed.answerActionsVisible, true);
});

test("F5: claude buildDeleteConversationJs deletes via session-title-menu + delete-session-trigger + alertdialog, ignoring sidebar nav buttons", async () => {
  const root = makeEl("div");
  const nav = append(root, makeEl("nav"));
  const sidebarBtn = append(nav, makeEl("button", { "data-testid": "session-title-menu", "aria-label": "Pinned 的更多选项" }));

  let menuOpen = false;
  let dlgOpen = false;
  const titleMenuBtn = append(root, makeEl("button", { "data-testid": "session-title-menu", "aria-label": "P28_CLAUDE 的更多选项" }, {
    onClick() { menuOpen = true; },
  }));
  const menu = append(root, makeEl("div", { role: "menu" }));
  menu.getBoundingClientRect = () => (menuOpen ? { width: 160, height: 180 } : { width: 0, height: 0 });
  const delTrigger = append(menu, makeEl("div", { role: "menuitem", "data-testid": "delete-session-trigger" }, {
    innerText: "删除",
    onClick() { dlgOpen = true; },
  }));
  delTrigger.getBoundingClientRect = () => (menuOpen ? { width: 140, height: 32 } : { width: 0, height: 0 });

  const dlg = append(root, makeEl("div", { role: "alertdialog" }, { innerText: "删除 1 个会话？ 这 1 个会话将被永久删除。此操作无法撤销。" }));
  dlg.getBoundingClientRect = () => (dlgOpen ? { width: 360, height: 180 } : { width: 0, height: 0 });
  const cancelBtn = append(dlg, makeEl("button", {}, { innerText: "取消" }));
  const confirmBtn = append(dlg, makeEl("button", {}, { innerText: "删除" }));
  cancelBtn.getBoundingClientRect = () => (dlgOpen ? { width: 80, height: 32 } : { width: 0, height: 0 });
  confirmBtn.getBoundingClientRect = () => (dlgOpen ? { width: 80, height: 32 } : { width: 0, height: 0 });

  const location = { pathname: "/chat/90f6e1ee-cca6-4269-b80a-27e04ae7098f" };
  confirmBtn.click = () => {
    confirmBtn.clicked += 1;
    location.pathname = "/new";
  };

  const js = claudeAdapter.buildDeleteConversationJs(
    "https://claude.ai/chat/90f6e1ee-cca6-4269-b80a-27e04ae7098f",
    { entryWaitMs: 60, menuWaitMs: 200, menuRetryMs: 60, pollIntervalMs: 15 },
  );
  const res = await vm.runInContext(js, vm.createContext({
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
    document: { title: "P28_CLAUDE - Claude", body: { innerText: "" }, querySelectorAll: (s) => root.querySelectorAll(s) },
    location,
    URL,
    Event: class { constructor(t) { this.type = t; } },
    setTimeout, Date, Number, String, Boolean, Array, Object,
  }));

  assert.equal(res.success, true);
  assert.equal(res.verified, "route_changed");
  assert.equal(titleMenuBtn.clicked, 1);
  assert.equal(sidebarBtn.clicked, 0);
  assert.equal(confirmBtn.clicked, 1);
  assert.equal(cancelBtn.clicked, 0);

  // Mismatched URL must fail closed
  const bad = await vm.runInContext(
    claudeAdapter.buildDeleteConversationJs("https://claude.ai/chat/other-id", { entryWaitMs: 50, pollIntervalMs: 15 }),
    vm.createContext({
      window: { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
      document: { title: "Claude", body: { innerText: "" }, querySelectorAll: () => [] },
      location: { pathname: "/chat/90f6e1ee-cca6-4269-b80a-27e04ae7098f" },
      URL, Event: class {}, setTimeout, Date, Number, String, Boolean, Array, Object,
    }),
  );
  assert.equal(bad.success, false);
  assert.equal(bad.reason, "target_url_mismatch");
});
