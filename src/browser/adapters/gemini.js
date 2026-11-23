export const id = "gemini";
export const url = "https://gemini.google.com/app";
export const editorSelector = 'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"]';
export const stopSelector = 'button[aria-label*="Stop response"], button[aria-label*="停止回答"], button[aria-label*="Stop"], button[aria-label*="停止"], .stop-button';
export const challengeTitlePattern = /请稍候|just a moment|verifying|security check|cloudflare|人机验证|sign in|log in|登录/i;

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
  const editorEmpty = !editor || (editor.innerText || editor.textContent || "").trim() === "";

  const stopEl = document.querySelector('button[aria-label*="Stop response"], button[aria-label*="停止回答"], button[aria-label*="Stop"], button[aria-label*="停止"], .stop-button');
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
    document.querySelector('input[type="password"], iframe[src*="challenges.cloudflare.com"]') ||
    /challenges\\.cloudflare\\.com/i.test(document.documentElement?.innerHTML || "") ||
    /sign in|log in|登录|人机验证/i.test(title)
  );

  const signInEl = document.querySelector('button[aria-label*="登录"], button[aria-label*="Sign in"], button[aria-label*="Sign In"], a[href*="accounts.google.com"]');
  const loggedOut = userTurns === 0 && Boolean(signInEl);

  return JSON.stringify({
    userTurns,
    answerTurns,
    answerText,
    stopVisible,
    editorEmpty,
    title,
    hasChallenge,
    loggedOut,
  });
})()`;
}
