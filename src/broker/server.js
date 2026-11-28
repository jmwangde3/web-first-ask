import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { acquireInstanceLock, clearBrokerRecord, writeBrokerRecord } from "./lifecycle.js";
import { createScheduler, DEFAULT_MAX_PER_PROVIDER, DEFAULT_MAX_TOTAL, release, schedule, snapshot } from "./queue.js";
import { createTurn, publicView, TERMINAL_STATES, transition, TURN_STATES } from "./turns.js";
import * as defaultJournal from "./journal.js";
import * as defaultResultStore from "./result-store.js";
import * as defaultRequestStore from "./request-store.js";
import * as defaultTurnStore from "./turn-store.js";

function coded(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function computeRequestHash(turn, promptSha256) {
  return createHash("sha256")
    .update(JSON.stringify([
      turn.provider ?? null,
      promptSha256,
      turn.conversationId ?? null,
      turn.mode ?? "background",
      turn.settleMs ?? null,
      turn.stallTimeoutMs ?? null,
      turn.hardTimeoutMs ?? null,
      turn.minIntervalMs ?? null,
      ...(turn.geminiMode != null ? [turn.geminiMode] : []),
      ...(Array.isArray(turn.files) && turn.files.length > 0 ? [turn.files] : []),
    ]))
    .digest("hex");
}

function restoreTurnFromResult(record, fallbackCreatedAt) {
  return {
    id: record.turnId,
    requestId: record.requestId ?? null,
    provider: record.provider ?? null,
    conversationId: record.conversationId ?? null,
    conversationUrl: record.conversationUrl ?? null,
    targetId: record.targetId ?? null,
    mode: "background",
    settleMs: null,
    stallTimeoutMs: null,
    hardTimeoutMs: null,
    minIntervalMs: null,
    chromePath: null,
    createdAt: record.createdAt ?? record.finishedAt ?? fallbackCreatedAt,
    state: record.state,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    cooldownWaitMs: null,
    cooldownWaitAt: null,
    sendCommittedAt: record.sendCommittedAt ?? null,
    text: record.text ?? null,
    reason: record.reason ?? null,
    evidence: record.evidence ?? null,
    promptPreview: record.promptPreview ?? "",
    downloads: record.downloads ?? null,
  };
}

function restoreTurnFromStore(record, fallbackCreatedAt) {
  return {
    id: record.turnId,
    requestId: record.requestId ?? null,
    provider: record.provider,
    conversationId: record.conversationId ?? null,
    conversationUrl: record.conversationUrl ?? null,
    targetId: record.targetId ?? null,
    mode: record.mode ?? "background",
    settleMs: null,
    stallTimeoutMs: null,
    hardTimeoutMs: null,
    minIntervalMs: null,
    chromePath: null,
    prompt: "",
    promptPreview: record.promptPreview ?? "",
    createdAt: record.createdAt ?? fallbackCreatedAt,
    state: record.state,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    cooldownWaitMs: record.cooldownWaitMs ?? null,
    cooldownWaitAt: record.cooldownWaitAt ?? null,
    sendCommittedAt: record.sendCommittedAt ?? null,
    text: null,
    reason: record.reason ?? null,
    evidence: record.evidence ?? null,
    downloads: record.downloads ?? null,
  };
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
  maxPerProvider = DEFAULT_MAX_PER_PROVIDER, maxTotal = DEFAULT_MAX_TOTAL,
  onIdle = async () => {}, log = () => {}, deps = {} } = {}) {
  if (!["off", "tray"].includes(mode) || !runner || typeof runner.run !== "function" ||
      !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1 ||
      typeof onIdle !== "function" || typeof log !== "function") {
    throw coded("INVALID_ARGUMENT", "Invalid broker options");
  }
  // Validate scheduler configuration before acquiring the broker instance lock.
  const scheduler = createScheduler({ maxPerProvider, maxTotal, now: deps?.now || Date.now });
  const lock = await acquireInstanceLock(home);
  if (!lock) throw coded("BROKER_LOCKED", "Another broker owns the instance lock");

  const journal = deps?.journal || defaultJournal;
  const resultStore = deps?.resultStore || defaultResultStore;
  const requestStore = deps?.requestStore || defaultRequestStore;
  const turnStore = deps?.turnStore || defaultTurnStore;
  const instanceId = lock.instanceId;
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  const turns = new Map();
  const requests = new Map();
  const controllers = new Map();
  const active = new Map();
  const pendingPersists = new Set();

  function trackPersist(promise) {
    const tracked = Promise.resolve(promise);
    pendingPersists.add(tracked);
    tracked.finally(() => { pendingPersists.delete(tracked); });
    return tracked;
  }
  let server;
  let idleTimer;
  let closePromise;
  let closing = false;
  let idleSince = Date.now();
  let idleTriggered = false;
  let boundPort = null;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  function hasWork() {
    if (active.size > 0) return true;
    const state = snapshot(scheduler);
    if (state.runningTotal > 0 || state.queued.length > 0) return true;
    for (const turn of turns.values()) {
      if (turn && !TERMINAL_STATES.includes(turn.state) &&
          turn.state !== "needs_human" && turn.state !== "takeover") {
        return true;
      }
    }
    return false;
  }

  function trackIdle() {
    if (hasWork()) { idleSince = null; idleTriggered = false; }
    else idleSince ??= Date.now();
  }

  function persistTurnSnapshot(turn) {
    if (!turn || typeof turnStore.recordTurn !== "function") return Promise.resolve();
    return trackPersist((async () => {
      try {
        await turnStore.recordTurn(home, turn);
      } catch (error) {
        log("turn_persist_failed", {
          turnId: turn.id,
          code: String(error?.code ?? "TURN_WRITE_FAILED"),
        });
      }
    })());
  }

  async function updateProgress(id, patch) {
    const current = turns.get(id);
    if (current?.state !== "running" || !patch || typeof patch !== "object" || Array.isArray(patch)) return;
    const { id: _id, state: _state, provider: _provider, prompt: _prompt,
      conversationId: _conversationId, requestId: _requestId, ...fields } = patch;
    const updated = { ...current, ...fields };
    turns.set(id, updated);
    await persistTurnSnapshot(updated);
  }

  function finish(id, state, patch = {}) {
    const current = turns.get(id);
    if (current?.state !== "running") return;
    turns.set(id, transition(current, state, {
      cooldownWaitMs: null,
      cooldownWaitAt: null,
      ...patch,
      ...((TERMINAL_STATES.includes(state)) ? { finishedAt: new Date().toISOString() } : {}),
    }));
  }

  function persistTurnResult(turn) {
    if (!turn || (!TERMINAL_STATES.includes(turn.state) &&
        turn.state !== "needs_human" && turn.state !== "takeover")) {
      return Promise.resolve();
    }
    return trackPersist((async () => {
      try {
        await resultStore.recordResult(home, turn);
      } catch (error) {
        log("result_persist_failed", { turnId: turn.id, code: String(error?.code ?? "RESULT_WRITE_FAILED") });
        return;
      }
      await journal.clearCommit(home, turn.id).catch((error) => {
        log("journal_clear_failed", { turnId: turn.id, code: String(error?.code ?? "JOURNAL_CLEAR_FAILED") });
      });
    })());
  }

  function runTurn(turn) {
    const controller = new AbortController();
    const running = transition(turns.get(turn.id), "running", { startedAt: new Date().toISOString() });
    turns.set(turn.id, running);
    controllers.set(turn.id, controller);
    const task = (async () => {
      await Promise.resolve();
      try {
        const result = await runner.run(running, controller.signal, {
          onProgress: (patch) => updateProgress(turn.id, patch),
        });
        const status = result?.status;
        const next = ["completed", "needs_human", "stalled", "failed"].includes(status)
          ? status : "failed";
        finish(turn.id, next, {
          text: result?.text ?? null,
          reason: next === "failed" && status !== "failed" ? "unknown_runner_status" : (result?.reason ?? null),
          evidence: result?.evidence ?? null,
          ...(result?.conversationUrl != null
            ? { conversationUrl: result.conversationUrl }
            : (turns.get(turn.id)?.conversationUrl != null ? { conversationUrl: turns.get(turn.id).conversationUrl } : {})),
          ...(result?.targetId != null
            ? { targetId: result.targetId }
            : (turns.get(turn.id)?.targetId != null ? { targetId: turns.get(turn.id).targetId } : {})),
          ...(result?.sendCommittedAt != null ? { sendCommittedAt: result.sendCommittedAt } : {}),
          ...(result?.downloads != null ? { downloads: result.downloads } : {}),
          ...(typeof result?.createdByWfa === "boolean" ? { createdByWfa: result.createdByWfa } : {}),
          ...(result?.createdCleanup != null ? { createdCleanup: result.createdCleanup } : {}),
        });
        const current = turns.get(turn.id);
        if (current && current.state === "failed" && current.sendCommittedAt == null &&
            result?.sendCommittedAt != null) {
          turns.set(turn.id, { ...current, sendCommittedAt: result.sendCommittedAt });
        }
      } catch (error) {
        finish(turn.id, "failed", { reason: String(error?.code ?? "runner_error") });
        log("runner_failed", { turnId: turn.id, code: String(error?.code ?? "runner_error") });
      } finally {
        // Release the scheduler slot as soon as the runner settles, before the
        // async result persistence, so /status never reports a stale runningTotal.
        release(scheduler, turn);
        controllers.delete(turn.id);
        active.delete(turn.id);
        await persistTurnSnapshot(turns.get(turn.id));
        await persistTurnResult(turns.get(turn.id));
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
      const orphanedTurns = await journal.listOrphans(home).catch(() => []);
      send(res, 200, {
        instanceId, pid: process.pid, port: boundPort, url: boundPort ? `http://127.0.0.1:${boundPort}` : null,
        startedAt, mode, chrome: runner.chrome ?? null,
        providers: { chatgpt: state.runningByProvider.chatgpt ?? 0, gemini: state.runningByProvider.gemini ?? 0 },
        turns: [...turns.values()].map(publicView), scheduler: state,
        orphanedTurns,
      });
      return;
    }
    if (req.method === "POST" && pathname === "/turns") {
      const body = await parseBody(req);
      const turn = createTurn({
        provider: body.provider,
        prompt: body.prompt,
        conversationId: body.conversationId,
        mode: body.mode,
        ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
        ...(body.settleMs !== undefined ? { settleMs: body.settleMs } : {}),
        ...(body.stallTimeoutMs !== undefined ? { stallTimeoutMs: body.stallTimeoutMs } : {}),
        ...(body.hardTimeoutMs !== undefined ? { hardTimeoutMs: body.hardTimeoutMs } : {}),
        ...(body.minIntervalMs !== undefined ? { minIntervalMs: body.minIntervalMs } : {}),
        ...(body.chromePath !== undefined ? { chromePath: body.chromePath } : {}),
        ...(body.geminiMode !== undefined ? { geminiMode: body.geminiMode } : {}),
        ...(body.files !== undefined ? { files: body.files } : {}),
        ...(body.downloadDir !== undefined ? { downloadDir: body.downloadDir } : {}),
        ...(body.cleanupCreated !== undefined ? { cleanupCreated: Boolean(body.cleanupCreated) } : {}),
      });
      const promptSha256 = journal.hashPrompt(turn.prompt);
      let requestHash = null;
      let existingReq = null;
      if (turn.requestId !== null) {
        requestHash = computeRequestHash(turn, promptSha256);
        existingReq = requests.get(turn.requestId) ?? null;
        if (existingReq) {
          if (existingReq.requestHash !== requestHash) {
            send(res, 409, {
              code: "REQUEST_ID_CONFLICT",
              error: "REQUEST_ID_CONFLICT",
              requestId: turn.requestId,
              turnId: existingReq.turnId,
            });
            return;
          }
          const existingTurn = turns.get(existingReq.turnId);
          if (existingTurn) {
            send(res, 200, publicView(existingTurn));
            return;
          }
        }
      }
      const unresolved = await journal.findCommitted(home, {
        provider: turn.provider,
        promptSha256,
      }).catch(() => null);
      if (unresolved) {
        send(res, 409, {
          code: "PREVIOUSLY_SUBMITTED_UNCERTAIN",
          error: "previously_submitted_uncertain",
          orphan: unresolved,
          turnId: unresolved.turnId,
          hint: `This prompt was submitted before a result was recorded (turn ${unresolved.turnId}). Inspect the provider tab or run \`wfa broker clear-orphan ${unresolved.turnId}\` before resending.`,
        });
        return;
      }
      if (existingReq) {
        send(res, 200, {
          id: existingReq.turnId,
          requestId: turn.requestId,
          state: "failed",
          reason: "turn_result_unavailable",
        });
        return;
      }
      if (turn.requestId !== null) {
        const reqRecord = {
          schema: 1,
          requestId: turn.requestId,
          requestHash,
          turnId: turn.id,
          createdAt: turn.createdAt,
        };
        requests.set(turn.requestId, reqRecord);
        await requestStore.recordRequest(home, reqRecord).catch((error) => {
          log("request_persist_failed", { requestId: turn.requestId, code: String(error?.code ?? "REQUEST_WRITE_FAILED") });
        });
      }
      turns.set(turn.id, turn);
      await persistTurnSnapshot(turn);
      const decision = schedule(scheduler, turn);
      if (decision.accepted) runTurn(turn);
      trackIdle();
      send(res, 202, { id: turn.id, state: turns.get(turn.id).state, ...(turn.requestId !== null ? { requestId: turn.requestId } : {}) });
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
        await persistTurnSnapshot(cancelled);
        if (turn.state === "running") {
          controllers.get(id)?.abort();
          if (typeof runner.cancel === "function") {
            Promise.resolve().then(() => runner.cancel(id)).catch(() => {});
          }
          // Keep the lease until runner.run settles; otherwise Chrome could overlap.
        } else {
          await persistTurnResult(cancelled);
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
        // Wait for any in-flight turn/result/journal persistence started during active shutdown.
        while (pendingPersists.size && Date.now() < deadline) {
          await boundedWait(Promise.allSettled([...pendingPersists]), Math.max(1, deadline - Date.now()));
        }
      } finally {
        try {
          await clearBrokerRecord(home, instanceId);
          await lock.release();
        } finally {
          resolveClosed();
        }
      }
    })();
    return closePromise;
  }

  try {
    const persistedTurns = typeof turnStore.readTurns === "function"
      ? await turnStore.readTurns(home).catch((error) => {
          log("turn_load_failed", { code: String(error?.code ?? "TURN_LOAD_FAILED") });
          return [];
        })
      : [];

    for (const record of persistedTurns) {
      if (!record?.turnId || !TURN_STATES.includes(record.state)) continue;
      turns.set(record.turnId, restoreTurnFromStore(record, startedAt));
    }

    const persistedResults = await resultStore.readResults(home).catch((error) => {
      log("result_load_failed", { code: String(error?.code ?? "RESULT_LOAD_FAILED") });
      return [];
    });
    for (const record of persistedResults) {
      if (!record?.turnId || !TURN_STATES.includes(record.state)) continue;
      turns.set(record.turnId, restoreTurnFromResult(record, startedAt));
    }

    const persistedRequests = await requestStore.readRequests(home).catch((error) => {
      log("request_load_failed", { code: String(error?.code ?? "REQUEST_LOAD_FAILED") });
      return [];
    });
    for (const reqRecord of persistedRequests) {
      if (reqRecord?.requestId && reqRecord?.requestHash && reqRecord?.turnId) {
        requests.set(reqRecord.requestId, reqRecord);
      }
    }

    // The injected runner owns CDP recovery. Do NOT inject a real recoverBrowser
    // here: that would override a runner's mocked recoverBrowser in tests and
    // could launch a real Chrome against a temp profile (file locks / EBUSY).
    if (typeof runner.recover === "function") {
      await runner.recover({ home });
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
    boundPort = port;
    await writeBrokerRecord(home, {
      schema: 1, instanceId, pid: process.pid, host: "127.0.0.1", port,
      token, startedAt, mode, chrome: runner.chrome ?? null,
    });
    void Promise.all([
      typeof resultStore.pruneResults === "function" ? resultStore.pruneResults(home).catch(() => {}) : Promise.resolve(),
      typeof requestStore.pruneRequests === "function" ? requestStore.pruneRequests(home).catch(() => {}) : Promise.resolve(),
      typeof turnStore.pruneTurns === "function" ? turnStore.pruneTurns(home).catch(() => {}) : Promise.resolve(),
    ]);
    idleTimer = setInterval(() => {
      if (hasWork()) {
        idleSince = null;
        idleTriggered = false;
        return;
      }
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
    return { port, token, instanceId, close, closed, url: `http://127.0.0.1:${port}` };
  } catch (error) {
    closing = true;
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await clearBrokerRecord(home, instanceId);
    await lock.release();
    resolveClosed();
    throw error;
  }
}
