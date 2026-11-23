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
  // 真机未验证：当前选择器可能命中侧边栏其它会话的菜单，存在误删风险。
  // 在逐家真机确认菜单/确认流程前，一律拒绝执行删除。
  return `(() => ({ success: false, reason: "delete_flow_unverified" }))()`;
}
