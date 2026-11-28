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
// 真机核实（2026-11-24 / 2026-11-27）：Gemini 发送按钮在英文 UI 为「Send message」/「Send」，
// zh-CN 实测为「发送」（旧版曾为「发送消息」），繁中为「傳送」/「傳送訊息」；必须用精确 aria-label 避免误匹配反馈按钮。
export const sendSelector = [
  'button[aria-label="Send message"]',
  'button[aria-label="Send"]',
  'button[aria-label="发送消息"]',
  'button[aria-label="发送"]',
  'button[aria-label="傳送訊息"]',
  'button[aria-label="傳送"]',
].join(", ");
export const challengeTitlePattern = /请稍候|just a moment|verifying|security check|cloudflare|人机验证|sign in|log in|登录/i;
export const turnChallengeTitlePattern = /please wait|just a moment|checking your browser|verify you are human|security check|unusual traffic|cloudflare|请稍候|正在确认您是真人|人机验证/i;

// 批次 D 附件上传契约：Gemini 需点击 trigger 展开菜单，并点击 menuitem 后由 DOM 插入 input
// F1（2026-11-26 真机 T4 采证）：Composer 下方 Chat/Task 分段控件
export const taskModeRowSelector = 'gem-segmented-button-row[role="group"]';
export const taskModeButtonSelector = 'gem-segmented-button-row button.gem-segmented-button-action';

export function buildEnsureModeJs(targetMode = "task") {
  const normalized = String(targetMode || "task").toLowerCase();
  const expectedLabel = normalized === "chat" ? "chat" : "task";
  const expectedAliases = expectedLabel === "chat"
    ? ["chat", "聊天", "对话", "對話"]
    : ["task", "任务", "任務"];
  return `(() => {
  const aliases = ${JSON.stringify(expectedAliases)};
  const buttons = [...document.querySelectorAll(${JSON.stringify(taskModeButtonSelector)})];
  const btn = buttons.find((el) => {
    const t = String((el && (el.innerText || el.textContent)) || "").trim().toLowerCase();
    return aliases.includes(t);
  });
  if (!btn) {
    return { ok: false, active: false, switched: false, reason: "mode_button_not_found" };
  }
  const isPressed = () => (typeof btn.getAttribute === "function" && btn.getAttribute("aria-pressed") === "true");
  let switched = false;
  if (!isPressed()) {
    if (typeof btn.click === "function") btn.click();
    switched = true;
  }
  const active = isPressed();
  const editor = document.querySelector(${JSON.stringify(editorSelector)});
  const placeholder = editor && typeof editor.getAttribute === "function" ? (editor.getAttribute("data-placeholder") || "") : "";
  return {
    ok: active,
    active,
    switched,
    mode: ${JSON.stringify(expectedLabel)},
    placeholder,
    reason: active ? "mode_active" : "mode_switch_pending",
  };
})()`;
}

export const uploadTriggerSelector = 'button[aria-label="Upload & tools"], button[aria-label="上传和工具"], button[aria-label="上傳與工具"], button[aria-label*="Upload"], button[aria-label*="上传"], button[aria-label*="上傳"]';
export const uploadMenuItemSelector = '[role="menuitem"][aria-label^="Upload files"], [role="menuitem"][aria-label^="上传文件"], [role="menuitem"][aria-label^="上傳檔案"], [role="menuitem"][aria-label*="Upload"], [role="menuitem"][aria-label*="上传"], [role="menuitem"][aria-label*="上傳"]';
export const fileInputSelector = 'input[type="file"].hidden-file-input[accept^=".txt"]';

export function buildUploadJs() {
  return `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const waitFor = async (fn, timeoutMs = 8000, intervalMs = 150) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(intervalMs);
    }
    return null;
  };

  const trigger = await waitFor(() => {
    const el = document.querySelector(${JSON.stringify(uploadTriggerSelector)});
    return isVisible(el) ? el : null;
  }, 8000);
  if (!trigger) {
    return { success: false, reason: "upload_trigger_not_found" };
  }
  trigger.click();

  const menuItem = await waitFor(() => {
    const item = document.querySelector(${JSON.stringify(uploadMenuItemSelector)}) ||
      [...document.querySelectorAll('[role="menuitem"]')].find((m) => isVisible(m) && /^(upload files|上传文件|上传档案|上傳檔案)/i.test(String(m.innerText || m.textContent || "").trim()));
    return isVisible(item) ? item : null;
  }, 6000);
  if (!menuItem) {
    return { success: false, reason: "upload_menu_item_not_found" };
  }
  menuItem.click();

  const inputReady = await waitFor(() => {
    const input = document.querySelector(${JSON.stringify(fileInputSelector)});
    return Boolean(input);
  }, 6000);
  if (!inputReady) {
    return { success: false, reason: "file_input_not_found" };
  }

  return { success: true };
})()`;
}


// 附件成功判据（2026-11-26 真机 D3 采证）：
// 注入后 0.02s 出现的 div.attachment-preview-wrapper 为 0 高度空壳，绝不能当作上传成功；
// 真实芯片结构为 uploader-file-preview.file-preview-chip / gem-attachment，
// 文件名由 span.gem-attachment-text + span.gem-attachment-extension-label 组成。
export const attachmentChipSelector = 'uploader-file-preview.file-preview-chip, gem-attachment, [class*="file-chip"], gem-attachment-chip';
export function buildAttachmentVerifyJs(fileNames) {
  const bases = fileNames.map((fp) => String(fp).split(/[\\/]/).pop());
  return `(() => {
  const isVisible = (el) => {
    if (!el) return false;
    const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    if (r && (r.width <= 0 || r.height <= 0)) return false;
    return true;
  };
  const norm = (s) => String(s || "").toLowerCase().replace(/\\s+/g, " ").trim();
  const extractChipName = (el) => {
    const stemEl = typeof el.querySelector === "function" ? el.querySelector("span.gem-attachment-text, .gem-attachment-text") : null;
    const extEl = typeof el.querySelector === "function" ? el.querySelector("span.gem-attachment-extension-label, .gem-attachment-extension-label") : null;
    const stem = norm(stemEl && (stemEl.innerText || stemEl.textContent));
    const ext = norm(extEl && (extEl.innerText || extEl.textContent)).replace(/^\\.+/, "");
    if (stem) return ext ? (stem.endsWith("." + ext) ? stem : stem + "." + ext) : stem;
    const raw = norm(el.innerText || el.textContent || (typeof el.getAttribute === "function" ? (el.getAttribute("aria-label") || el.getAttribute("title")) : ""));
    return raw;
  };
  const allChips = [...document.querySelectorAll(${JSON.stringify(attachmentChipSelector)})];
  const visibleChips = allChips.filter((el) => {
    if (!isVisible(el)) return false;
    const hasChildren = typeof el.childElementCount === "number" ? el.childElementCount > 0 : true;
    const name = extractChipName(el);
    return hasChildren || name.length > 0;
  });
  const chipNames = visibleChips.map(extractChipName).filter(Boolean);
  const bases = ${JSON.stringify(bases)}.map(norm);
  const matchesBase = (base, chipName) => {
    if (!base || !chipName) return false;
    if (chipName === base || chipName.includes(base)) return true;
    const dot = base.lastIndexOf(".");
    if (dot > 0) {
      const stem = base.slice(0, dot);
      const ext = base.slice(dot + 1);
      if (chipName.includes(stem) && chipName.includes(ext)) return true;
    }
    return false;
  };
  const matched = bases.map((base) => chipNames.some((cn) => matchesBase(base, cn)));
  const sendBtns = [...document.querySelectorAll(${JSON.stringify(sendSelector)})];
  const sendReady = sendBtns.length === 0 || sendBtns.some((b) => isVisible(b) && !b.disabled && (typeof b.getAttribute !== "function" || b.getAttribute("aria-disabled") !== "true"));
  const input = document.querySelector(${JSON.stringify(fileInputSelector)});
  return {
    present: matched.length > 0 && matched.every(Boolean) && sendReady,
    matched,
    chipCount: visibleChips.length,
    chipTexts: chipNames.slice(0, 8),
    sendReady,
    inputFiles: input && input.files ? [...input.files].map((f) => f.name) : [],
  };
})()`;
}

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
    'button[aria-label*="Google Account"]',
    'img[aria-label*="个人资料"]',
    'img[aria-label*="Profile"]',
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

  // 真机核实（2026-11-24）：DOM innerText 不包含代码围栏, native CDP 的回答
  // 因此无法被 parseFileBlocks 解析。这里按 pre/code-block 重建围栏。
  const FENCE = String.fromCharCode(96, 96, 96);
  const LF = String.fromCharCode(10);
  const CODE_SEL = "pre, code-block, code[class*=block]";
  const LABEL_RE = /^(代码|CODE|Code|code|[A-Za-z0-9+#._-]{1,20})$/;
  const hasCollapsedWrapper = (root) => Boolean(
    root && typeof root.querySelector === "function" && root.querySelector("div.collapsible-content-wrapper")
  );
  const withCodeFences = (root) => {
    const inner = String((root && root.innerText) || "").trim();
    const raw = String((root && root.textContent) || "").trim();
    const useTextContent = raw.length > inner.length &&
      (hasCollapsedWrapper(root) || (inner.length > 0 && raw.length >= inner.length * 2));
    let text = useTextContent ? raw : (inner || raw);
    const blocks = root && typeof root.querySelectorAll === "function"
      ? [...root.querySelectorAll(CODE_SEL)].filter((el) => !el.parentElement || !el.parentElement.closest(CODE_SEL))
      : [];
    let searchFrom = 0;
    for (const el of blocks) {
      const elInner = String((el && el.innerText) || "").trim();
      const elRaw = String((el && el.textContent) || "").trim();
      const code = (useTextContent ? (elRaw || elInner) : (elInner || elRaw)).trim();
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
  let collapsed = false;
  const last = modelResponses[modelResponses.length - 1];
  if (last) {
    const body = last.querySelector("message-content, .markdown") ?? last;
    collapsed = hasCollapsedWrapper(last) || hasCollapsedWrapper(body);
    answerText = withCodeFences(body).replace(/^(Gemini|Bard)\\s*(said|说)\\s*[:：]?\\s*/i, "").trim();
  }

  // 真机核实（2026-11-24）：生成中与思考暂停期间都读不到 message-actions，
  // 回答完整结束后才出现操作栏（copy/thumb/regenerate）。这是比停止按钮可靠的完成信号。
  let answerActionsVisible = null;
  const pendingCount = last && typeof last.querySelectorAll === "function"
    ? last.querySelectorAll("span.pending, p.pending").length
    : 0;
  if (last) {
    const actions = last.querySelector("message-actions");
    if (actions) {
      const ar = typeof actions.getBoundingClientRect === "function" ? actions.getBoundingClientRect() : null;
      answerActionsVisible = ar ? ar.width > 0 && ar.height > 0 : true;
    } else if (pendingCount > 0 && !collapsed) {
      answerActionsVisible = false;
    }
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
    answerActionsVisible,
    pendingCount,
    collapsed,
    stopVisible,
    editorEmpty,
    title,
    url: typeof location !== "undefined" && typeof location.href === "string" ? location.href : "",
    hasChallenge,
    loggedOut,
    signedIn,
    signedOut,
    pageError,
  });
})()`;
}

export function buildDeleteConversationJs(targetUrl, opts = {}) {
  // 加固（2026-11-28, patch 28）：
  // 1) 目标绑定：规范化 /u/<n>/app/<id> 与 /app/<id>，按 convId 严格匹配，不匹配直接 target_url_mismatch。
  // 2) 入口唯一性：主视图精确/宽松 aria + 中英文标签（排除导航容器且唯一）；回退到目标 convId 对应侧边栏行内唯一菜单按钮。
  // 3) 侧边栏懒加载：主视图与首屏均未命中时，对侧边栏滚动容器做有界翻页滚动（步数/连续无增长/总超时硬上限）。
  // 4) 菜单展开重试：首次点击未展开时对同一按钮补发一次 pointerdown+mouseup+click 重试。
  // 5) 确认框必须归属 Delete chat（aria-label 或标题文案），验证路由/标题/侧边栏条目/不存在状态变化。
  const cfg = {
    headerWaitMs: Number.isFinite(opts.headerWaitMs) ? opts.headerWaitMs : 4000,
    maxScrollSteps: Number.isFinite(opts.maxScrollSteps) ? opts.maxScrollSteps : 12,
    scrollSettleMs: Number.isFinite(opts.scrollSettleMs) ? opts.scrollSettleMs : 2500,
    maxNoGrowthSteps: Number.isFinite(opts.maxNoGrowthSteps) ? opts.maxNoGrowthSteps : 2,
    totalLinkTimeoutMs: Number.isFinite(opts.totalLinkTimeoutMs) ? opts.totalLinkTimeoutMs : 20000,
    pollIntervalMs: Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 150,
    menuWaitMs: Number.isFinite(opts.menuWaitMs) ? opts.menuWaitMs : 4000,
    menuRetryMs: Number.isFinite(opts.menuRetryMs) ? opts.menuRetryMs : 1500,
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
  const label = (el) => String((el && (el.innerText || el.textContent)) || "").trim();
  const normPath = (p) => {
    let s = String(p || "").split("?")[0].split("#")[0];
    while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  };
  const extractConvId = (raw) => {
    const clean = normPath(raw);
    const parts = clean.split("/").filter(Boolean);
    const appIdx = parts.indexOf("app");
    if (appIdx !== -1 && appIdx + 1 < parts.length) {
      return parts[appIdx + 1];
    }
    return "";
  };
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
    const actualPath = normPath(location.pathname);
    const expectedId = extractConvId(expectedPath);
    const actualId = extractConvId(actualPath);
    const pathMatches = expectedId
      ? (actualId && actualId === expectedId)
      : (actualPath === expectedPath || actualPath.indexOf(expectedPath + "/") === 0);
    if (!pathMatches) {
      return { success: false, reason: "target_url_mismatch", expected: expectedPath, actual: location.pathname };
    }
    const beforePath = actualPath;
    const beforeTitle = document.title;
    const getSidebarLinks = () => [...document.querySelectorAll('a[href*="/app/"]')];
    const findEntry = () => {
      if (!expectedId) return null;
      const matches = getSidebarLinks().filter((a) => extractConvId(a.getAttribute("href") || "") === expectedId && isVisible(a));
      return matches.length === 1 ? matches[0] : null;
    };
    const isInNav = (el) => Boolean(el && typeof el.closest === "function" && el.closest('nav, aside, [role="navigation"]'));
    const findHeaderMenuBtn = () => {
      const exactSel = [
        'button[aria-label="Open menu for conversation actions."]',
        'button[aria-label="打开对话操作菜单"]',
        'button[aria-label="打开会话操作菜单"]',
        'button[aria-label="打开用于对话操作的菜单"]',
        'button[data-test-id="conversation-actions-menu-button"]',
      ].join(", ");
      const exact = [...document.querySelectorAll(exactSel)].filter((el) => isVisible(el) && !isInNav(el));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return null;
      const looseSel = [
        'button[aria-label*="conversation actions" i]',
        'button[aria-label*="chat actions" i]',
        'button[aria-label*="会话操作"]',
        'button[aria-label*="对话操作"]',
        'button[aria-label*="对话选项"]',
        'button[aria-label*="更多选项"]',
      ].join(", ");
      const loose = [...document.querySelectorAll(looseSel)].filter((el) => isVisible(el) && !isInNav(el));
      return loose.length === 1 ? loose[0] : null;
    };
    const findRowMenuBtn = (entry) => {
      if (!entry) return null;
      const rowSel = [
        'button[data-test-id="actions-menu-button"]',
        'button[aria-label*="actions" i]',
        'button[aria-label*="操作"]',
        'button[aria-label*="选项"]',
        'button[aria-label*="More" i]',
        'button[aria-label*="更多"]',
      ].join(", ");
      let node = entry.parentElement;
      for (let depth = 0; depth < 5 && node; depth += 1) {
        if (node.tagName === "NAV" || node.tagName === "ASIDE" || node.tagName === "BODY" || node.tagName === "HTML") break;
        const btns = [...node.querySelectorAll(rowSel)].filter(isVisible);
        if (btns.length === 1) return btns[0];
        if (btns.length > 1) return null;
        node = node.parentElement;
      }
      return null;
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
      const containers = [...document.querySelectorAll('nav, aside, [role="navigation"], [data-test-id*="history"]')];
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

    let entry = findEntry();
    const hadEntry = Boolean(entry);
    let scrolledSteps = 0;
    let scrollerFound = false;

    let menuBtn = await waitFor(() => {
      const hdr = findHeaderMenuBtn();
      if (hdr) return hdr;
      entry = findEntry();
      return findRowMenuBtn(entry);
    }, Math.min(cfg.headerWaitMs, cfg.totalLinkTimeoutMs), cfg.pollIntervalMs);

    if (!menuBtn && expectedId) {
      const overallDeadline = Date.now() + cfg.totalLinkTimeoutMs;
      let noGrowthStreak = 0;
      while (!menuBtn && scrolledSteps < cfg.maxScrollSteps && Date.now() < overallDeadline) {
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
          const hdr = findHeaderMenuBtn();
          if (hdr) { menuBtn = hdr; break; }
          entry = findEntry();
          if (entry) {
            if (typeof entry.scrollIntoView === "function") {
              try { entry.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) {}
            }
            const rb = findRowMenuBtn(entry);
            if (rb) { menuBtn = rb; break; }
          }
          const curCount = getSidebarLinks().length;
          const curHeight = Number(scroller.scrollHeight) || 0;
          if (curCount > prevCount || curHeight > prevHeight) {
            grew = true;
            await sleep(cfg.pollIntervalMs);
            entry = findEntry();
            if (entry) {
              const rb = findRowMenuBtn(entry);
              if (rb) menuBtn = rb;
            }
            break;
          }
          await sleep(cfg.pollIntervalMs);
        }
        if (menuBtn) break;
        if (grew) {
          noGrowthStreak = 0;
        } else {
          noGrowthStreak += 1;
          if (noGrowthStreak >= cfg.maxNoGrowthSteps) break;
        }
      }
    }

    if (!menuBtn) {
      return {
        success: false,
        reason: "menu_button_not_found",
        scrolledSteps,
        scrollerFound,
        entryFound: Boolean(entry),
      };
    }

    const findDeleteItem = () => {
      const menus = [...document.querySelectorAll('gem-menu, [role="menu"], .mat-mdc-menu-panel')].filter(isVisible);
      const pool = [];
      for (const m of menus) {
        for (const it of m.querySelectorAll('[role="menuitem"], button[data-test-id*="delete"]')) {
          if (isVisible(it)) pool.push(it);
        }
      }
      const all = pool.length ? pool : [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible);
      return all.find((el) => { const t = label(el); return t === "Delete" || t === "删除" || t === "删除对话" || t === "Delete chat"; }) || null;
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
      const dialogs = [...document.querySelectorAll('mat-dialog-container[role="dialog"], [role="dialog"]')].filter(isVisible);
      const dlg = dialogs.find((d) => {
        const aria = String(d.getAttribute("aria-label") || "").trim().toLowerCase();
        const text = String(d.innerText || "");
        return aria === "delete chat" || text.indexOf("Delete chat") !== -1 || text.indexOf("删除聊天") !== -1 || text.indexOf("删除对话") !== -1;
      });
      if (!dlg) return null;
      return [...dlg.querySelectorAll("button")].find((b) => { const t = label(b); return isVisible(b) && (t === "Delete" || t === "删除"); }) || null;
    }, 4000, cfg.pollIntervalMs);
    if (!confirmBtn) return { success: false, reason: "confirm_button_not_found", scrolledSteps, menuRetried };
    confirmBtn.click();
    const verified = await waitFor(() => {
      if (normPath(location.pathname) !== beforePath) return "route_changed";
      if (document.title !== beforeTitle) return "title_changed";
      if ((hadEntry || entry) && !findEntry()) return "sidebar_entry_removed";
      const body = String(document.body.innerText || "");
      if (body.indexOf("not found") !== -1 || body.indexOf("找不到") !== -1 || body.indexOf("不存在") !== -1) return "state_changed";
      return null;
    }, 8000, cfg.pollIntervalMs);
    if (!verified) return { success: false, reason: "delete_unverified", scrolledSteps, menuRetried };
    return { success: true, verified, scrolledSteps, menuRetried };
  } catch (err) {
    return { success: false, reason: "eval_error:" + (err && err.message ? err.message : String(err)) };
  }
})()`;
}
