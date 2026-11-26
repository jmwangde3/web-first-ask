// F5 — Claude web adapter (2026-11-26).
//
// Interface mirrors src/browser/adapters/chatgpt.js and gemini.js exactly:
// id / url / editorSelector / stopSelector / sendSelector / challenge
// patterns, buildUploadJs / buildAttachmentVerifyJs, buildDownloadClickJs,
// buildLoginProbeJs, buildAnswerTextJs, buildReadStateJs,
// buildDeleteConversationJs. The engine, driver and `wfa cdp login` path
// consume the adapter only through those exports.
//
// !!! ALL Claude DOM selectors below are BEST-EFFORT and UNVERIFIED !!!
//
// No live Claude web DOM was available when this file was written, so every
// selector is a placeholder derived from the conventions of the other two
// adapters (role attributes, aria-labels, generic hooks) and from the
// publicly known claude.ai URL shapes (app at claude.ai, conversations at
// /chat/<id>, new chat at /new). Nothing here has been checked against the
// real page. Before trusting a Claude turn, run the F5 live checks in the
// report (login probe, composer, send, stop, message extraction, delete)
// and replace each placeholder with the observed selector. Do not present
// any selector in this file as verified.

export const id = "claude";
// New-chat landing page. Conversations live at https://claude.ai/chat/<id>.
export const url = "https://claude.ai/new";
// UNVERIFIED: Claude's composer is a contenteditable div; no observed
// selector exists yet. Keep this to the generic hook until the live DOM
// is inspected — do not add a guessed data-testid.
export const editorSelector = 'div[contenteditable="true"]';
// UNVERIFIED: aria-label convention copied from the Gemini/ChatGPT
// adapters; the real stop control's label is unconfirmed.
export const stopSelector = [
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop"]',
  'button[aria-label*="Stop"]',
].join(", ");
// UNVERIFIED: aria-label convention copied from the Gemini adapter.
export const sendSelector = 'button[aria-label="Send message"], button[aria-label="Send"], button[type="submit"]';
export const challengeTitlePattern = /请稍候|just a moment|verifying|security check|cloudflare|人机验证|sign in|log in|登录/i;
export const turnChallengeTitlePattern = /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;

// UNVERIFIED: message containers. data-message-author-role is the
// ChatGPT-side convention and may not exist on Claude at all; the
// data-testid arm is a guess. Live check must confirm which hook (if any)
// marks assistant/user turns, and replace these before relying on reads.
export const assistantMessageSelector = '[data-message-author-role="assistant"], [data-testid*="assistant-message"]';
export const userMessageSelector = '[data-message-author-role="user"], [data-testid*="user-message"]';

// F5: upload contract. No Claude file input was observed; the generic
// input hook is a placeholder and buildUploadJs needs no menu prep
// (same shape as ChatGPT, whose input is directly usable).
export const fileInputSelector = 'input[type="file"]';
export function buildUploadJs() {
  return null;
}

// UNVERIFIED: attachment chip selector. Mirrors the ChatGPT verify shape
// (filename must appear in a chip's text; send button must be usable) but
// the chip hook itself is a placeholder — the D3 lesson applies here too:
// a selector that matches the attach button itself would fake success.
export const attachmentChipSelector = '[class*="file-chip"], [data-testid*="attachment-chip"], [class*="attachment-chip"]';
export function buildAttachmentVerifyJs(fileNames) {
  const bases = fileNames.map((fp) => String(fp).split(/[\\/]/).pop());
  return `(() => {
  const bases = ${JSON.stringify(bases)};
  const chips = [...document.querySelectorAll(${JSON.stringify(attachmentChipSelector)})];
  const texts = chips.map((el) => String((el && (el.innerText || el.textContent)) || "").trim());
  const matched = bases.map((b) => texts.some((t) => t.includes(b)));
  const input = document.querySelector(${JSON.stringify(fileInputSelector)});
  const sendBtns = [...document.querySelectorAll(${JSON.stringify(sendSelector)})];
  const isVisible = (el) => {
    if (!el) return false;
    const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    return !r || (r.width > 0 && r.height > 0);
  };
  const sendReady = sendBtns.some((b) => isVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true");
  return {
    present: chips.length > 0 && matched.every(Boolean) && sendReady,
    matched,
    chipCount: chips.length,
    chipTexts: texts.slice(0, 8),
    sendReady,
    inputFiles: input && input.files ? [...input.files].map((f) => f.name) : [],
  };
})()`;
}

// D3 提交后确认（2026-11-26）：与 gemini.js / chatgpt.js 同形——提交后
// composer chip 已消失，文件名必须在最新一条 user turn 里复核。注意本文件
// 全部选择器均为 UNVERIFIED（见文件头），userMessageSelector 也不例外：
// 提交后确认在 Claude 真机核实前不可采信。
export function buildAttachmentPostSubmitVerifyJs(fileNames) {
  const bases = fileNames.map((fp) => String(fp).split(/[\\/]/).pop());
  return `(() => {
  const bases = ${JSON.stringify(bases)};
  const turns = [...document.querySelectorAll(${JSON.stringify(userMessageSelector)})];
  const latest = turns[turns.length - 1] || null;
  const textOf = (el) => {
    if (!el) return "";
    const parts = [el.innerText, el.textContent];
    if (el.querySelectorAll) {
      for (const d of el.querySelectorAll("[aria-label], [title]")) {
        parts.push(typeof d.getAttribute === "function" ? d.getAttribute("aria-label") : null);
        parts.push(typeof d.getAttribute === "function" ? d.getAttribute("title") : null);
      }
    }
    return parts.filter(Boolean).join(" ");
  };
  const text = textOf(latest);
  const matched = bases.map((b) => text.includes(b));
  return { userTurns: turns.length, matched, fileNames: bases };
})()`;
}

// F4 shape, same as the other adapters: best-effort click hook; no match
// returns clicked:false and the caller must not fabricate a download.
export const downloadTriggerSelector = 'button[aria-label*="Download"], button[aria-label*="下载"], a[download], [data-testid*="download"]';
export function buildDownloadClickJs(fileName) {
  const wanted = typeof fileName === "string" && fileName.trim()
    ? String(fileName).split(/[\\/]/).pop()
    : "";
  return `(() => {
  const wanted = ${JSON.stringify(wanted)};
  const labelOf = (el) => {
    const attr = (name) => (typeof el.getAttribute === "function" ? el.getAttribute(name) : null);
    return [el.innerText, el.textContent, attr("aria-label"), attr("title"), attr("download")].filter(Boolean).join(" ");
  };
  const isVisible = (el) => {
    if (!el) return false;
    const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    return !r || (r.width > 0 && r.height > 0);
  };
  const controls = [...document.querySelectorAll(${JSON.stringify(downloadTriggerSelector)})].filter(isVisible);
  const named = wanted ? controls.filter((el) => labelOf(el).includes(wanted)) : [];
  const target = named[0] || (wanted ? null : controls[0]) || null;
  if (!target) {
    return { clicked: false, reason: "download_control_not_found", matchedCount: controls.length, fileName: wanted || null };
  }
  target.click();
  return { clicked: true, matchedCount: controls.length, fileName: wanted || null, label: labelOf(target).slice(0, 120) };
})()`;
}

// UNVERIFIED login probe. Claude exposes no known session endpoint to
// fetch (do not invent one), so login is inferred from the page: a
// composer editor present with no sign-in link counts as signed in.
// The logged-out page shows a login link and no composer. Both halves
// must be confirmed live — a marketing page with an editor-like node
// would false-positive, and an SSO interstitial would false-negative.
export function buildLoginProbeJs() {
  return `(() => {
  const host = location.hostname;
  const onProduct = host === "claude.ai" || host === "www.claude.ai";
  if (!onProduct) {
    return { loggedIn: false, user: null, title: document.title || "", origin: location.origin, offOrigin: true };
  }
  const title = document.title || "";
  const signedInSelectors = [
    'div[contenteditable="true"]'
  ];
  const signedOutSelectors = [
    'a[href*="/login"]',
    'a[href*="login"]',
    'button[aria-label*="Log in"]',
    'button[aria-label*="Sign in"]'
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
  const containers = [...document.querySelectorAll(${JSON.stringify(assistantMessageSelector)})];
  const last = containers[containers.length - 1];
  if (!last) return "";
  return String((last.innerText || last.textContent) || "").trim();
})()`;
}

export function buildReadStateJs() {
  return `(() => {
  const userTurns = document.querySelectorAll(${JSON.stringify(userMessageSelector)}).length;
  const assistantEls = [...document.querySelectorAll(${JSON.stringify(assistantMessageSelector)})];
  const answerTurns = assistantEls.length;

  // Code fences are not in DOM innerText; rebuild them from pre/code
  // blocks the same way the ChatGPT/Gemini adapters do, so FILE: blocks
  // stay parseable. (Selector set copied from those adapters.)
  const FENCE = String.fromCharCode(96, 96, 96);
  const LF = String.fromCharCode(10);
  const CODE_SEL = "pre, code-block, code[class*=block]";
  const LABEL_RE = /^(代码|CODE|Code|code|[A-Za-z0-9+#._-]{1,20})$/;
  const withCodeFences = (root) => {
    let text = String((root && (root.innerText || root.textContent)) || "").trim();
    const blocks = root && typeof root.querySelectorAll === "function"
      ? [...root.querySelectorAll(CODE_SEL)].filter((el) => !el.parentElement || !el.parentElement.closest(CODE_SEL))
      : [];
    let searchFrom = 0;
    for (const el of blocks) {
      const code = String((el.innerText || el.textContent) || "").trim();
      if (!code) continue;
      const idx = text.indexOf(code, searchFrom);
      if (idx === -1) continue;
      let head = text.slice(0, idx);
      const headBody = head.endsWith(LF) ? head.slice(0, head.length - 1) : head;
      const nl = headBody.lastIndexOf(LF);
      if (LABEL_RE.test(headBody.slice(nl + 1).trim())) head = headBody.slice(0, nl + 1);
      text = head + FENCE + LF + code + LF + FENCE + text.slice(idx + code.length);
      searchFrom = head.length + code.length + 8;
    }
    return text;
  };
  let answerText = "";
  const last = assistantEls[assistantEls.length - 1];
  if (last) answerText = withCodeFences(last);

  // Completion signal (UNVERIFIED): a copy/regenerate control inside the
  // last assistant turn. Absence returns null — "no signal observed" —
  // which the driver treats as no gate, so completion still rests on the
  // stop button disappearing plus the settle window. Do NOT treat a
  // missing copy button as proof of incompleteness: per the Issue #289
  // lesson (see backlog F5 reference), copy-button selectors are fragile.
  let answerActionsVisible = null;
  if (last && typeof last.querySelector === "function") {
    const action = last.querySelector('button[aria-label*="Copy"], button[aria-label*="复制"], button[aria-label*="Regenerate"], button[aria-label*="重新生成"]');
    if (action) {
      if (typeof action.getBoundingClientRect === "function") {
        const r = action.getBoundingClientRect();
        answerActionsVisible = r.width > 0 && r.height > 0;
      } else {
        answerActionsVisible = true;
      }
    }
  }

  const editor = document.querySelector(${JSON.stringify(editorSelector)});
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

  const signedIn = Boolean(editor);
  const signedOut = Boolean(document.querySelector(
    'a[href*="/login"], a[href*="login"], button[aria-label*="Log in"], button[aria-label*="Sign in"]'
  ));
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
    answerActionsVisible,
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

// UNVERIFIED delete flow, mirroring the ChatGPT/Gemini shape: target-URL
// binding, sidebar entry -> actions menu -> Delete item -> confirm dialog
// -> route/sidebar verification. Every hook (sidebar href prefix /chat/,
// menu button label, dialog text) is a placeholder until checked live;
// a wrong hook fails closed with a distinct reason and deletes nothing.
export function buildDeleteConversationJs(targetUrl) {
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
  const firstLine = (el) => label(el).split(String.fromCharCode(10))[0].trim();
  try {
    const expectedPath = new URL(${JSON.stringify(targetUrl)}).pathname;
    if (location.pathname.indexOf(expectedPath) !== 0) {
      return { success: false, reason: "target_url_mismatch", expected: expectedPath, actual: location.pathname };
    }
    const beforePath = location.pathname;
    const beforeTitle = document.title;
    const findSidebarLink = () => {
      const links = [...document.querySelectorAll('a[href^="/chat/"]')];
      return links.find((a) => a.getAttribute("href") === beforePath && isVisible(a)) || null;
    };
    const link = await waitFor(() => {
      const active = [...document.querySelectorAll('a[aria-current="page"][href^="/chat/"]')].filter(isVisible);
      if (active.length === 1) return active[0];
      return findSidebarLink();
    }, 10000);
    if (!link) return { success: false, reason: "current_session_link_not_found" };
    const menuBtn = await waitFor(() => {
      let node = link.parentElement;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        if (node.tagName === "NAV" || node.tagName === "BODY") break;
        const btns = [...node.querySelectorAll('button[aria-label*="actions"], button[aria-label*="操作"], button[aria-label*="More"]')].filter(isVisible);
        if (btns.length === 1) return btns[0];
        if (btns.length > 1) return null;
        node = node.parentElement;
      }
      return null;
    }, 4000);
    if (!menuBtn) return { success: false, reason: "session_menu_button_not_found" };
    menuBtn.click();
    const deleteItem = await waitFor(() => {
      const menus = [...document.querySelectorAll('[role="menu"], [data-state="open"]')].filter(isVisible);
      const pool = [];
      for (const m of menus) {
        for (const it of m.querySelectorAll('[role="menuitem"]')) {
          if (isVisible(it)) pool.push(it);
        }
      }
      const all = pool.length ? pool : [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible);
      return all.find((el) => {
        const t = firstLine(el);
        return t === "删除" || t === "Delete" || t === "删除聊天" || t === "Delete chat";
      }) || null;
    }, 4000);
    if (!deleteItem) return { success: false, reason: "delete_menu_item_not_found" };
    deleteItem.click();
    const confirmBtn = await waitFor(() => {
      const dialogs = [...document.querySelectorAll('div[role="dialog"][aria-modal="true"], [role="dialog"]')].filter(isVisible);
      const dlg = dialogs.find((d) => {
        const text = String(d.innerText || "");
        return text.indexOf("Delete chat") !== -1 || text.indexOf("删除聊天") !== -1 || text.indexOf("Delete conversation") !== -1;
      });
      if (!dlg) return null;
      const btns = [...dlg.querySelectorAll("button")].filter(isVisible);
      return btns.find((b) => {
        const t = label(b);
        return t === "删除聊天" || t === "Delete chat" || t === "删除" || t === "Delete";
      }) || null;
    }, 5000);
    if (!confirmBtn) return { success: false, reason: "confirm_button_not_found" };
    confirmBtn.click();
    const verified = await waitFor(() => {
      if (location.pathname !== beforePath) return "route_changed";
      if (!findSidebarLink()) return "sidebar_entry_removed";
      if (document.title !== beforeTitle) return "title_changed";
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
