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

// ---------------------------------------------------------------------------
// F1 — Gemini Chat/Task mode (2026-11-26).
// Selectors carried over verbatim from the removed src/gemini-mode.js
// (ask-bridge era; measured on Windows then: a gem-segmented-button with
// data-value="40", labels Task / 任务, aria-pressed state). UNVERIFIED
// against the current Gemini DOM on the CDP path — the segment value, the
// label fallback and the aria-pressed flip must all be checked live before
// a Task turn is trusted (see the F1 manual verification in the report).
// Mode is page state, not URL or localStorage: a reload returns to Chat,
// so the toggle must run after the editor is ready and before typing.
// ---------------------------------------------------------------------------
export const GEMINI_MODES = Object.freeze(["chat", "task"]);
export const GEMINI_DEFAULT_MODE = "chat";
// Segment value from the removed gemini-mode.js (TASK_SEGMENT_VALUE = "40").
export const taskModeSegmentValue = "40";
export const taskModeSelector = 'gem-segmented-button[data-value="40"] button[aria-pressed]';
export const taskModeLabelSelector = "gem-segmented-button button";
// F1 (2026-11-26 live verification): the Task control renders AFTER
// waitForEditor returns, so a single find fails with
// task_mode_control_not_found even though the selector is correct. The
// button itself carries this class (see the DOM probe in
// REPORT-02360b8c.md: gem-segmented-button-row exists, Chat pressed /
// Task unpressed); it is a second lookup for the same Task button, not a
// replacement for the proven segment selector above.
export const taskModeActionSelector = "button.gem-segmented-button-action";
export const taskModeLabels = Object.freeze(["Task", "任务"]);
// Placeholder the composer shows once Task mode is active. Quill renders
// it as data-placeholder on the editor; the toggle verifies it after the
// aria-pressed flip so a turn never claims Task mode on the button state
// alone. Chinese UI shows the localized equivalent.
export const taskModePlaceholderTexts = Object.freeze(["Describe a task", "描述任务"]);
// Bounded poll for the late-rendering Task control (3–5 s per the live
// report's fix direction) and for the placeholder flip after the click.
// Short interval, no fixed sleep: the in-page poll re-checks every
// 100 ms until the deadline. The builder accepts overrides so tests can
// use a short bound without weakening the production one.
export const taskModeControlTimeoutMs = 5000;
export const taskModeControlPollIntervalMs = 100;
export const taskModePlaceholderTimeoutMs = 2000;

// Find the Task switch, click it only when the requested mode differs from
// the current one, and confirm aria-pressed flipped. Never throws in-page:
// every outcome is a plain object so the engine can fail closed with a
// distinct reason instead of guessing whether the click landed.
// mode "chat" clicks back from Task; "task" clicks into Task.
export function buildTaskModeJs(mode, options = {}) {
  const wanted = mode === "task" ? "task" : "chat";
  const controlTimeoutMs = Number.isFinite(options.controlTimeoutMs)
    ? options.controlTimeoutMs
    : taskModeControlTimeoutMs;
  const pollIntervalMs = Number.isFinite(options.controlPollIntervalMs)
    ? options.controlPollIntervalMs
    : taskModeControlPollIntervalMs;
  const placeholderTimeoutMs = Number.isFinite(options.placeholderTimeoutMs)
    ? options.placeholderTimeoutMs
    : taskModePlaceholderTimeoutMs;
  return `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const labels = ${JSON.stringify(taskModeLabels)};
  const placeholderTexts = ${JSON.stringify(taskModePlaceholderTexts)};
  const findButton = () => {
    const direct = document.querySelector(${JSON.stringify(taskModeSelector)});
    if (direct) return direct;
    const action = [...document.querySelectorAll(${JSON.stringify(taskModeActionSelector)})]
      .find((el) => labels.includes((el.innerText || el.textContent || "").trim()));
    if (action) return action;
    return [...document.querySelectorAll(${JSON.stringify(taskModeLabelSelector)})]
      .find((el) => labels.includes((el.innerText || el.textContent || "").trim())) || null;
  };
  const pressedOf = (el) => {
    if (!el || typeof el.getAttribute !== "function") return null;
    const v = el.getAttribute("aria-pressed");
    return v === "true" ? true : (v === "false" ? false : null);
  };
  // Read the composer's current placeholder: Quill keeps it in
  // data-placeholder on the editor; fall back to placeholder/aria-label
  // attrs and to a rendered overlay text inside rich-textarea. Returns
  // the Task placeholder when present, else the first placeholder-ish
  // text seen (so a failure can report what the page actually showed),
  // else null.
  const readPlaceholder = () => {
    const seen = [];
    const fromAttrs = (el) => {
      if (!el || typeof el.getAttribute !== "function") return;
      for (const name of ["data-placeholder", "placeholder", "aria-label"]) {
        const v = el.getAttribute(name);
        if (typeof v === "string" && v.trim()) seen.push(v.trim());
      }
    };
    fromAttrs(document.querySelector('[contenteditable="true"]'));
    fromAttrs(document.querySelector("rich-textarea"));
    for (const el of document.querySelectorAll("[data-placeholder], [placeholder]")) {
      fromAttrs(el);
    }
    for (const text of seen) {
      if (placeholderTexts.some((want) => text.includes(want))) return text;
    }
    const composer = document.querySelector("rich-textarea");
    if (composer && typeof composer.querySelectorAll === "function") {
      for (const el of composer.querySelectorAll("*")) {
        const t = (el.innerText || el.textContent || "").trim();
        if (t && placeholderTexts.includes(t)) return t;
      }
    }
    return seen[0] || null;
  };
  const isTaskPlaceholder = (text) =>
    typeof text === "string" && placeholderTexts.some((want) => text.includes(want));
  const confirmTaskPlaceholder = async () => {
    const deadline = Date.now() + ${JSON.stringify(placeholderTimeoutMs)};
    let placeholder = readPlaceholder();
    while (!isTaskPlaceholder(placeholder) && Date.now() < deadline) {
      await sleep(${JSON.stringify(pollIntervalMs)});
      placeholder = readPlaceholder();
    }
    return placeholder;
  };
  const editor = document.querySelector('[contenteditable="true"]');
  const typedBeforeClick = editor ? (editor.innerText || editor.textContent || "").trim().length : 0;
  // F1: bounded poll — the control renders later than waitForEditor, so
  // the first find is usually too early. Keep polling at a short
  // interval until the deadline; only then report it missing.
  const controlDeadline = Date.now() + ${JSON.stringify(controlTimeoutMs)};
  let button = findButton();
  while (!button && Date.now() < controlDeadline) {
    await sleep(${JSON.stringify(pollIntervalMs)});
    button = findButton();
  }
  if (!button) {
    return { success: false, reason: "task_mode_control_not_found", mode: "unknown", typedBeforeClick };
  }
  const wantPressed = ${JSON.stringify(wanted)} === "task";
  const current = pressedOf(button);
  if (current === wantPressed) {
    if (${JSON.stringify(wanted)} === "task") {
      const placeholder = await confirmTaskPlaceholder();
      if (!isTaskPlaceholder(placeholder)) {
        return { success: false, reason: "task_mode_placeholder_not_confirmed", mode: "unknown", typedBeforeClick, placeholder: placeholder || null };
      }
      return { success: true, step: "already", mode: "task", typedBeforeClick, placeholderVerified: true, placeholder };
    }
    return { success: true, step: "already", mode: ${JSON.stringify(wanted)}, typedBeforeClick };
  }
  button.click();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const nowPressed = pressedOf(findButton() || button);
    if (nowPressed === wantPressed) {
      if (${JSON.stringify(wanted)} !== "task") {
        return { success: true, step: "clicked", mode: "chat", typedBeforeClick };
      }
      const placeholder = await confirmTaskPlaceholder();
      if (!isTaskPlaceholder(placeholder)) {
        return { success: false, reason: "task_mode_placeholder_not_confirmed", mode: "unknown", typedBeforeClick, placeholder: placeholder || null };
      }
      return { success: true, step: "clicked", mode: ${JSON.stringify(wanted)}, typedBeforeClick, placeholderVerified: true, placeholder };
    }
    await sleep(100);
  }
  return { success: false, reason: "task_mode_not_confirmed", mode: "unknown", typedBeforeClick };
})()`;
}

// Read back which mode the page is currently in, for the turn record.
// "unknown" when the control is absent: the caller must not claim a mode
// it could not observe. `placeholder` is the composer's current
// placeholder text when one is advertised, else null.
export function buildGeminiModeStateJs() {
  return `(() => {
  const labels = ${JSON.stringify(taskModeLabels)};
  let button = document.querySelector(${JSON.stringify(taskModeSelector)});
  if (!button) {
    button = [...document.querySelectorAll(${JSON.stringify(taskModeLabelSelector)})]
      .find((el) => labels.includes((el.innerText || el.textContent || "").trim())) || null;
  }
  let placeholder = null;
  const fromAttrs = (el) => {
    if (placeholder || !el || typeof el.getAttribute !== "function") return;
    for (const name of ["data-placeholder", "placeholder", "aria-label"]) {
      const v = el.getAttribute(name);
      if (typeof v === "string" && v.trim()) { placeholder = v.trim(); return; }
    }
  };
  fromAttrs(document.querySelector('[contenteditable="true"]'));
  fromAttrs(document.querySelector("rich-textarea"));
  if (!button || typeof button.getAttribute !== "function") {
    return { mode: "unknown", pressed: null, controlFound: false, placeholder };
  }
  const pressed = button.getAttribute("aria-pressed") === "true";
  return { mode: pressed ? "task" : "chat", pressed, controlFound: true, placeholder };
})()`;
}

// 批次 D 附件上传契约：Gemini 需点击 trigger 展开菜单，并点击 menuitem 后由 DOM 插入 input
export const uploadTriggerSelector = 'button[aria-label="Upload & tools"]';
export const uploadMenuItemSelector = '[role="menuitem"][aria-label^="Upload files"]';
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
    const item = document.querySelector(${JSON.stringify(uploadMenuItemSelector)});
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


// 附件成功判据（D3，2026-11-26）：按文件名逐个验证。
// 旧实现有两个缺陷：(1) `sendReady` 与 `bases` 在页面作用域内未定义，
// 求值恒抛 ReferenceError，driver 永远拿不到返回值、超时后一律报
// ATTACH_UPLOAD_FAILED；(2) `matched` 只是 `chips.length > 0` 的复写，
// 任意 chip（含 attach 按钮本身）都算匹配。现要求每个待传文件名都出现在
// 某 chip 的文本中（子结构文本、aria-label/title 均计入，因 Gemini 的
// 文件名常在子结构/异步加载中），且发送按钮可用；缺失任一文件名即判失败。
// input.files 仅诊断，不作判据。
// 注意：旧选择器 `[data-testid*="attachment"]` 会命中 attach 按钮本身，已移除。
export const attachmentChipSelector = '.attachment-preview-wrapper, [class*="attachment-preview"], gem-attachment-chip, [class*="file-chip"]';
export function buildAttachmentVerifyJs(fileNames) {
  const bases = fileNames.map((fp) => String(fp).split(/[\\/]/).pop());
  return `(() => {
  const bases = ${JSON.stringify(bases)};
  const chips = [...document.querySelectorAll(${JSON.stringify(attachmentChipSelector)})];
  const chipText = (el) => {
    const parts = [
      el.innerText,
      el.textContent,
      typeof el.getAttribute === "function" ? el.getAttribute("aria-label") : null,
      typeof el.getAttribute === "function" ? el.getAttribute("title") : null,
    ];
    if (el.querySelectorAll) {
      for (const d of el.querySelectorAll("[aria-label], [title]")) {
        parts.push(typeof d.getAttribute === "function" ? d.getAttribute("aria-label") : null);
        parts.push(typeof d.getAttribute === "function" ? d.getAttribute("title") : null);
      }
    }
    return parts.filter(Boolean).join(" ");
  };
  const texts = chips.map((el) => String(chipText(el) || "").trim());
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

// D3 提交后确认（2026-11-26 真机复现）：提交后 composer 的 chip 已按设计消失，
// 文件名必须在会话本身——最新一条 user turn——里复核。提交前一刻 chip 还在、
// 提交后 Gemini 把附件丢掉，正是 d3b-probe.zip 的失败形态：prompt 已发出，
// 回答却是 "No attachment or zip file was provided"。本函数只报最新 user turn
// 的文本是否含每个文件名；userTurns 供调用方与提交前基线比较，确认新 turn
// 确实已渲染，而不是拿旧 turn 冒充。
export function buildAttachmentPostSubmitVerifyJs(fileNames) {
  const bases = fileNames.map((fp) => String(fp).split(/[\\/]/).pop());
  return `(() => {
  const bases = ${JSON.stringify(bases)};
  const turns = [...document.querySelectorAll("user-query")];
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

  // 真机核实（2026-11-24）：DOM innerText 不包含代码围栏, native CDP 的回答
  // 因此无法被 parseFileBlocks 解析。这里按 pre/code-block 重建围栏。
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
  const last = modelResponses[modelResponses.length - 1];
  if (last) {
    const body = last.querySelector("message-content, .markdown") ?? last;
    answerText = withCodeFences(body).replace(/^(Gemini|Bard)\\s*(said|说)\\s*[:：]?\\s*/i, "").trim();
  }

  // D5 fix (2026-11-26, REPORT-02360b8c run1): the engine's view of a
  // background tab can go stale while the page holds the full answer —
  // run1 showed innerText stuck at 43 chars, pendingCount stuck at 666 and
  // no stop button, while the same tab's textContent held 29,970 chars,
  // until the 900 s hard timeout. innerText needs layout, which a
  // throttled background tab may not run; textContent does not. These two
  // fields are the page-level "full answer text present" signal the wait
  // loop uses for its stale-pending completion path. Additive only:
  // answerText / pendingCount / answerActionsVisible keep their existing
  // meanings, and the D4 read path (src/engines/cdp-read.js) ignores the
  // new fields. answerTextFull is raw trimmed textContent, without the
  // code-fence reconstruction of answerText — it is the rescue text for a
  // turn that completes through the stale-pending path, not the primary
  // extraction.
  let modelTextChars = 0;
  let answerTextFull = "";
  if (last) {
    modelTextChars = String(last.textContent || "").trim().length;
    const fullBody = last.querySelector("message-content, .markdown") ?? last;
    answerTextFull = String(fullBody.textContent || "").trim();
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
    } else if (pendingCount > 0) {
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
    modelTextChars,
    answerTextFull,
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
