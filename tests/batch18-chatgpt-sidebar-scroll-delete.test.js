import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";

function createDeleteDom({
  targetPath = "/c/6b09e50a-8e64-83ee-9686-abe0c6708931",
  initialLinks = [],
  pagesOnScroll = [],
  hasScroller = true,
  wrongAriaCurrentHref = null,
} = {}) {
  const clickedRows = [];
  let menuOpen = false;
  let dialogOpen = false;
  let scrollLoads = 0;

  const location = { pathname: targetPath };
  const docState = { title: "Reply Exactly R20 NAMED" };

  const makeLinkRow = (href, { ariaCurrent = null } = {}) => {
    const menuBtn = {
      isConnected: true,
      tagName: "BUTTON",
      getAttribute: (k) => (k === "aria-label" ? "聊天操作" : null),
      getBoundingClientRect: () => ({ width: 24, height: 24 }),
      click() {
        clickedRows.push(href);
        menuOpen = true;
      },
    };
    const row = {
      isConnected: true,
      tagName: "LI",
      parentElement: null,
      querySelectorAll: (sel) => (sel.includes("聊天操作") ? [menuBtn] : []),
    };
    const anchor = {
      isConnected: true,
      tagName: "A",
      parentElement: row,
      getAttribute: (k) => {
        if (k === "href") return href;
        if (k === "aria-current") return ariaCurrent;
        return null;
      },
      getBoundingClientRect: () => ({ width: 180, height: 32 }),
      scrollIntoView() {},
    };
    return { anchor, row };
  };

  const rows = [];
  const scroller = hasScroller
    ? {
        isConnected: true,
        tagName: "DIV",
        parentElement: { tagName: "BODY" },
        clientHeight: 983,
        scrollHeight: 1038,
        _scrollTop: 0,
        get scrollTop() {
          return this._scrollTop;
        },
        set scrollTop(v) {
          this._scrollTop = v;
          if (scrollLoads < pagesOnScroll.length) {
            const batch = pagesOnScroll[scrollLoads++];
            for (const href of batch) {
              const item = makeLinkRow(href);
              item.row.parentElement = scroller;
              rows.push(item);
            }
            this.scrollHeight += 300;
          }
        },
        dispatchEvent() {},
        querySelectorAll: () => [],
      }
    : null;

  for (const href of initialLinks) {
    const item = makeLinkRow(href, {
      ariaCurrent: wrongAriaCurrentHref === href ? "page" : null,
    });
    item.row.parentElement = scroller || { tagName: "BODY" };
    rows.push(item);
  }

  const deleteMenuItem = {
    isConnected: true,
    innerText: "删除\nCtrl+Del",
    querySelectorAll: (sel) => (sel === '[role="menuitem"]' ? [deleteMenuItem] : []),
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    click() {
      menuOpen = false;
      dialogOpen = true;
    },
  };

  const confirmDeleteBtn = {
    isConnected: true,
    innerText: "删除聊天",
    getBoundingClientRect: () => ({ width: 90, height: 32 }),
    click() {
      dialogOpen = false;
      location.pathname = "/";
    },
  };

  const dialog = {
    isConnected: true,
    className: "modal-dialog",
    innerText: "删除聊天？",
    getBoundingClientRect: () => ({ width: 400, height: 200 }),
    querySelectorAll: (sel) => (sel === "button" ? [confirmDeleteBtn] : []),
  };

  const document = {
    get title() { return docState.title; },
    body: { innerText: "" },
    querySelectorAll(sel) {
      if (sel === 'a[href^="/c/"]') return rows.map((r) => r.anchor);
      if (sel === 'a[aria-current="page"][href^="/c/"]') {
        return rows.map((r) => r.anchor).filter((a) => a.getAttribute("aria-current") === "page");
      }
      if (sel.includes("nav, aside")) return scroller ? [scroller] : [];
      if (sel.includes('[role="menu"]') || sel === '[role="menuitem"]') {
        return menuOpen ? [deleteMenuItem] : [];
      }
      if (sel.includes('div[role="dialog"][aria-modal="true"]')) {
        return dialogOpen ? [dialog] : [];
      }
      return [];
    },
  };

  const window = {
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", overflowY: "auto" }),
  };

  return { document, window, location, clickedRows, scroller };
}

const FAST_OPTS = {
  initialWaitMs: 30,
  maxScrollSteps: 5,
  scrollSettleMs: 40,
  maxNoGrowthSteps: 2,
  totalLinkTimeoutMs: 500,
  pollIntervalMs: 10,
};

test("chatgpt delete: fast path deletes recent conversation in initial 20 without scrolling", async () => {
  const target = "/c/6b09e50a-recent";
  const initial = Array.from({ length: 19 }, (_, i) => `/c/other-${i}`).concat([target]);
  const dom = createDeleteDom({ targetPath: target, initialLinks: initial });

  const js = chatgptAdapter.buildDeleteConversationJs(`https://chatgpt.com${target}`, FAST_OPTS);
  const res = await vm.runInNewContext(js, { ...dom, URL, Event, setTimeout });
  assert.equal(res.success, true);
  assert.equal(res.verified, "route_changed");
  assert.deepEqual(dom.clickedRows, [target]);
  assert.equal(dom.scroller._scrollTop, 0, "fast path must not scroll");
});

test("chatgpt delete: scrolls lazy-loaded sidebar to find older conversation outside first 20 and deletes ONLY target", async () => {
  const target = "/c/6b09e50a-8e64-83ee-9686-abe0c6708931";
  const initial = Array.from({ length: 20 }, (_, i) => `/c/recent-${i}`);
  const dom = createDeleteDom({
    targetPath: target,
    initialLinks: initial,
    pagesOnScroll: [
      ["/c/older-1", "/c/older-2", "/c/older-3"],
      ["/c/older-4", target, "/c/older-5"],
    ],
  });

  const js = chatgptAdapter.buildDeleteConversationJs(`https://chatgpt.com${target}`, FAST_OPTS);
  const res = await vm.runInNewContext(js, { ...dom, URL, Event, setTimeout });
  assert.equal(res.success, true);
  assert.equal(res.verified, "route_changed");
  assert.deepEqual(dom.clickedRows, [target], "must click ONLY the target conversation's menu");
  assert.ok(dom.scroller._scrollTop > 0);
});

test("chatgpt delete: never clicks a different conversation even if it wrongly holds aria-current=page", async () => {
  const target = "/c/6b09e50a-target";
  const wrong = "/c/other-active";
  const dom = createDeleteDom({
    targetPath: target,
    initialLinks: [wrong, "/c/other-2"],
    wrongAriaCurrentHref: wrong,
    pagesOnScroll: [],
  });

  const js = chatgptAdapter.buildDeleteConversationJs(`https://chatgpt.com${target}`, FAST_OPTS);
  const res = await vm.runInNewContext(js, { ...dom, URL, Event, setTimeout });
  assert.equal(res.success, false);
  assert.equal(res.reason, "current_session_link_not_found");
  assert.deepEqual(dom.clickedRows, [], "must never click a non-matching conversation");
});

test("chatgpt delete: stops boundedly at maxNoGrowthSteps when reaching sidebar bottom without target", async () => {
  const target = "/c/6b09e50a-missing";
  const dom = createDeleteDom({
    targetPath: target,
    initialLinks: Array.from({ length: 20 }, (_, i) => `/c/recent-${i}`),
    pagesOnScroll: [],
  });

  const js = chatgptAdapter.buildDeleteConversationJs(`https://chatgpt.com${target}`, FAST_OPTS);
  const res = await vm.runInNewContext(js, { ...dom, URL, Event, setTimeout });
  assert.equal(res.success, false);
  assert.equal(res.reason, "current_session_link_not_found");
  assert.equal(res.scrolledSteps, 2, "must stop early after maxNoGrowthSteps=2");
  assert.equal(res.scrollerFound, true);
  assert.equal(res.finalLinkCount, 20);
  assert.deepEqual(dom.clickedRows, []);
});

test("chatgpt delete: returns current_session_link_not_found cleanly when sidebar is not scrollable", async () => {
  const target = "/c/6b09e50a-collapsed";
  const dom = createDeleteDom({
    targetPath: target,
    initialLinks: ["/c/recent-0"],
    hasScroller: false,
  });

  const js = chatgptAdapter.buildDeleteConversationJs(`https://chatgpt.com${target}`, FAST_OPTS);
  const res = await vm.runInNewContext(js, { ...dom, URL, Event, setTimeout });
  assert.equal(res.success, false);
  assert.equal(res.reason, "current_session_link_not_found");
  assert.equal(res.scrolledSteps, 0);
  assert.equal(res.scrollerFound, false);
});
