import { readFile } from "node:fs/promises";
import path from "node:path";
import { WfaError } from "../errors.js";

function addListener(target, event, fn) {
  if (typeof target.addEventListener === "function") {
    target.addEventListener(event, fn);
  } else if (typeof target.on === "function") {
    target.on(event, fn);
  } else {
    target[`on${event}`] = fn;
  }
}

export async function findDevToolsPort(profileDir, { timeoutMs = 20000 } = {}) {
  const activePortFile = path.join(profileDir, "DevToolsActivePort");
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const content = await readFile(activePortFile, "utf8");
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2) {
        const port = parseInt(lines[0], 10);
        const wsPath = lines[1];
        if (Number.isInteger(port) && port > 0 && wsPath.length > 0) {
          return { port, wsPath };
        }
      }
    } catch {
      // Continue polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export async function cdpVersion(port, { timeoutMs = 3000 } = {}) {
  if (!port || (!Number.isInteger(port) && typeof port !== "string")) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (res.ok) {
      const data = await res.json();
      return {
        Browser: data.Browser || "",
        webSocketDebuggerUrl: data.webSocketDebuggerUrl || "",
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function connectCdp(port, {
  timeoutMs = 10000,
  sendTimeoutMs = 30000,
  wsClass = globalThis.WebSocket,
  wsUrl: explicitWsUrl,
} = {}) {
  let wsUrl = explicitWsUrl;
  if (!wsUrl) {
    if (typeof port === "string" && (port.startsWith("ws://") || port.startsWith("wss://"))) {
      wsUrl = port;
    } else if (port && typeof port === "object" && typeof port.wsUrl === "string") {
      wsUrl = port.wsUrl;
    } else {
      const ver = await cdpVersion(port, { timeoutMs });
      if (!ver || !ver.webSocketDebuggerUrl) {
        throw new WfaError("CDP_TIMEOUT", `Failed to get webSocketDebuggerUrl from port ${port}`);
      }
      wsUrl = ver.webSocketDebuggerUrl;
    }
  }

  let nextId = 1;
  const pending = new Map();
  let isClosed = false;

  const ws = new wsClass(wsUrl);

  const cleanupPending = (err) => {
    for (const [id, req] of pending.entries()) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(err);
    }
    pending.clear();
  };

  const close = () => {
    if (isClosed) return;
    isClosed = true;
    cleanupPending(new WfaError("CDP_CLOSED", "CDP connection is closed"));
    try {
      ws.close();
    } catch {}
  };

  addListener(ws, "message", (event) => {
    let raw = typeof event === "string" ? event : event?.data;
    if (typeof raw !== "string" && raw) {
      raw = raw.toString();
    }
    if (!raw) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg && typeof msg.id !== "undefined") {
      const req = pending.get(msg.id);
      if (req) {
        pending.delete(msg.id);
        if (req.timer) clearTimeout(req.timer);
        if (msg.error) {
          const err = new WfaError("CDP_ERROR", msg.error.message || "CDP command error", {
            details: msg.error,
          });
          req.reject(err);
        } else {
          req.resolve(msg.result);
        }
      }
    }
  });

  addListener(ws, "close", () => {
    if (!isClosed) {
      isClosed = true;
      cleanupPending(new WfaError("CDP_CLOSED", "CDP connection closed"));
    }
  });

  addListener(ws, "error", (err) => {
    if (!isClosed) {
      isClosed = true;
      cleanupPending(new WfaError("CDP_CLOSED", `CDP WebSocket error: ${err?.message || "unknown"}`, {
        cause: err,
      }));
    }
  });

  await new Promise((resolve, reject) => {
    if (ws.readyState === 1) {
      resolve();
      return;
    }
    const connectTimer = setTimeout(() => {
      reject(new WfaError("CDP_TIMEOUT", `Connecting to CDP WebSocket timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onOpen = () => {
      clearTimeout(connectTimer);
      resolve();
    };
    const onEarlyFail = (err) => {
      clearTimeout(connectTimer);
      reject(new WfaError("CDP_CLOSED", `Failed to connect to CDP: ${err?.message || "connection closed"}`));
    };

    addListener(ws, "open", onOpen);
    addListener(ws, "error", onEarlyFail);
    addListener(ws, "close", onEarlyFail);
  });

  const send = (method, params = {}, sessionIdOrOpts = undefined, maybeOpts = {}) => {
    if (isClosed) {
      return Promise.reject(new WfaError("CDP_CLOSED", "CDP connection is closed"));
    }

    let sessionId = undefined;
    let opts = {};
    if (typeof sessionIdOrOpts === "string") {
      sessionId = sessionIdOrOpts;
      opts = maybeOpts || {};
    } else if (typeof sessionIdOrOpts === "object" && sessionIdOrOpts !== null) {
      opts = sessionIdOrOpts;
      sessionId = opts.sessionId;
    }

    const commandTimeoutMs = opts.timeoutMs ?? sendTimeoutMs;
    const id = nextId++;

    return new Promise((resolve, reject) => {
      let timer = null;
      if (commandTimeoutMs > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new WfaError("CDP_TIMEOUT", `CDP command ${method} timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
      }

      pending.set(id, { resolve, reject, timer, method });

      const msg = { id, method, params: params || {} };
      if (sessionId) {
        msg.sessionId = sessionId;
      }

      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        if (timer) clearTimeout(timer);
        pending.delete(id);
        reject(new WfaError("CDP_CLOSED", `Failed to send CDP command: ${err.message}`, {
          cause: err,
        }));
      }
    });
  };

  return {
    send,
    close,
    wsUrl,
    ws,
  };
}
