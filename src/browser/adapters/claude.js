export const id = "claude";
export const url = "https://claude.ai/new";
export const editorSelector = 'div.ProseMirror[contenteditable="true"], [data-testid="chat-input"][contenteditable="true"]';
export const stopSelector = [
  'button[aria-label="Stop Response"]',
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="停止回复"]',
  'button[aria-label="停止生成"]',
].join(", ");
export const sendSelector = [
  'button[aria-label="Send Message"]',
  'button[aria-label="Send message"]',
  'button[aria-label="发送消息"]',
].join(", ");
export const challengeTitlePattern = /just a moment|please wait|checking your browser|cloudflare|verify you are human|人机验证|sign in|log in|登录/i;
export const turnChallengeTitlePattern = /just a moment|please wait|checking your browser|cloudflare|verify you are human|security check|unusual traffic|请稍候|人机验证/i;
export const fileInputSelector = 'input[type="file"][data-testid="file-upload"], input[type="file"]';

export function buildLoginProbeJs() {
  return `(() => {
  const host = location.hostname;
  const onProduct = host === "claude.ai" || host.endsWith(".claude.ai");
  if (!onProduct) {
    return { loggedIn: false, user: null, title: document.title || "", origin: location.origin, offOrigin: true };
  }
  const editor = document.querySelector(${JSON.stringify(editorSelector)});
  const loginForm = document.querySelector('input[type="email"], input[type="password"], button[data-testid="login-button"]');
  const signedIn = Boolean(editor) && !loginForm;
  return {
    loggedIn: signedIn,
    user: null,
    title: document.title || "",
    origin: location.origin,
    offOrigin: false,
  };
})()`;
}

export function buildReadStateJs() {
  return `(() => {
  const userNodes = [...document.querySelectorAll('[data-testid="user-message"], .font-user-message')];
  const assistantNodes = [...document.querySelectorAll('[data-is-streaming], .font-claude-message, [data-testid="assistant-message"]')];
  const userTurns = userNodes.length;
  const answerTurns = assistantNodes.length;

  const FENCE = String.fromCharCode(96, 96, 96);
  const LF = String.fromCharCode(10);
  const CODE_SEL = "pre";
  const extractVisibleText = (root) => {
    if (!root) return "";
    if (typeof root.cloneNode === "function") {
      try {
        const clone = root.cloneNode(true);
        if (typeof clone.querySelectorAll === "function") {
          for (const sr of clone.querySelectorAll('.sr-only, [class*="sr-only"], [data-testid="message-actions"], time[datetime]')) {
            if (typeof sr.remove === "function") sr.remove();
            else if (sr.parentElement && typeof sr.parentElement.removeChild === "function") sr.parentElement.removeChild(sr);
          }
        }
        return String(clone.innerText || clone.textContent || "").trim();
      } catch (e) {}
    }
    let raw = String(root.innerText || root.textContent || "").trim();
    const lines = raw.split(LF);
    if (lines.length > 1 && lines[0].indexOf("Claude") === 0 && (lines[0].indexOf("已回复") !== -1 || lines[0].toLowerCase().indexOf("said") !== -1 || lines[0].toLowerCase().indexOf("replied") !== -1)) {
      raw = lines.slice(1).join(LF).trim();
    }
    return raw;
  };
  const withCodeFences = (root) => {
    let text = extractVisibleText(root);
    const blocks = root && typeof root.querySelectorAll === "function"
      ? [...root.querySelectorAll(CODE_SEL)].filter((el) => !el.parentElement || !el.parentElement.closest(CODE_SEL))
      : [];
    let searchFrom = 0;
    for (const el of blocks) {
      const code = String((el.innerText || el.textContent) || "").trim();
      if (!code) continue;
      const idx = text.indexOf(code, searchFrom);
      if (idx === -1) continue;
      const head = text.slice(0, idx);
      text = head + FENCE + LF + code + LF + FENCE + text.slice(idx + code.length);
      searchFrom = head.length + code.length + 8;
    }
    return text;
  };

  let answerText = "";
  let answerActionsVisible = null;
  let streaming = false;
  const last = assistantNodes[assistantNodes.length - 1];
  if (last) {
    answerText = withCodeFences(last);
    if (typeof last.getAttribute === "function" && last.getAttribute("data-is-streaming") === "true") {
      streaming = true;
      answerActionsVisible = false;
    } else if (typeof last.getAttribute === "function" && last.getAttribute("data-is-streaming") === "false") {
      answerActionsVisible = true;
    }
  }

  const editor = document.querySelector(${JSON.stringify(editorSelector)});
  const editorEmpty = editor ? ((editor.innerText || editor.textContent || "").trim() === "") : null;
  const stopEl = document.querySelector(${JSON.stringify(stopSelector)});
  let stopVisible = streaming;
  if (stopEl && !stopVisible) {
    const r = typeof stopEl.getBoundingClientRect === "function" ? stopEl.getBoundingClientRect() : null;
    stopVisible = (!r || (r.width > 0 && r.height > 0)) && !stopEl.disabled;
  }

  const title = document.title || "";
  const hasChallenge = Boolean(
    document.querySelector('input[type="password"]') ||
    ${turnChallengeTitlePattern.toString()}.test(title)
  );
  const signedIn = Boolean(editor);
  const signedOut = Boolean(document.querySelector('input[type="email"], button[data-testid="login-button"]'));

  return JSON.stringify({
    userTurns,
    answerTurns,
    answerText,
    answerActionsVisible,
    pendingCount: 0,
    collapsed: false,
    stopVisible,
    editorEmpty,
    title,
    hasChallenge,
    loggedOut: !signedIn && signedOut,
    hasProseMirror: Boolean(editor),
    hasMobileComposer: false,
    signedIn,
    signedOut,
    pageError: null,
  });
})()`;
}

export function buildDeleteConversationJs(targetUrl, opts = {}) {
  // 基于 2026-11-28 真机 DOM 采样实现：
  // 1) 目标绑定：location.pathname 必须匹配 /chat/<id>，否则 target_url_mismatch。
  // 2) 入口按钮：严格唯一匹配标题行 button[data-testid="session-title-menu"]（排除 nav/aside，避免误点侧边栏分区按钮）。
  // 3) 删除项：在可见 [role="menu"] 内优先 [data-testid="delete-session-trigger"]，回退精确文本 "删除"/"Delete"。
  // 4) 确认框：可见 [role="alertdialog"]/[role="dialog"] 内点击精确文本 "删除"/"Delete" 按钮。
  // 5) 验证：route_changed / title_changed / sidebar_entry_removed。
  const cfg = {
    entryWaitMs: Number.isFinite(opts.entryWaitMs) ? opts.entryWaitMs : 4000,
    menuWaitMs: Number.isFinite(opts.menuWaitMs) ? opts.menuWaitMs : 4000,
    menuRetryMs: Number.isFinite(opts.menuRetryMs) ? opts.menuRetryMs : 1500,
    pollIntervalMs: Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 150,
  };
  return `(async () => {
  const cfg = ${JSON.stringify(cfg)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const waitFor = async (fn, timeoutMs, intervalMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(intervalMs || cfg.pollIntervalMs);
    }
    try { const v = fn(); if (v) return v; } catch (e) {}
    return null;
  };
  const normPath = (p) => {
    let s = String(p || "").split("?")[0].split("#")[0];
    while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  };
  const label = (el) => String((el && (el.innerText || el.textContent)) || "").trim();
  const isInNav = (el) => Boolean(el && typeof el.closest === "function" && el.closest('nav, aside, [role="navigation"]'));
  const triggerMenu = (btn, withPointer) => {
    if (withPointer) {
      try { if (typeof btn.focus === "function") btn.focus(); } catch (e) {}
      try {
        if (typeof btn.dispatchEvent === "function") {
          btn.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new Event("mouseup", { bubbles: true, cancelable: true }));
        }
      } catch (e) {}
    }
    btn.click();
  };
  try {
    const expectedPath = normPath(new URL(${JSON.stringify(targetUrl)}).pathname);
    const beforePath = normPath(location.pathname);
    if (beforePath !== expectedPath && beforePath.indexOf(expectedPath + "/") !== 0) {
      return { success: false, reason: "target_url_mismatch", expected: expectedPath, actual: location.pathname };
    }
    const beforeTitle = document.title;
    const findSidebarEntry = () => {
      const links = [...document.querySelectorAll('a[href^="/chat/"]')];
      return links.find((a) => normPath(a.getAttribute("href") || "") === beforePath && isVisible(a)) || null;
    };
    const hadEntry = Boolean(findSidebarEntry());
    const menuBtn = await waitFor(() => {
      const exact = [...document.querySelectorAll('button[data-testid="session-title-menu"]')]
        .filter((el) => isVisible(el) && !isInNav(el));
      return exact.length === 1 ? exact[0] : null;
    }, cfg.entryWaitMs, cfg.pollIntervalMs);
    if (!menuBtn) return { success: false, reason: "menu_button_not_found" };

    const findDeleteItem = () => {
      const menus = [...document.querySelectorAll('[role="menu"]')].filter(isVisible);
      for (const m of menus) {
        const byTestId = [...m.querySelectorAll('[data-testid="delete-session-trigger"]')].filter(isVisible);
        if (byTestId.length === 1) return byTestId[0];
        const byRole = [...m.querySelectorAll('[role="menuitem"]')].filter(isVisible);
        const matched = byRole.find((el) => { const t = label(el); return t === "删除" || t === "Delete"; });
        if (matched) return matched;
      }
      return null;
    };

    triggerMenu(menuBtn, false);
    let menuRetried = false;
    let deleteItem = await waitFor(findDeleteItem, Math.min(cfg.menuRetryMs, cfg.menuWaitMs), cfg.pollIntervalMs);
    if (!deleteItem && cfg.menuWaitMs > cfg.menuRetryMs) {
      menuRetried = true;
      triggerMenu(menuBtn, true);
      deleteItem = await waitFor(findDeleteItem, cfg.menuWaitMs - cfg.menuRetryMs, cfg.pollIntervalMs);
    }
    if (!deleteItem) return { success: false, reason: "delete_menu_item_not_found", menuRetried };
    deleteItem.click();

    const confirmBtn = await waitFor(() => {
      const dialogs = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].filter(isVisible);
      const dlg = dialogs.find((d) => {
        const text = String(d.innerText || d.textContent || "");
        return text.indexOf("删除") !== -1 || text.indexOf("Delete") !== -1 || text.indexOf("permanently") !== -1 || text.indexOf("永久删除") !== -1;
      });
      if (!dlg) return null;
      const btns = [...dlg.querySelectorAll("button")].filter(isVisible);
      return btns.find((b) => { const t = label(b); return t === "删除" || t === "Delete"; }) || null;
    }, 4000, cfg.pollIntervalMs);
    if (!confirmBtn) return { success: false, reason: "confirm_button_not_found", menuRetried };
    confirmBtn.click();

    const verified = await waitFor(() => {
      if (normPath(location.pathname) !== beforePath) return "route_changed";
      if (document.title !== beforeTitle) return "title_changed";
      if (hadEntry && !findSidebarEntry()) return "sidebar_entry_removed";
      return null;
    }, 8000, cfg.pollIntervalMs);
    if (!verified) return { success: false, reason: "delete_unverified", menuRetried };
    return { success: true, verified, menuRetried };
  } catch (err) {
    return { success: false, reason: "eval_error:" + (err && err.message ? err.message : String(err)) };
  }
})()`;
}
