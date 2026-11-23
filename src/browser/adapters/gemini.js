export const id = "gemini";
export const url = "https://gemini.google.com/app";
export const editorSelector = 'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"]';
export const stopSelector = [
  'main button[aria-label="Stop response"]',
  'main button[aria-label="停止回答"]',
  'main button[aria-label="Stop generating"]',
  'main button[aria-label="停止生成"]',
  'main button[aria-label="Stop"]',
  'main button[aria-label="停止"]',
  'conversation-container button[aria-label*="Stop"]',
  'conversation-container button[aria-label*="停止"]',
  '.stop-button',
].join(', ');
export const sendSelector = 'gem-icon-button.send-button.submit button';
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

export function buildDeleteConversationJs() {
  return `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const findVisible = (selectors) => {
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r || (r.width > 0 && r.height > 0)) {
          return el;
        }
      }
    }
    return null;
  };

  const waitElement = async (selectors, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = findVisible(selectors);
      if (found) return found;
      await sleep(150);
    }
    return null;
  };

  const menuSelectors = [
    'button[aria-label*="More options"]',
    'button[aria-label*="更多选项"]',
    'button[aria-label*="Chat options"]',
    'button[aria-label*="对话选项"]',
    'side-navigation-v2 [aria-selected="true"] button[aria-haspopup="menu"]',
    'mat-action-list [aria-current="page"] button',
    'top-bar button[aria-label*="options"]',
  ];

  const menuBtn = await waitElement(menuSelectors, 3500);
  if (!menuBtn) {
    return { success: false, reason: "menu_button_not_found" };
  }
  menuBtn.click();

  const deadlineMenu = Date.now() + 3000;
  let deleteItem = null;
  while (Date.now() < deadlineMenu) {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], .mat-mdc-menu-item, button.mat-menu-item'));
    for (const it of items) {
      const txt = (it.innerText || it.textContent || "").trim();
      const aria = it.getAttribute("aria-label") || "";
      if (/Delete|删除/i.test(txt) || /Delete|删除/i.test(aria)) {
        deleteItem = it;
        break;
      }
    }
    if (deleteItem) break;
    await sleep(150);
  }

  if (!deleteItem) {
    return { success: false, reason: "delete_menu_item_not_found" };
  }
  deleteItem.click();

  const deadlineConfirm = Date.now() + 3500;
  let confirmBtn = null;
  while (Date.now() < deadlineConfirm) {
    const btns = Array.from(document.querySelectorAll('mat-dialog-actions button, [role="dialog"] button, .mat-mdc-dialog-actions button'));
    for (const btn of btns) {
      const txt = (btn.innerText || btn.textContent || "").trim();
      if (/^(Delete|删除|确认删除)$/i.test(txt)) {
        confirmBtn = btn;
        break;
      }
    }
    if (confirmBtn) break;
    await sleep(150);
  }

  if (!confirmBtn) {
    return { success: false, reason: "confirm_button_not_found" };
  }
  confirmBtn.click();

  const deadlineVerify = Date.now() + 4000;
  while (Date.now() < deadlineVerify) {
    const dialogOpen = Boolean(document.querySelector('mat-dialog-container, [role="dialog"]'));
    if (!dialogOpen) {
      return { success: true };
    }
    await sleep(200);
  }

  return { success: true, verified: "timeout_waiting_dialog_close" };
})()`;
}
