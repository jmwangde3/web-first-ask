export const id = "gemini";
export const url = "https://gemini.google.com/app";
export const editorSelector = 'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"]';
export const stopSelector = [
  // 真机核实（2026-11-24）：生成中的停止按钮不在 <main> 内，
  // 旧选择器的 main 前缀导致 stopVisible 恒为 false，长回答被提前判定完成。
  'button[aria-label="Stop response"]',
  'button[aria-label="停止回答"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="停止生成"]',
  'button[aria-label="Stop"]',
  'button[aria-label="停止"]',
  'conversation-container button[aria-label*="Stop"]',
  'conversation-container button[aria-label*="停止"]',
  '.stop-button',
].join(', ');
// 真机核实（2026-11-24）：Gemini 改版后发送按钮为 aria-label="Send message"（中文 UI 为「发送消息」），
// 旧的 gem-icon-button.send-button.submit 已不存在，导致点击不生效、send_unconfirmed。
export const sendSelector = 'button[aria-label="Send message"], button[aria-label="发送消息"]';
export const challengeTitlePattern = /请稍候|just a moment|verifying|security check|cloudflare|人机验证|sign in|log in|登录/i;
export const turnChallengeTitlePattern = /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;

export function buildLoginProbeJs() {
  return `(() => {
  const host = location.hostname;
  const onProduct = host === "gemini.google.com";
  if (!onProduct) {
    return { loggedIn: false, user: null, title: document.title || "", origin: location.origin, offOrigin: true };
  }
  const title = document.title || "";
  const signedInSelectors = [
    'button[aria-label*="Google 账号"]',
    'img[aria-label*="个人资料"]',
    'a[href*="accounts.google.com/SignOutOptions"]'
  ];
  const signedOutSelectors = [
    'a[href*="accounts.google.com/ServiceLogin"]',
    'a[href*="accounts.google.com/AccountChooser"]'
  ];
  const matchedSignedIn = signedInSelectors.filter(s => Boolean(document.querySelector(s)));
  const matchedSignedOut = signedOutSelectors.filter(s => Boolean(document.querySelector(s)));
  const signedIn = matchedSignedIn.length > 0;
  const signedOut = matchedSignedOut.length > 0;
  const loggedIn = signedIn && !signedOut;
  return {
    loggedIn,
    user: null,
    title,
    origin: location.origin,
    signedIn,
    signedOut,
    matchedSignedIn,
    matchedSignedOut
  };
})()`;
}

export function buildAnswerTextJs() {
  return `(() => {
  const n = document.querySelectorAll("model-response");
  const last = n[n.length - 1];
  if (!last) return "";
  const body = last.querySelector("message-content, .markdown") ?? last;
  return ((body.innerText || body.textContent || "").trim()).replace(/^(Gemini|Bard)\\s*(said|说)\\s*[:：]?\\s*/i, "").trim();
})()`;
}

export function buildReadStateJs() {
  return `(() => {
  const userTurns = document.querySelectorAll("user-query").length;
  const modelResponses = document.querySelectorAll("model-response");
  const answerTurns = modelResponses.length;

  let answerText = "";
  const last = modelResponses[modelResponses.length - 1];
  if (last) {
    const body = last.querySelector("message-content, .markdown") ?? last;
    answerText = ((body.innerText || body.textContent || "").trim()).replace(/^(Gemini|Bard)\\s*(said|说)\\s*[:：]?\\s*/i, "").trim();
  }

  const editor = document.querySelector('rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"]');
  const editorEmpty = editor ? ((editor.innerText || editor.textContent || "").trim() === "") : null;

  const stopEl = document.querySelector(${JSON.stringify(stopSelector)});
  let stopVisible = false;
  if (stopEl) {
    if (typeof stopEl.getBoundingClientRect === "function") {
      const r = stopEl.getBoundingClientRect();
      stopVisible = r.width > 0 && r.height > 0 && !stopEl.disabled;
    } else {
      stopVisible = !stopEl.disabled;
    }
  }

  const title = document.title || "";
  const hasChallenge = Boolean(
    document.querySelector('input[type="password"]') ||
    ${turnChallengeTitlePattern.toString()}.test(title)
  );

  const signedInEl = document.querySelector(
    'button[aria-label*="Google 账号"], button[aria-label*="Google Account"], ' +
    'img[aria-label*="个人资料"], img[aria-label*="Profile"], ' +
    'a[href*="accounts.google.com/SignOutOptions"]'
  );
  const signedOutEl = document.querySelector(
    'button[aria-label*="登录"], button[aria-label*="Sign in"], button[aria-label*="Sign In"], ' +
    'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/AccountChooser"]'
  );
  const signedIn = Boolean(signedInEl);
  const signedOut = Boolean(signedOutEl);
  const loggedOut = userTurns === 0 && !signedIn && signedOut;

  const alertEls = document.querySelectorAll('[role="alert"], [data-testid*="error"], div[class*="text-red-"]');
  let pageError = null;
  for (const el of alertEls) {
    let visible = false;
    if (typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      visible = r.width > 0 && r.height > 0;
    } else {
      visible = true;
    }
    if (!visible) continue;
    const txt = (el.innerText || el.textContent || "").trim();
    if (txt.length > 0) {
      const isRateLimit = /limit|too many requests|rate limit|try again later|429|达到限制|请求过于频繁|请稍后重试|次数过多/i.test(txt);
      const isInvalidated = /conversation not found|chat not found|context length|maximum context|对话不存在|上下文过长|会话已失效/i.test(txt);
      pageError = {
        reason: isInvalidated ? "conversation_invalidated" : (isRateLimit ? "provider_rate_limited" : "provider_error"),
        message: txt.slice(0, 300),
      };
      break;
    }
  }

  return JSON.stringify({
    userTurns,
    answerTurns,
    answerText,
    stopVisible,
    editorEmpty,
    title,
    hasChallenge,
    loggedOut,
    signedIn,
    signedOut,
    pageError,
  });
})()`;
}

export function buildDeleteConversationJs(targetUrl) {
  // 三方审核加固（2026-11-24）：
  // 1) 目标绑定：脚本入参 targetUrl，location.pathname 不匹配则拒绝执行。
  // 2) 入口唯一性：精确 aria 且必须恰好一个可见；模糊回退排除导航容器且必须唯一。
  // 3) 菜单项限定在打开的菜单容器内并过滤可见性。
  // 4) 确认框必须归属 Delete chat（aria-label 或标题文案），按钮在框内精确匹配。
  // 5) 验证组合：路由变化 / 标题变化 / 侧边栏条目消失 / 不存在提示。
  return `(async () => {
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
      await sleep(intervalMs || 150);
    }
    return null;
  };
  const label = (el) => String((el && (el.innerText || el.textContent)) || "").trim();
  try {
    const expectedPath = new URL(${JSON.stringify(targetUrl)}).pathname;
    if (location.pathname.indexOf(expectedPath) !== 0) {
      return { success: false, reason: "target_url_mismatch", expected: expectedPath, actual: location.pathname };
    }
    const beforePath = location.pathname;
    const beforeTitle = document.title;
    const convId = expectedPath.split("/").pop();
    const findEntry = () => {
      const links = [...document.querySelectorAll('a[href*="/app/"]')];
      return links.find((a) => (a.getAttribute("href") || "").indexOf(convId) !== -1 && isVisible(a)) || null;
    };
    const hadEntry = Boolean(findEntry());
    const menuBtn = await waitFor(() => {
      const exact = [...document.querySelectorAll('button[aria-label="Open menu for conversation actions."]')].filter(isVisible);
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return null;
      const loose = [...document.querySelectorAll('button[aria-label*="conversation actions"], button[aria-label*="会话操作"], button[aria-label*="对话操作"]')]
        .filter((el) => isVisible(el) && !el.closest("nav, aside, [role=navigation]"));
      return loose.length === 1 ? loose[0] : null;
    }, 10000);
    if (!menuBtn) return { success: false, reason: "menu_button_not_found" };
    menuBtn.click();
    const deleteItem = await waitFor(() => {
      const menus = [...document.querySelectorAll('gem-menu, [role="menu"], .mat-mdc-menu-panel')].filter(isVisible);
      const pool = [];
      for (const m of menus) {
        for (const it of m.querySelectorAll('[role="menuitem"]')) {
          if (isVisible(it)) pool.push(it);
        }
      }
      const all = pool.length ? pool : [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible);
      return all.find((el) => { const t = label(el); return t === "Delete" || t === "删除"; }) || null;
    }, 4000);
    if (!deleteItem) return { success: false, reason: "delete_menu_item_not_found" };
    deleteItem.click();
    const confirmBtn = await waitFor(() => {
      const dialogs = [...document.querySelectorAll('mat-dialog-container[role="dialog"], [role="dialog"]')].filter(isVisible);
      const dlg = dialogs.find((d) => {
        const aria = String(d.getAttribute("aria-label") || "").trim().toLowerCase();
        const text = String(d.innerText || "");
        return aria === "delete chat" || text.indexOf("Delete chat") !== -1 || text.indexOf("删除聊天") !== -1 || text.indexOf("删除对话") !== -1;
      });
      if (!dlg) return null;
      return [...dlg.querySelectorAll("button")].find((b) => { const t = label(b); return isVisible(b) && (t === "Delete" || t === "删除"); }) || null;
    }, 4000);
    if (!confirmBtn) return { success: false, reason: "confirm_button_not_found" };
    confirmBtn.click();
    const verified = await waitFor(() => {
      if (location.pathname !== beforePath) return "route_changed";
      if (document.title !== beforeTitle) return "title_changed";
      if (hadEntry && !findEntry()) return "sidebar_entry_removed";
      const body = String(document.body.innerText || "");
      if (body.indexOf("not found") !== -1 || body.indexOf("找不到") !== -1 || body.indexOf("不存在") !== -1) return "state_changed";
      return null;
    }, 8000);
    if (!verified) return { success: false, reason: "delete_unverified" };
    return { success: true, verified };
  } catch (err) {
    return { success: false, reason: "eval_error:" + (err && err.message ? err.message : String(err)) };
  }
})()`;
}
