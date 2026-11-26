import { getHomeDir } from "../paths.js";
import { WfaError } from "../errors.js";
import { recoverBrowser } from "../browser/recovery.js";
import { connectCdp } from "../browser/cdp.js";
import * as defaultDriver from "../browser/driver.js";
import * as chatgptAdapter from "../browser/adapters/chatgpt.js";
import * as geminiAdapter from "../browser/adapters/gemini.js";
import * as claudeAdapter from "../browser/adapters/claude.js";
import * as defaultConversationStore from "../browser/conversation-store.js";

// F7 — explicit cleanup trigger (`wfa cdp cleanup`).
//
// Deletes ONLY conversations the tool itself created (createdByRun /
// createdRunId in the conversation store); pre-existing conversations are
// never in the delete set, and a second run deletes nothing (idempotent).
// There is no automatic trigger anywhere: this module runs only when the
// user invokes the command. A dry run lists wouldDelete and never opens a
// browser; a real run opens Chrome once, only when there is something to
// delete, and deletes through the provider adapter's
// buildDeleteConversationJs evaluated over CDP (same mechanism as the
// engine's session cleanup in cdp-engine.js).

const DEFAULT_ADAPTERS = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
  claude: claudeAdapter,
};

const CLEANUP_PROVIDERS = ["chatgpt", "gemini", "claude"];

// One delete attempt over CDP: open the conversation URL, evaluate the
// adapter's delete script, close the tab. Returns the { success, reason }
// shape cleanupCreatedConversations expects from its deleteConversation hook.
export function makeDeleteConversation({ cdp, driver, adapters }) {
  return async ({ provider, conversationUrl }) => {
    const adapter = adapters?.[provider];
    const script = typeof adapter?.buildDeleteConversationJs === "function"
      ? adapter.buildDeleteConversationJs(conversationUrl)
      : null;
    if (!script) return { success: false, reason: "adapter_delete_not_supported" };
    let tab = null;
    try {
      tab = await driver.openTab(cdp, conversationUrl, { timeoutMs: 15000 });
      const evalResult = await cdp.send("Runtime.evaluate", {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
      }, tab.sessionId);
      const value = evalResult?.result?.value;
      return value?.success
        ? { success: true }
        : { success: false, reason: value?.reason || "delete_eval_failed" };
    } catch (error) {
      return { success: false, reason: error?.message || String(error) };
    } finally {
      if (tab?.targetId) {
        try {
          await cdp.send("Target.closeTarget", { targetId: tab.targetId });
        } catch {}
      }
    }
  };
}

export async function runCdpCleanup({
  home,
  provider,
  conversationId,
  runId,
  dryRun = false,
  chromePath,
  adapters,
  recover,
  connect,
  driver,
  conversationStore,
  cleanupFn,
} = {}) {
  const effectiveHome = home || getHomeDir();
  const store = conversationStore || defaultConversationStore;
  const cleanup = cleanupFn || store.cleanupCreatedConversations;

  if (provider !== undefined && !CLEANUP_PROVIDERS.includes(provider)) {
    throw new WfaError("INVALID_ARGUMENT", `Invalid provider "${provider}". Must be chatgpt, gemini, or claude.`);
  }
  if (conversationId !== undefined && provider === undefined) {
    throw new WfaError("INVALID_ARGUMENT", "--conversation-id requires --provider.");
  }

  const identities = conversationId !== undefined
    ? [{ provider, conversationId }]
    : await store.listSessionIdentities(effectiveHome, {
        ...(provider !== undefined ? { providers: [provider] } : {}),
      });

  // Phase one: list what would be deleted, without a browser. Dry runs stop
  // here; real runs reuse this list so Chrome only starts when there is
  // something to delete.
  const sessions = [];
  let totalWouldDelete = 0;
  for (const identity of identities) {
    const preview = await cleanup(effectiveHome, identity.provider, identity.conversationId, {
      ...(runId !== undefined ? { runId } : {}),
      dryRun: true,
    });
    totalWouldDelete += preview.wouldDelete.length;
    sessions.push({
      provider: identity.provider,
      conversationId: identity.conversationId,
      wouldDelete: preview.wouldDelete,
      deleted: [],
      failed: [],
      skipped: [],
    });
  }

  const aggregate = {
    status: "done",
    dryRun: Boolean(dryRun),
    sessions,
    deleted: [],
    failed: [],
    skipped: [],
    wouldDelete: sessions.flatMap((s) => s.wouldDelete),
  };
  if (dryRun || totalWouldDelete === 0) return aggregate;

  // Phase two: one browser for the whole sweep. The hook deletes through the
  // adapters; cleanupCreatedConversations owns the per-URL bookkeeping
  // (markDeleted) and the idempotency (already-deleted URLs are not targets).
  const recoverFn = recover || recoverBrowser;
  const connectFn = connect || connectCdp;
  const driverImpl = driver || defaultDriver;
  const adaptersImpl = adapters || DEFAULT_ADAPTERS;

  const recovery = await recoverFn({
    home: effectiveHome,
    mode: "background",
    ...(chromePath ? { chromePath } : {}),
  });
  if (!recovery.chrome?.port) {
    if (recovery.action === "RECOVERY_REQUIRED") {
      throw new WfaError(
        "RECOVERY_REQUIRED",
        `browser.lock needs a human decision: ${recovery.reason} (run \`wfa cdp status\` for evidence)`,
        { details: recovery.evidence },
      );
    }
    throw new WfaError(
      "CHROME_START_FAILED",
      `Chrome port is missing from recovery: ${recovery.reason || "unknown"}`,
      { details: recovery.evidence },
    );
  }

  let cdp = null;
  try {
    cdp = await connectFn(recovery.chrome.port);
    const deleteConversation = makeDeleteConversation({ cdp, driver: driverImpl, adapters: adaptersImpl });
    for (const session of sessions) {
      if (!session.wouldDelete.length) continue;
      const result = await cleanup(effectiveHome, session.provider, session.conversationId, {
        ...(runId !== undefined ? { runId } : {}),
        deleteConversation,
      });
      session.deleted = result.deleted;
      session.failed = result.failed;
      session.skipped = result.skipped;
      session.wouldDelete = [];
      aggregate.deleted.push(...result.deleted);
      aggregate.failed.push(...result.failed);
      aggregate.skipped.push(...result.skipped);
      if (result.status === "partial") aggregate.status = "partial";
    }
    // Targets are either deleted or failed-and-still-pending (a failed delete
    // keeps its URL in the target set for a later retry); nothing else
    // remains that "would" be deleted.
    aggregate.wouldDelete = aggregate.failed.map((f) => f.conversationUrl);
    return aggregate;
  } finally {
    if (cdp) {
      try {
        cdp.close();
      } catch {}
    }
  }
}
