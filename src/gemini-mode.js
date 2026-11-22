// Gemini's Chat/Task switch is pure page state. It is not in the URL, not in
// localStorage, and a reload puts it back on Chat, so the only way to reach it
// is a click that lands on the landing page. ask-bridge owns the browser but
// exposes no hook for it, so this module attaches to the CDP endpoint
// ask-bridge's Chrome already opens (port 9223) and presses Task as soon as the
// composer exists.
//
// Timing is the whole problem: ask-bridge types into the composer right after
// the editor is ready. Measured on Windows, the toggle is clickable about 1.4 s
// after the page appears and the composer is still empty at that point, so the
// click is placed before any text exists. When text is already there the click
// is still safe: the switch is page state, and switching back and forth keeps
// the composer content until something is submitted. The character count is
// recorded on the report (`typedBeforeClick`) instead of being treated as a
// failure. The caller is always told what was observed rather than being told
// it worked.

const DEFAULT_PORT = 9223;
const TASK_LABELS = ["Task", "任务"];
const TASK_SEGMENT_VALUE = "40";
const CDP_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 5000;
const MAX_ATTEMPTS_PER_PAGE = 3;
// 500 ms balances detection latency against HTTP /json/list overhead: Gemini's
// Task switch becomes clickable ~1.4 s after navigation, so 500 ms catches it
// promptly while cutting 20-minute polling from ~12,000 requests to ~2,400.
const PAGE_POLL_INTERVAL_MS = 500;
// 150 ms between DOM button checks inside pressOnPage avoids excessive CDP
// Runtime.evaluate calls while still fitting comfortably inside clickWindowMs.
const CLICK_RETRY_INTERVAL_MS = 150;
// /app, /app/, /app/<id>, and the same paths behind a Google account prefix
// (/u/1/app). ask-bridge opens all of these depending on --followup.
const GEMINI_APP_PATH = /^\/app(?:\/[^/?#]+)?\/?$/;

export function isGeminiAppPage(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "gemini.google.com") return false;
    return GEMINI_APP_PATH.test(parsed.pathname.replace(/^\/u\/\d+/, ""));
  } catch {
    return false;
  }
}

export const CLICK_TASK_SOURCE = `(() => {
  const labels = ${JSON.stringify(TASK_LABELS)};
  let button = document.querySelector('gem-segmented-button[data-value="${TASK_SEGMENT_VALUE}"] button[aria-pressed]');
  if (!button) {
    button = [...document.querySelectorAll('gem-segmented-button button')]
      .find((element) => labels.includes((element.innerText || "").trim()));
  }
  if (!button) return JSON.stringify({ step: "absent" });
  if (button.getAttribute("aria-pressed") === "true") return JSON.stringify({ step: "already" });
  const editor = document.querySelector('[contenteditable=true]');
  const typed = editor ? editor.innerText.trim().length : 0;
  button.click();
  return JSON.stringify({ step: "clicked", typed });
})()`;

export const TASK_STATE_SOURCE = `(() => {
  const labels = ${JSON.stringify(TASK_LABELS)};
  let button = document.querySelector('gem-segmented-button[data-value="${TASK_SEGMENT_VALUE}"] button[aria-pressed]');
  if (!button) {
    button = [...document.querySelectorAll('gem-segmented-button button')]
      .find((element) => labels.includes((element.innerText || "").trim()));
  }
  return button ? String(button.getAttribute("aria-pressed")) : "absent";
})()`;

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Press Gemini's Task switch on every page ask-bridge opens until stopped.
 * Never throws: the run must not depend on this succeeding.
 */
export function startGeminiTaskMode({
  port = DEFAULT_PORT,
  waitForBrowserMs = 20000,
  clickWindowMs = 20000,
  retryDelayMs = RETRY_DELAY_MS,
  pagePollIntervalMs = PAGE_POLL_INTERVAL_MS,
  clickRetryIntervalMs = CLICK_RETRY_INTERVAL_MS,
  log = () => {},
} = {}) {
  const state = { requested: "task", applied: false, clickedAt: null, pageUrl: null, error: null, clicks: 0, typedBeforeClick: null };
  const handled = new Set();
  const inFlight = new Set();
  const attempts = new Map();
  const retryAt = new Map();
  let stopped = false;
  let socket = null;
  let lastPageUrl = null;
  let lastFailure = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const connect = (url) => {
    const ws = new WebSocket(url);
    let next = 0;
    const pending = new Map();
    // A closed socket must settle every in-flight command. Without this the
    // caller's `await evaluate(...)` never returns and the loop stops polling
    // while pretending to still run.
    const failAll = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };
    const ready = new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("websocket error")));
      ws.addEventListener("close", () => reject(new Error("websocket closed")));
    });
    // `ready` is only awaited inside send(); keep an unobserved rejection from
    // surfacing as an unhandled rejection when the browser never appears.
    ready.catch(() => {});
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message ?? "cdp error")) : entry.resolve(message.result);
    });
    ws.addEventListener("close", () => failAll(new Error("websocket closed")));
    ws.addEventListener("error", () => failAll(new Error("websocket error")));
    const send = async (method, params = {}, sessionId) => {
      await ready;
      if (ws.readyState !== 1) throw new Error("websocket is not open");
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
        }, CDP_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    };
    return { send, close: () => { try { ws.close(); } catch {} } };
  };

  const evaluate = async (client, sessionId, expression) => {
    const result = await client.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    return result?.result?.value;
  };

  // Returns true only when the switch is confirmed pressed. A page that is not
  // ready yet (or whose composer already holds text) must stay retryable.
  const pressOnPage = async (client, sessionId, url) => {
    const deadline = Date.now() + clickWindowMs;
    while (!stopped && Date.now() < deadline) {
      let parsed = null;
      try {
        parsed = parseJson(await evaluate(client, sessionId, CLICK_TASK_SOURCE));
      } catch (error) {
        // Target went away (tab closed, navigation committed elsewhere).
        state.error ??= error.message;
        return false;
      }
      if (parsed?.step === "clicked") {
        state.clicks += 1;
        // The switch is a page-state toggle, not a composer reset: measured in
        // Chat/Task on this host, text already typed survives the click as long
        // as nothing is submitted. Keep the count for the report, but do not
        // treat it as a failure.
        if (parsed.typed > 0) state.typedBeforeClick = parsed.typed;
      }
      if (parsed?.step === "clicked" || parsed?.step === "already") {
        // aria-pressed flips on the next Angular tick, so confirm before
        // claiming the mode changed.
        for (let attempt = 0; attempt < 25; attempt += 1) {
          await sleep(60);
          try {
            if ((await evaluate(client, sessionId, TASK_STATE_SOURCE)) === "true") {
              state.applied = true;
              state.clickedAt ??= new Date().toISOString();
              state.pageUrl = url;
              log(`[wfa] gemini task mode on (${parsed.step})`);
              return true;
            }
          } catch {
            return false;
          }
        }
        state.error ??= "task switch did not report pressed";
        return false;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(clickRetryIntervalMs, remaining));
    }
    if (!stopped) {
      lastFailure = `Task switch not found or not clickable within ${clickWindowMs} ms on ${url}`;
    }
    return false;
  };

  const browserUrl = async () => {
    const deadline = Date.now() + waitForBrowserMs;
    while (!stopped && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) return (await response.json()).webSocketDebuggerUrl;
      } catch {}
      await sleep(150);
    }
    return null;
  };

  const run = async () => {
    if (typeof WebSocket !== "function") {
      state.error = "this Node runtime has no WebSocket client (needs 22 or newer)";
      return;
    }
    const wsUrl = await browserUrl();
    if (!wsUrl) {
      state.error = `no Chrome debugging endpoint on port ${port}`;
      return;
    }
    socket = connect(wsUrl);
    while (!stopped) {
      let pages = [];
      try {
        pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
          .filter((target) => target.type === "page" && isGeminiAppPage(target.url));
      } catch (error) {
        state.error ??= error.message;
      }
      for (const target of pages) {
        if (stopped || handled.has(target.id) || inFlight.has(target.id)) continue;
        lastPageUrl = target.url;
        if ((attempts.get(target.id) ?? 0) >= MAX_ATTEMPTS_PER_PAGE) {
          state.error ??= `Task switch not confirmed after ${MAX_ATTEMPTS_PER_PAGE} attempts on ${target.url}${lastFailure ? `; last failure: ${lastFailure}` : ""}`;
          continue;
        }
        if ((retryAt.get(target.id) ?? 0) > Date.now()) continue;
        inFlight.add(target.id);
        attempts.set(target.id, (attempts.get(target.id) ?? 0) + 1);
        try {
          const { sessionId } = await socket.send("Target.attachToTarget", { targetId: target.id, flatten: true });
          if (await pressOnPage(socket, sessionId, target.url)) {
            handled.add(target.id);
            retryAt.delete(target.id);
          } else {
            retryAt.set(target.id, Date.now() + retryDelayMs);
          }
        } catch (error) {
          state.error ??= error.message;
          retryAt.set(target.id, Date.now() + retryDelayMs);
        } finally {
          inFlight.delete(target.id);
        }
      }
      await sleep(pagePollIntervalMs);
    }
  };

  const done = run().catch((error) => {
    state.error ??= error.message;
  });

  return {
    state,
    async stop() {
      stopped = true;
      await Promise.race([done, sleep(2000)]);
      socket?.close();
      if (!state.applied) {
        state.error ??= lastFailure
          ?? `Task mode not confirmed when task ended; last Gemini page: ${lastPageUrl ?? "none seen"}`;
      }
      return { ...state };
    },
  };
}

/**
 * Start the clicker only when the task actually needs it: chat mode is the
 * landing default, and a run without a Gemini job has no switch to press.
 * Returns null otherwise so callers can always `await clicker?.stop()`.
 */
export function geminiTaskModeNeeded(task) {
  return task?.geminiMode === "task"
    && Array.isArray(task.providers) && task.providers.includes("gemini");
}

export function startGeminiTaskModeForTask(task, log = () => {}) {
  if (!geminiTaskModeNeeded(task)) return null;
  return startGeminiTaskMode({ log });
}

