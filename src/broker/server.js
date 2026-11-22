import { randomUUID } from "node:crypto";
import http from "node:http";
import { acquireInstanceLock, clearBrokerRecord, writeBrokerRecord } from "./lifecycle.js";
import { createScheduler, release, schedule, snapshot } from "./queue.js";
import { createTurn, publicView, TERMINAL_STATES, transition, TURN_STATES } from "./turns.js";

function coded(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw coded("INVALID_ARGUMENT", "Request body too large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw coded("INVALID_ARGUMENT", "Invalid JSON body");
  }
}

export async function startBroker({ home, mode = "off", runner, idleTimeoutMs = 60000,
  onIdle = async () => {}, log = () => {} } = {}) {
  if (!["off", "tray"].includes(mode) || !runner || typeof runner.run !== "function" ||
      !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1 ||
      typeof onIdle !== "function" || typeof log !== "function") {
    throw coded("INVALID_ARGUMENT", "Invalid broker options");
  }
  const lock = await acquireInstanceLock(home);
  if (!lock) throw coded("BROKER_LOCKED", "Another broker owns the instance lock");

  const instanceId = lock.instanceId;
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  const scheduler = createScheduler();
  const turns = new Map();
  const controllers = new Map();
  const active = new Map();
  let server;
  let idleTimer;
  let closePromise;
  let closing = false;
  let idleSince = Date.now();
  let idleTriggered = false;

  function hasWork() {
    const state = snapshot(scheduler);
    return state.runningTotal > 0 || state.queued.length > 0;
  }

  function trackIdle() {
    if (hasWork()) { idleSince = null; idleTriggered = false; }
    else idleSince ??= Date.now();
  }

  function finish(id, state, patch = {}) {
    const current = turns.get(id);
    if (current?.state !== "running") return;
    turns.set(id, transition(current, state, {
      ...patch,
      ...((TERMINAL_STATES.includes(state)) ? { finishedAt: new Date().toISOString() } : {}),
    }));
  }

  function runTurn(turn) {
    const controller = new AbortController();
    const running = transition(turns.get(turn.id), "running", { startedAt: new Date().toISOString() });
    turns.set(turn.id, running);
    controllers.set(turn.id, controller);
    const task = (async () => {
      await Promise.resolve();
      try {
        const result = await runner.run(running, controller.signal);
        const status = result?.status;
        const next = ["completed", "needs_human", "stalled", "failed"].includes(status)
          ? status : "failed";
        finish(turn.id, next, {
          text: result?.text ?? null,
          reason: next === "failed" && status !== "failed" ? "unknown_runner_status" : (result?.reason ?? null),
          evidence: result?.evidence ?? null,
          ...(result?.sendCommittedAt != null ? { sendCommittedAt: result.sendCommittedAt } : {}),
        });
      } catch (error) {
        finish(turn.id, "failed", { reason: String(error?.code ?? "runner_error") });
        log("runner_failed", { turnId: turn.id, code: String(error?.code ?? "runner_error") });
      } finally {
        release(scheduler, turn);
        controllers.delete(turn.id);
        active.delete(turn.id);
        if (!closing) drain();
        trackIdle();
      }
    })();
    active.set(turn.id, task);
  }

  function drain() {
    if (closing) return;
    // Retain FIFO order for contenders; skip blocked entries to use other providers.
    for (const { id } of snapshot(scheduler).queued) {
      const turn = turns.get(id);
      if (!turn || turn.state !== "queued") {
        if (turn) release(scheduler, turn);
        continue;
      }
      if (schedule(scheduler, turn).accepted) runTurn(turn);
    }
    trackIdle();
  }

  const handle = async (req, res) => {
    if (req.headers["x-wfa-token"] !== token) {
      send(res, 401, { code: "UNAUTHORIZED" });
      return;
    }
    if (closing) {
      send(res, 503, { code: "BROKER_UNREACHABLE" });
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;
    if (req.method === "GET" && pathname === "/status") {
      const state = snapshot(scheduler);
      send(res, 200, {
        instanceId, pid: process.pid, startedAt, mode, chrome: runner.chrome ?? null,
        providers: { chatgpt: state.runningByProvider.chatgpt ?? 0, gemini: state.runningByProvider.gemini ?? 0 },
        turns: [...turns.values()].map(publicView), scheduler: state,
      });
      return;
    }
    if (req.method === "POST" && pathname === "/turns") {
      const body = await parseBody(req);
      const turn = createTurn({ provider: body.provider, prompt: body.prompt,
        conversationId: body.conversationId, mode: body.mode });
      turns.set(turn.id, turn);
      const decision = schedule(scheduler, turn);
      if (decision.accepted) runTurn(turn);
      trackIdle();
      send(res, 202, { id: turn.id, state: turns.get(turn.id).state });
      return;
    }
    if (req.method === "GET" && pathname === "/turns") {
      const state = url.searchParams.get("state");
      if (state && !TURN_STATES.includes(state)) throw coded("INVALID_ARGUMENT", "Unknown turn state");
      send(res, 200, [...turns.values()].filter(t => !state || t.state === state).map(publicView));
      return;
    }
    const match = /^\/turns\/([0-9a-f-]{36})(\/cancel)?$/i.exec(pathname);
    if (match) {
      const id = match[1];
      const turn = turns.get(id);
      if (!turn) { send(res, 404, { code: "NOT_FOUND" }); return; }
      if (req.method === "GET" && !match[2]) {
        send(res, 200, publicView(turn));
        return;
      }
      if (req.method === "POST" && match[2]) {
        if (TERMINAL_STATES.includes(turn.state)) {
          send(res, 409, { code: "INVALID_TRANSITION" });
          return;
        }
        const cancelled = transition(turn, "failed", { reason: "cancelled", finishedAt: new Date().toISOString() });
        turns.set(id, cancelled);
        if (turn.state === "running") {
          controllers.get(id)?.abort();
          if (typeof runner.cancel === "function") {
            Promise.resolve().then(() => runner.cancel(id)).catch(() => {});
          }
          // Keep the lease until runner.run settles; otherwise Chrome could overlap.
        } else {
          release(scheduler, turn);
          drain();
        }
        trackIdle();
        send(res, 200, publicView(cancelled));
        return;
      }
    }
    if (req.method === "POST" && pathname === "/shutdown") {
      send(res, 202, { state: "shutting_down" });
      setImmediate(() => { void close().catch(() => {}); });
      return;
    }
    send(res, 404, { code: "NOT_FOUND" });
  };

  async function boundedWait(promise, ms) {
    let timer;
    try {
      await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(idleTimer);
    closePromise = (async () => {
      const deadline = Date.now() + 5000;
      try {
        if (server?.listening) {
          const listenerClosed = new Promise(resolve => server.close(resolve));
          server.closeIdleConnections?.();
          await boundedWait(listenerClosed, Math.max(1, deadline - Date.now()));
        }
        if (active.size) {
          await boundedWait(Promise.allSettled([...active.values()]), Math.max(1, deadline - Date.now()));
        }
        if (active.size) {
          for (const [id, controller] of controllers) {
            controller.abort();
            if (typeof runner.cancel === "function") {
              Promise.resolve().then(() => runner.cancel(id)).catch(() => {});
            }
          }
        }
      } finally {
        await clearBrokerRecord(home, instanceId);
        await lock.release();
      }
    })();
    return closePromise;
  }

  try {
    // The injected runner owns CDP. It may reuse recoverBrowser before executing turns.
    if (typeof runner.recover === "function") {
      const { recoverBrowser } = await import("../browser/recovery.js");
      await runner.recover({ home, recoverBrowser });
    }
    server = http.createServer((req, res) => {
      void handle(req, res).catch(error => {
        if (!res.headersSent) send(res, error?.code === "INVALID_ARGUMENT" ? 400 : 500,
          { code: String(error?.code ?? "BROKER_ERROR") });
        else res.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const port = server.address().port;
    await writeBrokerRecord(home, {
      schema: 1, instanceId, pid: process.pid, host: "127.0.0.1", port,
      token, startedAt, mode, chrome: runner.chrome ?? null,
    });
    idleTimer = setInterval(() => {
      if (mode === "off" && !closing && !idleTriggered && idleSince !== null &&
          Date.now() - idleSince >= idleTimeoutMs) {
        void (async () => {
          if (!hasWork() && !closing) {
            idleTriggered = true;
            try {
              await onIdle();
              if (!hasWork()) await close();
            } finally {
              if (!closing) idleTriggered = false;
            }
          }
        })().catch(error => log("idle_error", { code: String(error?.code ?? "idle_error") }));
      }
    }, Math.min(idleTimeoutMs, 1000));
    idleTimer.unref();
    return { port, token, instanceId, close, url: `http://127.0.0.1:${port}` };
  } catch (error) {
    closing = true;
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await clearBrokerRecord(home, instanceId);
    await lock.release();
    throw error;
  }
}
