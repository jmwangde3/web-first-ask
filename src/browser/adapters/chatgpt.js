export const id = "chatgpt";
export const url = "https://chatgpt.com/";
export const editorSelector = '#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea#mobile-composer-prompt, [role="textbox"][contenteditable="true"]';
export const stopSelector = 'button[data-testid="stop-button"], main button[aria-label="Stop generating"], main button[aria-label="停止生成"]';
export const sendSelector = 'form:has([contenteditable="true"], textarea) button[type="submit"], button[data-testid="send-button"], button[type="submit"][aria-label="发送"], button[type="submit"][aria-label="Send"]';
export const challengeTitlePattern = /请稍候|just a moment|verifying|security check|cloudflare|人机验证/i;
export const turnChallengeTitlePattern = /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;

export function buildLoginProbeJs() {
  return `(() => (async () => {
  const host = location.hostname;
  const onProduct = host === "chatgpt.com" || host === "www.chatgpt.com";
  if (!onProduct) {
    return { loggedIn: false, user: null, title: document.title || "", origin: location.origin, offOrigin: true };
  }
  const title = document.title || "";
  let user = null, apiError = null;
  try {
    const res = await fetch("/api/auth/session", { credentials: "include" });
    const body = await res.json();
    user = body && body.user ? (body.user.email || body.user.id || "user") : null;
  } catch (error) { apiError = String(error); }
  const editor = Boolean(document.querySelector('div.ProseMirror[contenteditable="true"]'))
    && !document.querySelector('textarea#mobile-composer-prompt');
  return { loggedIn: Boolean(user), user, title, origin: location.origin, editor, apiError };
})())()`;
}

export function buildAnswerTextJs() {
  return `(() => {
  const hs = [...document.querySelectorAll("h4")].filter((h) => {
    const t = (h.innerText || h.textContent || "").trim();
    return /(说\\s*[:：]|said\\s*[:：]?)\\s*$/i.test(t) && !/^(你|You)/i.test(t);
  });
  const h = hs[hs.length - 1];
  const n = h && h.nextElementSibling;
  return n ? (n.innerText || n.textContent || "").trim() : "";
})()`;
}

export function buildReadStateJs() {
  return `(() => {
  const allH4 = [...document.querySelectorAll("h4")];
  const userHs = allH4.filter((h) => {
    const t = (h.innerText || h.textContent || "").trim();
    return /(说\\s*[:：]|said\\s*[:：]?)\\s*$/i.test(t) && /^(你|You)/i.test(t);
  });
  let userTurns = userHs.length;
  if (userTurns === 0) {
    userTurns = document.querySelectorAll('article[data-message-author-role="user"]').length;
  }

  const assistantHs = allH4.filter((h) => {
    const t = (h.innerText || h.textContent || "").trim();
    return /(说\\s*[:：]|said\\s*[:：]?)\\s*$/i.test(t) && !/^(你|You)/i.test(t);
  });
  let answerTurns = assistantHs.length;
  if (answerTurns === 0) {
    answerTurns = document.querySelectorAll('article[data-message-author-role="assistant"]').length;
  }

  let answerText = "";
  const lastH = assistantHs[assistantHs.length - 1];
  const nextEl = lastH && lastH.nextElementSibling;
  if (nextEl) {
    answerText = (nextEl.innerText || nextEl.textContent || "").trim();
  } else if (answerTurns > 0) {
    const articles = document.querySelectorAll('article[data-message-author-role="assistant"]');
    const lastArt = articles[articles.length - 1];
    if (lastArt) {
      answerText = (lastArt.innerText || lastArt.textContent || "").trim();
    }
  }

  const ed = document.querySelector(${JSON.stringify(editorSelector)});
  const editorEmpty = ed ? ((("value" in ed) ? ed.value : (ed.innerText || ed.textContent || "")).trim() === "") : null;

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

  const hasProseMirror = Boolean(document.querySelector('div.ProseMirror[contenteditable="true"]'));
  const hasMobileComposer = Boolean(document.querySelector('textarea#mobile-composer-prompt'));
  const loggedOut = !hasProseMirror && hasMobileComposer;

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
    hasProseMirror,
    hasMobileComposer,
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
    'button[data-testid="conversation-actions-button"]',
    'button[aria-label="Chat actions"]',
    'button[aria-label="聊天操作"]',
    'button[aria-label="Conversation options"]',
    'button[aria-label="更多操作"]',
    'nav li a[aria-current="page"] + div button',
    'header button[aria-haspopup="menu"]',
  ];

  const menuBtn = await waitElement(menuSelectors, 3500);
  if (!menuBtn) {
    return { success: false, reason: "menu_button_not_found" };
  }
  menuBtn.click();

  const deleteItemSelectors = [
    '[role="menuitem"][data-testid*="delete"]',
    '[role="menuitem"][data-testid="delete-chat-button"]',
    'div[role="menuitem"] span.text-token-text-error',
    '[role="menuitem"]',
  ];

  const deadlineMenu = Date.now() + 3000;
  let deleteItem = null;
  while (Date.now() < deadlineMenu) {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], div[role="menu"] button, ul[role="menu"] li'));
    for (const it of items) {
      const txt = (it.innerText || it.textContent || "").trim();
      if (/Delete|删除/i.test(txt)) {
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

  const confirmBtnSelectors = [
    'button[data-testid="confirm-delete-button"]',
    'button.btn-danger',
    '[role="dialog"] button.btn-danger',
    '[role="dialog"] button',
  ];

  const deadlineConfirm = Date.now() + 3500;
  let confirmBtn = null;
  while (Date.now() < deadlineConfirm) {
    const btns = Array.from(document.querySelectorAll('[role="dialog"] button, div[role="alertdialog"] button, .modal button'));
    for (const btn of btns) {
      const txt = (btn.innerText || btn.textContent || "").trim();
      if (/^(Delete|删除|确认删除)$/i.test(txt) || /btn-danger/.test(btn.className || "")) {
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
    const dialogOpen = Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'));
    if (!dialogOpen) {
      return { success: true };
    }
    await sleep(200);
  }

  return { success: true, verified: "timeout_waiting_dialog_close" };
})()`;
}
