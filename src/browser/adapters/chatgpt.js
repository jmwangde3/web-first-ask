export const id = "chatgpt";
export const url = "https://chatgpt.com/";
export const editorSelector = '#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea#mobile-composer-prompt, [role="textbox"][contenteditable="true"]';
// 真机核实（2026-11-24）：生成中的停止按钮 aria-label 是「停止」（中文 UI），
// 既没有 data-testid="stop-button" 也不在 <main> 内；旧选择器导致 stopVisible 恒为 false。
export const stopSelector = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"], button[aria-label="Stop"], button[aria-label="停止"]';

// 三方裁决（2026-11-25，代码任务3 第七轮 3:0）：ChatGPT 的完成必须由正面信号判定。
// 停止按钮已退出完成判定（实测：生成期 getBoundingClientRect 为 0x0，且回答结束后 45 秒
// 仍未翻回发送箭头，既不能判完成也不能做活动否决）。
export const requiresCompletionActions = true;
export const sendSelector = 'form:has([contenteditable="true"], textarea) button[type="submit"], button[data-testid="send-button"], button[type="submit"][aria-label="发送"], button[type="submit"][aria-label="Send"]';
export const challengeTitlePattern = /请稍候|just a moment|verifying|security check|cloudflare|人机验证/i;
export const turnChallengeTitlePattern = /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;

// 附件上传契约（2026-11-28 真机核实）：ChatGPT 需先点击「添加文件等内容 / Add files」触发上传菜单与事件绑定，
// 再对通用文件 input[type="file"]（aria-label="附加文件" 等，accept=null）注入文件。
export const uploadTriggerSelector = [
  'button[aria-label="添加文件等内容"]',
  'button[aria-label="Add files"]',
  'button[aria-label="Add photos and files"]',
  'button[aria-label="Add photos & files"]',
  'button[aria-label="Attach files"]',
].join(", ");
export const fileInputSelector = 'input[type="file"][aria-label="附加文件"], input[type="file"][aria-label="Attach files"], input[type="file"][aria-label="Upload files"], input[type="file"][aria-label="上传文件"]';
export function buildUploadJs() {
  return `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    return !rect || (rect.width > 0 && rect.height > 0);
  };
  const trigger = [...document.querySelectorAll(${JSON.stringify(uploadTriggerSelector)})].find(isVisible) || null;
  let triggered = false;
  if (trigger && typeof trigger.click === "function") {
    trigger.click();
    triggered = true;
    await sleep(250);
  }
  const deadline = Date.now() + 4000;
  let input = null;
  while (Date.now() < deadline) {
    input = document.querySelector(${JSON.stringify(fileInputSelector)});
    if (input) break;
    await sleep(100);
  }
  if (!input) {
    return { success: false, triggered, reason: "file_input_not_found" };
  }
  return {
    success: true,
    triggered,
    inputDesc: {
      ariaLabel: input.getAttribute("aria-label"),
      accept: input.getAttribute("accept"),
      multiple: Boolean(input.multiple),
      id: input.id || null,
      inForm: Boolean(typeof input.closest === "function" && input.closest("form")),
    },
  };
})()`;
}


// 附件成功判据（2026-11-24 真机）：setFileInputFiles 后 React 读文件进 state 并清空
// input.files；composer 出现 class 含 composer-attachment 的 chip，innerText 含文件名。
// 用 chip 判成功，input.files 仅诊断（清空后恒为 0，不可作判据）。
export const attachmentChipSelector = '[class*="composer-attachment"], [data-testid*="composer-attachment"]';
export function buildAttachmentVerifyJs(fileNames) {
  const LF = String.fromCharCode(10);
  const bases = fileNames.map((fp) => String(fp).split(/[\\/]/).pop());
  return `(() => {
  const bases = ${JSON.stringify(bases)};
  const chips = [...document.querySelectorAll(${JSON.stringify(attachmentChipSelector)})];
  const dedupRe = new RegExp(${JSON.stringify("\\s*\\(\\d+\\)(?=\\.[^.\\s/\\\\]+$|$)")}, "g");
  const stripDedup = (str) => String(str || "")
    .split(String.fromCharCode(10))
    .map((line) => line.split(String.fromCharCode(13)).join("").trim().replace(dedupRe, ""))
    .join(String.fromCharCode(10))
    .toLowerCase();
  const texts = chips.map((el) => String((el && (el.innerText || el.textContent)) || "").trim());
  const normTexts = texts.map(stripDedup);
  const matched = bases.map((b) => {
    const nb = stripDedup(b);
    return normTexts.some((t) => t.includes(nb));
  });
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
    chipTexts: texts.slice(0, 10),
    inputFiles: input && input.files ? [...input.files].map((f) => f.name) : [],
    inputDesc: input ? {
      ariaLabel: typeof input.getAttribute === "function" ? input.getAttribute("aria-label") : null,
      accept: typeof input.getAttribute === "function" ? input.getAttribute("accept") : null,
      multiple: Boolean(input.multiple),
      id: input.id || null,
      inForm: Boolean(typeof input.closest === "function" && input.closest("form")),
    } : null,
    sendReady,
  };
})()`;
}

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

const ANSWER_BODY_READER_JS = String.raw`  const getAnswerBody = (container) => {
    if (!container) return null;
    const collect = (selector) => container && typeof container.querySelectorAll === "function"
      ? [...container.querySelectorAll(selector)]
      : [];
    const contentNodes = collect("[data-message-content]");
    const markdownNodes = contentNodes.length ? [] : collect(".markdown");
    const proseNodes = contentNodes.length || markdownNodes.length ? [] : collect(".prose");
    const bodyNodes = contentNodes.length ? contentNodes : (markdownNodes.length ? markdownNodes : proseNodes);
    const source = bodyNodes[bodyNodes.length - 1] || container;
    if (!source || typeof source.cloneNode !== "function") return source;
    const clone = source.cloneNode(true);
    clone.querySelectorAll("h4, header, button, [role='button'], .turn-action-controls, [data-testid*='action'], [data-testid*='thought'], [data-testid*='reasoning'], [class*='thought'], [class*='reasoning']").forEach((el) => el.remove());
    const helperPattern = /^(thought for \d+(?:\.\d+)? seconds?|思考了?\s*\d+\s*秒)$/i;
    [...clone.querySelectorAll("*")].forEach((el) => {
      const text = String((el.innerText || el.textContent) || "").trim();
      if (helperPattern.test(text)) el.remove();
    });
    return clone;
  };`;

export function buildAnswerTextJs() {
  return `(() => {
  const hs = [...document.querySelectorAll("h4")].filter((h) => {
    const t = (h.innerText || h.textContent || "").trim();
    return /(说\\s*[:：]|said\\s*[:：]?)\\s*$/i.test(t) && !/^(你|You)/i.test(t);
  });
  const lastH = hs[hs.length - 1];
  const articles = [...document.querySelectorAll('article[data-message-author-role="assistant"]')];
  const lastArticle = articles[articles.length - 1] || null;
  const closestAssistant = lastH && typeof lastH.closest === "function"
    ? lastH.closest('[data-message-author-role="assistant"]')
    : null;
  const verifiedClosestAssistant = closestAssistant && typeof closestAssistant.getAttribute === "function"
    && closestAssistant.getAttribute("data-message-author-role") === "assistant"
    ? closestAssistant
    : null;
${ANSWER_BODY_READER_JS}
  let body = getAnswerBody(lastArticle || verifiedClosestAssistant);
  // Locked design T1 safe fallback: only when NO assistant container can be resolved at all.
  // Never a mid-stream primary source; keeps legacy/unknown DOM shapes from returning "".
  if (!body && lastH && lastH.nextElementSibling) {
    const fb = lastH.nextElementSibling;
    body = typeof fb.cloneNode === "function" ? getAnswerBody(fb) : fb;
  }
  return body ? String((body.innerText || body.textContent) || "").trim() : "";
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

  // 真机核实（2026-11-24）：DOM innerText 不包含代码围栏, 导致 native CDP
  // 拿到的回答无法被 parseFileBlocks 解析。这里按 pre/code-block 重建围栏。
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
  const lastH = assistantHs[assistantHs.length - 1];
  const articles = [...document.querySelectorAll('article[data-message-author-role="assistant"]')];
  const lastArticle = articles[articles.length - 1] || null;
  // The h4-to-article relationship is not assumed: use the role-scoped last article,
  // and only fall back to an explicitly assistant-marked ancestor when no article exists.
  const closestAssistant = lastH && typeof lastH.closest === "function"
    ? lastH.closest('[data-message-author-role="assistant"]')
    : null;
  const verifiedClosestAssistant = closestAssistant && typeof closestAssistant.getAttribute === "function"
    && closestAssistant.getAttribute("data-message-author-role") === "assistant"
    ? closestAssistant
    : null;
${ANSWER_BODY_READER_JS}
  let answerBody = getAnswerBody(lastArticle || verifiedClosestAssistant);
  // Locked design T1 safe fallback: only when NO assistant container can be resolved at all.
  if (!answerBody && lastH && lastH.nextElementSibling) {
    const fb = lastH.nextElementSibling;
    answerBody = typeof fb.cloneNode === "function" ? getAnswerBody(fb) : fb;
  }
  // Text remains available for progress observation; waitForCompletion still requires the action-bar signal.
  if (answerBody) answerText = withCodeFences(answerBody);

  // 正面完成信号（2026-11-25 三方 3:0，含 3 次真机 400ms 逐帧实测）：
  // 以最后一条 assistant 的 h4 为锚点，检查其文档序之后是否出现动作栏。
  // - 不判可见性：已完成回答的动作栏实测可为 0x0 或 opacity:0。
  // - 不用全局计数：用户消息也挂动作栏，提交后约 2 秒即 +1（cp-2 t=2026）。
  // - 锚点必须排除「你/You」，否则用户自己的动作栏会给出约 1.36 秒的假完成窗口。
  const actionEls = [
    ...[...document.querySelectorAll(".turn-action-controls")].filter((el) => el.querySelector("button")),
    ...document.querySelectorAll('button[data-testid="copy-turn-action-button"]'),
  ];
  let answerActionsVisible = null;
  if (lastH) {
    answerActionsVisible = actionEls.some((el) => {
      const rel = lastH.compareDocumentPosition(el);
      return rel !== 0 && !(rel & Node.DOCUMENT_POSITION_DISCONNECTED) && Boolean(rel & Node.DOCUMENT_POSITION_FOLLOWING);
    });
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
    answerActionsVisible,
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

export function buildDeleteConversationJs(targetUrl, {
  initialWaitMs = 2500,
  maxScrollSteps = 12,
  scrollSettleMs = 2500,
  maxNoGrowthSteps = 2,
  totalLinkTimeoutMs = 25000,
  pollIntervalMs = 150,
  menuWaitMs = 4000,
  menuRetryMs = 1500,
} = {}) {
  // 三方审核合并实现（Gemini + agy，2026-11-24；2026-11-28 补充侧边栏懒加载滚动）：
  // 1) 目标绑定：location.pathname 必须匹配 targetUrl 的 path，否则拒绝。
  // 2) 入口：仅匹配 href 精确等于当前 pathname 的唯一可见侧边栏条目（含 aria-current="page" 校验）；
  //    若首屏（前 20 条）未出现，对侧边栏滚动容器做有界懒加载滚动（最多 maxScrollSteps 步、
  //    连续 maxNoGrowthSteps 步无增长早停、总耗时上限 totalLinkTimeoutMs）。
  // 3) 菜单项：限定在打开的菜单容器内，按首行文本匹配（菜单项带换行快捷键后缀）。
  // 4) 确认框：aria-modal=true 且非 floating/quick-chat，文本含 删除聊天/Delete chat。
  // 5) 验证：路由离开 / 侧边栏条目消失 / not found 文案。
  const cfg = {
    initialWaitMs,
    maxScrollSteps,
    scrollSettleMs,
    maxNoGrowthSteps,
    totalLinkTimeoutMs,
    pollIntervalMs,
    menuWaitMs,
    menuRetryMs,
  };
  return `(async () => {
  const cfg = ${JSON.stringify(cfg)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normPath = (p) => { let s = String(p || ""); while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1); return s; };
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
    return null;
  };
  const label = (el) => String((el && (el.innerText || el.textContent)) || "").trim();
  const firstLine = (el) => label(el).split(String.fromCharCode(10))[0].trim();
  try {
    const expectedPath = normPath(new URL(${JSON.stringify(targetUrl)}).pathname);
    const beforePathRaw = location.pathname;
    const beforePath = normPath(beforePathRaw);
    if (beforePath !== expectedPath && beforePath.indexOf(expectedPath + "/") !== 0) {
      return { success: false, reason: "target_url_mismatch", expected: expectedPath, actual: beforePathRaw };
    }
    const beforeTitle = document.title;
    const getSidebarLinks = () => [...document.querySelectorAll('a[href^="/c/"]')];
    const matchesTargetHref = (a) => {
      if (!a || typeof a.getAttribute !== "function") return false;
      const href = String(a.getAttribute("href") || "").split("?")[0].split("#")[0];
      return normPath(href) === beforePath;
    };
    const findSidebarLink = () => {
      const exact = getSidebarLinks().filter((a) => matchesTargetHref(a) && isVisible(a));
      return exact.length === 1 ? exact[0] : null;
    };
    const findCurrentLink = () => {
      const active = [...document.querySelectorAll('a[aria-current="page"][href^="/c/"]')]
        .filter((a) => matchesTargetHref(a) && isVisible(a));
      if (active.length === 1) return active[0];
      return findSidebarLink();
    };
    const isScrollable = (el) => {
      if (!el || !el.isConnected) return false;
      if (!(Number(el.scrollHeight) > Number(el.clientHeight) + 4)) return false;
      try {
        const oy = window.getComputedStyle(el).overflowY;
        if (oy && oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
      } catch (e) {}
      return true;
    };
    const findSidebarScroller = () => {
      const links = getSidebarLinks();
      for (const a of links) {
        let cur = a.parentElement;
        while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
          if (isScrollable(cur)) return cur;
          cur = cur.parentElement;
        }
      }
      const containers = [...document.querySelectorAll('nav, aside, [data-testid*="history"]')];
      for (const c of containers) {
        if (isScrollable(c)) return c;
        if (typeof c.querySelectorAll === "function") {
          for (const child of c.querySelectorAll("div")) {
            if (isScrollable(child)) return child;
          }
        }
      }
      return null;
    };

    const overallDeadline = Date.now() + cfg.totalLinkTimeoutMs;
    let link = await waitFor(findCurrentLink, Math.min(cfg.initialWaitMs, cfg.totalLinkTimeoutMs), cfg.pollIntervalMs);
    let scrolledSteps = 0;
    let scrollerFound = false;

    if (!link) {
      let noGrowthStreak = 0;
      while (!link && scrolledSteps < cfg.maxScrollSteps && Date.now() < overallDeadline) {
        const scroller = findSidebarScroller();
        if (!scroller) break;
        scrollerFound = true;
        const prevCount = getSidebarLinks().length;
        const prevHeight = Number(scroller.scrollHeight) || 0;
        scrolledSteps += 1;
        scroller.scrollTop = prevHeight;
        if (typeof scroller.dispatchEvent === "function") {
          try { scroller.dispatchEvent(new Event("scroll")); } catch (e) {}
        }
        const stepDeadline = Math.min(overallDeadline, Date.now() + cfg.scrollSettleMs);
        let grew = false;
        while (Date.now() < stepDeadline) {
          link = findCurrentLink();
          if (link) break;
          const curCount = getSidebarLinks().length;
          const curHeight = Number(scroller.scrollHeight) || 0;
          if (curCount > prevCount || curHeight > prevHeight) {
            grew = true;
            await sleep(cfg.pollIntervalMs);
            link = findCurrentLink();
            break;
          }
          await sleep(cfg.pollIntervalMs);
        }
        if (link) break;
        if (grew) {
          noGrowthStreak = 0;
        } else {
          noGrowthStreak += 1;
          if (noGrowthStreak >= cfg.maxNoGrowthSteps) break;
        }
      }
    }

    if (!link) {
      return {
        success: false,
        reason: "current_session_link_not_found",
        scrolledSteps,
        scrollerFound,
        finalLinkCount: getSidebarLinks().length,
      };
    }
    if (typeof link.scrollIntoView === "function") {
      try { link.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) {}
    }
    const menuBtn = await waitFor(() => {
      let node = link.parentElement;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        if (node.tagName === "NAV" || node.tagName === "BODY") break;
        const btns = [...node.querySelectorAll('button[aria-label="聊天操作"], button[aria-label="Chat actions"]')].filter(isVisible);
        if (btns.length === 1) return btns[0];
        if (btns.length > 1) return null;
        node = node.parentElement;
      }
      return null;
    }, 4000);
    if (!menuBtn) return { success: false, reason: "session_menu_button_not_found", scrolledSteps };
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
    const findDeleteItem = () => {
      const menus = [...document.querySelectorAll('[role="menu"], [data-radix-popper-content-wrapper], [data-state="open"]')].filter(isVisible);
      const pool = [];
      for (const m of menus) {
        for (const it of m.querySelectorAll('[role="menuitem"], button[role="menuitem"], [data-testid*="delete"]')) {
          if (isVisible(it)) pool.push(it);
        }
      }
      const all = pool.length ? pool : [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible);
      return all.find((el) => {
        const t = firstLine(el);
        return t === "删除" || t === "Delete" || t === "删除聊天" || t === "Delete chat";
      }) || null;
    };
    triggerMenu(menuBtn, false);
    let menuRetried = false;
    let deleteItem = await waitFor(findDeleteItem, Math.min(cfg.menuRetryMs, cfg.menuWaitMs), cfg.pollIntervalMs);
    if (!deleteItem && cfg.menuWaitMs > cfg.menuRetryMs) {
      menuRetried = true;
      triggerMenu(menuBtn, true);
      deleteItem = await waitFor(findDeleteItem, cfg.menuWaitMs - cfg.menuRetryMs, cfg.pollIntervalMs);
    }
    if (!deleteItem) return { success: false, reason: "delete_menu_item_not_found", scrolledSteps, menuRetried };
    deleteItem.click();
    const confirmBtn = await waitFor(() => {
      const dialogs = [...document.querySelectorAll('div[role="dialog"][aria-modal="true"]')].filter((d) => {
        if (!isVisible(d)) return false;
        const cls = typeof d.className === "string" ? d.className : "";
        if (cls.indexOf("quick-chat") !== -1 || cls.indexOf("floatingSurface") !== -1) return false;
        return true;
      });
      const dlg = dialogs.find((d) => {
        const text = String(d.innerText || "");
        return text.indexOf("删除聊天") !== -1 || text.indexOf("Delete chat") !== -1;
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
      if (normPath(location.pathname) !== beforePath) return "route_changed";
      if (!findSidebarLink()) return "sidebar_entry_removed";
      if (document.title !== beforeTitle && document.title.indexOf("ChatGPT") !== -1) return "title_reset";
      const body = String(document.body.innerText || "");
      if (body.indexOf("找不到聊天") !== -1 || body.indexOf("Chat not found") !== -1 || body.indexOf("无法找到") !== -1) return "not_found_state";
      return null;
    }, 8000);
    if (!verified) return { success: false, reason: "delete_unverified" };
    return { success: true, verified, scrolledSteps, menuRetried };
  } catch (err) {
    return { success: false, reason: "eval_error:" + (err && err.message ? err.message : String(err)) };
  }
})()`;
}

export function buildDownloadTriggerJs() {
  return `(() => {
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const sel = [
    'button[aria-label="下载文件"]',
    'button[aria-label="Download file"]',
    'button[aria-label="Download"]',
    'a[download]',
  ].join(", ");
  const candidates = [...document.querySelectorAll(sel)].filter((el) => isVisible(el) && !el.disabled);
  const clicked = [];
  for (const el of candidates) {
    try {
      el.click();
      clicked.push(String(el.getAttribute("aria-label") || el.getAttribute("download") || el.innerText || "").trim() || "download");
    } catch (e) {}
  }
  return { clickedCount: clicked.length, labels: clicked };
})()`;
}
