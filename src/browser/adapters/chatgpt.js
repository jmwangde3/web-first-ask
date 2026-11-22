export const id = "chatgpt";
export const url = "https://chatgpt.com/";
export const editorSelector = '#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea#mobile-composer-prompt, [role="textbox"][contenteditable="true"]';
export const stopSelector = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]';
export const challengeTitlePattern = /请稍候|just a moment|verifying|security check|cloudflare|人机验证/i;

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
  const editorEmpty = !ed || ((("value" in ed) ? ed.value : (ed.innerText || ed.textContent || "")).trim() === "");

  const stopEl = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]');
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
    document.querySelector('iframe[src*="challenges.cloudflare.com"], input[type="password"]') ||
    ${challengeTitlePattern.toString()}.test(title) ||
    /cloudflare|just a moment|security check|challenges\\.cloudflare\\.com/i.test(title)
  );

  const loggedOut = !document.querySelector('div.ProseMirror[contenteditable="true"]') && Boolean(document.querySelector('textarea#mobile-composer-prompt'));

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
