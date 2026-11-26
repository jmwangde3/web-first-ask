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
