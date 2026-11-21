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
// click is placed before any text exists. If it ever lands after typing, the
// worst case is a job that submits empty, which is why the caller is told what
// was observed rather than being told it worked.

const DEFAULT_PORT = 9223;
const TASK_LABELS = ["Task", "任务"];
const TASK_SEGMENT_VALUE = "40";

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
  log = () => {},
} = {}) {
  const state = { requested: "task", applied: false, clickedAt: null, pageUrl: null, error: null, clicks: 0 };
  const handled = new Set();
  let stopped = false;
  let socket = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const connect = (url) => {
    const ws = new WebSocket(url);
    let next = 0;
    const pending = new Map();
    const ready = new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("websocket error")));
      ws.addEventListener("close", () => reject(new Error("websocket closed")));
    });
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message ?? "cdp error")) : resolve(message.result);
    });
    const send = async (method, params = {}, sessionId) => {
      await ready;
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    };
    return { send, close: () => { try { ws.close(); } catch {} } };
  };

  const evaluate = async (client, sessionId, expression) => {
    const result = await client.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    return result?.result?.value;
  };

  const pressOnPage = async (client, sessionId, url) => {
    const deadline = Date.now() + clickWindowMs;
    while (!stopped && Date.now() < deadline) {
      let parsed = null;
      try {
        parsed = parseJson(await evaluate(client, sessionId, CLICK_TASK_SOURCE));
      } catch (error) {
        // Target went away (tab closed, navigation committed elsewhere).
        state.error ??= error.message;
        return;
      }
      if (parsed?.step === "clicked") {
        state.clicks += 1;
        if (parsed.typed > 0) {
          // The composer already held ask-bridge's prompt: the click may have
          // cleared it. Record it instead of pretending the job is healthy.
          state.error ??= `task switch clicked after ${parsed.typed} characters were already typed`;
        }
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
              return;
            }
          } catch {
            return;
          }
        }
        state.error ??= "task switch did not report pressed";
        return;
      }
      await sleep(80);
    }
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
          .filter((target) => target.type === "page" && /^https:\/\/gemini\.google\.com\/app(\?|$)/.test(target.url));
      } catch (error) {
        state.error ??= error.message;
      }
      for (const target of pages) {
        if (stopped || handled.has(target.id)) continue;
        handled.add(target.id);
        try {
          const { sessionId } = await socket.send("Target.attachToTarget", { targetId: target.id, flatten: true });
          await pressOnPage(socket, sessionId, target.url);
        } catch (error) {
          state.error ??= error.message;
        }
      }
      await sleep(100);
    }
  };

  const done = run().catch((error) => {
    state.error = error.message;
  });

  return {
    state,
    async stop() {
      stopped = true;
      await Promise.race([done, sleep(2000)]);
      socket?.close();
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
