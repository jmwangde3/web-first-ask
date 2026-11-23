import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getConversationSessionPath,
  isValidConversationUrl,
  loadSession,
  markInvalid,
  saveSession,
} from "../src/browser/conversation-store.js";

const CHATGPT_URL = "https://chatgpt.com/c/chat-123";
const GEMINI_URL = "https://gemini.google.com/app/gemini_123";

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-conversation-store-"));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("conversation URL validation accepts provider session URLs and rejects cross-domain or invalid paths", () => {
  assert.equal(isValidConversationUrl("chatgpt", CHATGPT_URL), true);
  assert.equal(isValidConversationUrl("chatgpt", "https://chatgpt.com/c/abc-123?model=auto"), true);
  assert.equal(isValidConversationUrl("gemini", GEMINI_URL), true);

  assert.equal(isValidConversationUrl("chatgpt", "https://evil.example/c/chat-123"), false);
  assert.equal(isValidConversationUrl("chatgpt", "https://chatgpt.com/"), false);
  assert.equal(isValidConversationUrl("chatgpt", "https://chatgpt.com/c/"), false);
  assert.equal(isValidConversationUrl("chatgpt", "http://chatgpt.com/c/chat-123"), false);
  assert.equal(isValidConversationUrl("chatgpt", "https://chatgpt.com.evil.example/c/chat-123"), false);
  assert.equal(isValidConversationUrl("chatgpt", "https://user@chatgpt.com/c/chat-123"), false);
  assert.equal(isValidConversationUrl("gemini", "https://gemini.google.com/app/"), false);
  assert.equal(isValidConversationUrl("gemini", "https://gemini.google.com/app/chat-123/extra"), false);
  assert.equal(isValidConversationUrl("gemini", "https://chatgpt.com/app/chat-123"), false);
  assert.equal(isValidConversationUrl("unknown", CHATGPT_URL), false);
});

test("saveSession atomically writes a private record and loadSession reads it", async () => {
  await withHome(async (home) => {
    const first = await saveSession(home, "chatgpt", "thread-1", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
    });

    assert.equal(first.schema, 1);
    assert.equal(first.provider, "chatgpt");
    assert.equal(first.conversationId, "thread-1");
    assert.equal(first.turnCount, 1);
    assert.equal(first.invalidated, false);

    const loaded = await loadSession(home, "chatgpt", "thread-1");
    assert.deepEqual(loaded, first);

    const target = getConversationSessionPath(home, "chatgpt", "thread-1");
    const stored = JSON.parse(await readFile(target, "utf8"));
    assert.equal(stored.conversationUrl, CHATGPT_URL);

    const files = await readdir(path.dirname(target));
    assert.deepEqual(files, [path.basename(target)]);

    if (process.platform !== "win32") {
      const info = await stat(target);
      assert.equal(info.mode & 0o777, 0o600);
    }
  });
});

test("saveSession increments turnCount through patches and rejects unsafe URLs", async () => {
  await withHome(async (home) => {
    await saveSession(home, "chatgpt", "thread-2", {
      conversationUrl: CHATGPT_URL,
      turnCount: 1,
    });
    await saveSession(home, "chatgpt", "thread-2", { turnCount: 2 });

    const loaded = await loadSession(home, "chatgpt", "thread-2");
    assert.equal(loaded.turnCount, 2);
    assert.equal(loaded.conversationUrl, CHATGPT_URL);

    await assert.rejects(
      saveSession(home, "chatgpt", "thread-2", {
        conversationUrl: "https://evil.example/c/attacker",
      }),
      /INVALID_CONVERSATION_URL/
    );
  });
});

test("corrupted session JSON is treated as an empty session", async () => {
  await withHome(async (home) => {
    const target = getConversationSessionPath(home, "gemini", "broken-thread");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{not-json", "utf8");

    assert.equal(await loadSession(home, "gemini", "broken-thread"), null);
  });
});

test("markInvalid records the reason and makes the session ineligible for restoration", async () => {
  await withHome(async (home) => {
    await saveSession(home, "gemini", "thread-3", {
      conversationUrl: GEMINI_URL,
      turnCount: 8,
    });

    const invalidated = await markInvalid(home, "gemini", "thread-3", "conversation_invalidated");
    assert.equal(invalidated.invalidated, true);
    assert.equal(invalidated.invalidatedReason, "conversation_invalidated");
    assert.equal(invalidated.turnCount, 8);

    const loaded = await loadSession(home, "gemini", "thread-3");
    assert.equal(loaded.invalidated, true);
  });
});

test("parallel writes for different conversation IDs remain isolated", async () => {
  await withHome(async (home) => {
    await Promise.all([
      saveSession(home, "chatgpt", "parallel-a", {
        conversationUrl: "https://chatgpt.com/c/parallel-a",
        turnCount: 1,
      }),
      saveSession(home, "chatgpt", "parallel-b", {
        conversationUrl: "https://chatgpt.com/c/parallel-b",
        turnCount: 3,
      }),
    ]);

    const [a, b] = await Promise.all([
      loadSession(home, "chatgpt", "parallel-a"),
      loadSession(home, "chatgpt", "parallel-b"),
    ]);
    assert.equal(a.conversationUrl, "https://chatgpt.com/c/parallel-a");
    assert.equal(a.turnCount, 1);
    assert.equal(b.conversationUrl, "https://chatgpt.com/c/parallel-b");
    assert.equal(b.turnCount, 3);
    assert.notEqual(
      getConversationSessionPath(home, "chatgpt", "parallel-a"),
      getConversationSessionPath(home, "chatgpt", "parallel-b")
    );
  });
});
