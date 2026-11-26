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

// 批次 D 附件上传契约：ChatGPT 真机 DOM 存在直接可用的文档通用入口 input，无需展开菜单
export const fileInputSelector = 'input[type="file"][aria-label="附加文件"]';
export function buildUploadJs() {
  return null;
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

// F4：provider 产物的下载入口（best-effort 选择器，尚未在真机 DOM 上核实，
// 仅作点击钩子；无匹配控件时返回 clicked:false，调用方不伪造下载记录）。
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

export function buildDeleteConversationJs(targetUrl) {
  // 三方审核合并实现（Gemini + agy，2026-11-24）：
  // 1) 目标绑定：location.pathname 必须匹配 targetUrl 的 path，否则拒绝。
  // 2) 入口：侧边栏当前会话项（aria-current=page，唯一可见），回退精确 href。
  // 3) 菜单项：限定在打开的菜单容器内，按首行文本匹配（菜单项带换行快捷键后缀）。
  // 4) 确认框：aria-modal=true 且非 floating/quick-chat，文本含 删除聊天/Delete chat。
  // 5) 验证：路由离开 / 侧边栏条目消失 / not found 文案。
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
      const links = [...document.querySelectorAll('a[href^="/c/"]')];
      return links.find((a) => a.getAttribute("href") === beforePath && isVisible(a)) || null;
    };
    const link = await waitFor(() => {
      const active = [...document.querySelectorAll('a[aria-current="page"][href^="/c/"]')].filter(isVisible);
      if (active.length === 1) return active[0];
      return findSidebarLink();
    }, 10000);
    if (!link) return { success: false, reason: "current_session_link_not_found" };
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
    if (!menuBtn) return { success: false, reason: "session_menu_button_not_found" };
    menuBtn.click();
    const deleteItem = await waitFor(() => {
      const menus = [...document.querySelectorAll('[role="menu"], [data-radix-popper-content-wrapper], [data-state="open"]')].filter(isVisible);
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
      if (location.pathname !== beforePath) return "route_changed";
      if (!findSidebarLink()) return "sidebar_entry_removed";
      if (document.title !== beforeTitle && document.title.indexOf("ChatGPT") !== -1) return "title_reset";
      const body = String(document.body.innerText || "");
      if (body.indexOf("找不到聊天") !== -1 || body.indexOf("Chat not found") !== -1 || body.indexOf("无法找到") !== -1) return "not_found_state";
      return null;
    }, 8000);
    if (!verified) return { success: false, reason: "delete_unverified" };
    return { success: true, verified };
  } catch (err) {
    return { success: false, reason: "eval_error:" + (err && err.message ? err.message : String(err)) };
  }
})()`;
}
