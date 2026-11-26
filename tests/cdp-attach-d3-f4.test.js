import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as claudeAdapter from "../src/browser/adapters/claude.js";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { attachFiles, confirmAttachmentsPostSubmit, verifyAttachments } from "../src/browser/driver.js";
import {
  buildDownloadRecord,
  downloadFromProvider,
  enableDownloadBehavior,
  verifyDownloadedFile,
  waitForDownloadedFile,
} from "../src/browser/downloads.js";
import { recordTurn, readTurn } from "../src/broker/turn-store.js";
import { runCdpTurn } from "../src/engines/cdp-engine.js";
import { WfaError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Fake-DOM harness: the adapter builders return JS strings evaluated in the
// page. Executing them here against a minimal document stub proves the
// generated code itself is correct (the old Gemini verify JS threw
// `ReferenceError: sendReady is not defined` on every evaluation, which no
// mock-CDP test could see because mocks bypass the real JS).
// ---------------------------------------------------------------------------

function makeElement({ text = "", ariaLabel = null, title = null, download = null, disabled = false, hidden = false } = {}) {
  const el = {
    innerText: text,
    textContent: text,
    disabled,
    clicked: false,
    getAttribute: (name) => {
      if (name === "aria-label") return ariaLabel;
      if (name === "title") return title;
      if (name === "download") return download;
      return null;
    },
    getBoundingClientRect: () => (hidden ? { width: 0, height: 0 } : { width: 12, height: 12 }),
    querySelectorAll: () => [],
    click() { el.clicked = true; },
  };
  return el;
}

function makeVerifyDocument({ chips = [], sendButtons = [], inputFiles = [] } = {}) {
  return {
    querySelectorAll: (selector) => {
      if (selector.includes("attachment-preview") || selector.includes("file-chip")
        || selector.includes("gem-attachment-chip") || selector.includes("composer-attachment")) {
        return chips;
      }
      if (selector.includes("Send message") || selector.includes("send-button") || selector.includes("submit")) {
        return sendButtons;
      }
      return [];
    },
    querySelector: (selector) => {
      if (selector.includes("file")) return { files: inputFiles.map((name) => ({ name })) };
      return null;
    },
  };
}

function makePostSubmitDocument({ userTurns = [] } = {}) {
  return {
    querySelectorAll: (selector) => {
      if (selector === "user-query") return userTurns;
      if (String(selector).includes('data-message-author-role="user"')
        || String(selector).includes("user-message")) return userTurns;
      return [];
    },
    querySelector: () => null,
  };
}

function makeDownloadDocument(controls = []) {
  return {
    querySelectorAll: (selector) => (/download/i.test(selector) ? controls : []),
    querySelector: () => null,
  };
}

function runPageJs(js, documentStub) {
  return new Function("document", `"use strict"; return (${js});`)(documentStub);
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wfa-d3f4-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// D3 — attachment upload verified by filename
// ---------------------------------------------------------------------------

test("D3 gemini verify JS: chip with the uploaded filename -> present, matched by name", () => {
  const js = geminiAdapter.buildAttachmentVerifyJs(["/tmp/bundle.zip"]);
  const res = runPageJs(js, makeVerifyDocument({
    chips: [makeElement({ text: "bundle.zip" })],
    sendButtons: [makeElement()],
  }));
  assert.equal(res.present, true);
  assert.deepEqual(res.matched, [true]);
  assert.equal(res.chipCount, 1);
  assert.equal(res.sendReady, true);
});

test("D3 gemini verify JS: chip present but filename missing -> present false (the reported failure shape)", () => {
  const js = geminiAdapter.buildAttachmentVerifyJs(["/tmp/bundle.zip"]);
  const res = runPageJs(js, makeVerifyDocument({
    chips: [makeElement({ text: "other.zip" })],
    sendButtons: [makeElement()],
  }));
  assert.equal(res.present, false);
  assert.deepEqual(res.matched, [false]);
  assert.equal(res.chipCount, 1);
});

test("D3 gemini verify JS: multi-file upload requires every filename", () => {
  const js = geminiAdapter.buildAttachmentVerifyJs(["/tmp/a.zip", "/tmp/b.zip"]);
  const res = runPageJs(js, makeVerifyDocument({
    chips: [makeElement({ text: "a.zip" })],
    sendButtons: [makeElement()],
  }));
  assert.equal(res.present, false);
  assert.deepEqual(res.matched, [true, false]);
});

test("D3 gemini verify JS: no chip, disabled send, or empty chip text -> present false", () => {
  const js = geminiAdapter.buildAttachmentVerifyJs(["/tmp/bundle.zip"]);
  assert.equal(runPageJs(js, makeVerifyDocument({ chips: [], sendButtons: [makeElement()] })).present, false);
  assert.equal(runPageJs(js, makeVerifyDocument({
    chips: [makeElement({ text: "bundle.zip" })],
    sendButtons: [makeElement({ disabled: true })],
  })).present, false);
  assert.equal(runPageJs(js, makeVerifyDocument({
    chips: [makeElement({ text: "" })],
    sendButtons: [makeElement()],
  })).present, false);
});

test("D3 gemini verify JS: filename carried only in aria-label still matches", () => {
  const js = geminiAdapter.buildAttachmentVerifyJs(["/tmp/bundle.zip"]);
  const res = runPageJs(js, makeVerifyDocument({
    chips: [makeElement({ text: "", ariaLabel: "bundle.zip" })],
    sendButtons: [makeElement()],
  }));
  assert.equal(res.present, true);
  assert.deepEqual(res.matched, [true]);
});

test("D3 gemini attachmentChipSelector no longer matches the attach button", () => {
  assert.ok(!geminiAdapter.attachmentChipSelector.includes('[data-testid*="attachment"]'),
    "the [data-testid*=attachment] arm could match the attach button itself");
  assert.ok(geminiAdapter.attachmentChipSelector.includes("attachment-preview"));
});

test("D3 gemini buildUploadJs no longer carries the stray sendReady block", () => {
  assert.ok(!geminiAdapter.buildUploadJs().includes("sendReady"));
});

test("D3 chatgpt verify JS already verifies by name: wrong-name chip -> present false", () => {
  const js = chatgptAdapter.buildAttachmentVerifyJs(["/tmp/bundle.zip"]);
  const wrong = runPageJs(js, makeVerifyDocument({
    chips: [makeElement({ text: "other.zip" })],
    sendButtons: [makeElement()],
  }));
  assert.equal(wrong.present, false);
  assert.deepEqual(wrong.matched, [false]);
  const right = runPageJs(js, makeVerifyDocument({
    chips: [makeElement({ text: "bundle.zip" })],
    sendButtons: [makeElement()],
  }));
  assert.equal(right.present, true);
  assert.deepEqual(right.matched, [true]);
});

test("D3 driver.attachFiles (gemini): chip with the wrong filename fails closed with ATTACH_UPLOAD_FAILED", async () => {
  const testFile = path.resolve("package.json");
  let fakeNow = 1000;
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression || "");
        if (expression.includes("chipCount")) {
          return { result: { value: {
            present: false, matched: [false], sendReady: true, chipCount: 1,
            chipTexts: ["other.zip"], inputFiles: [],
          } } };
        }
        if (expression.includes("Upload & tools")) return { result: { value: { success: true } } };
        return { result: { value: {} } };
      }
      return {};
    },
  };
  await assert.rejects(
    () => attachFiles(mockCdp, "sess-d3", geminiAdapter, [testFile], {
      sleep: async () => { fakeNow += 200; },
      now: () => fakeNow,
      attachmentVerifyTimeoutMs: 1000,
    }),
    (err) => err?.code === "ATTACH_UPLOAD_FAILED" && /chip not visible/i.test(err.message),
  );
});

test("D3 driver.attachFiles (gemini): chip with the right filename succeeds", async () => {
  const testFile = path.resolve("package.json");
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression || "");
        if (expression.includes("chipCount")) {
          return { result: { value: {
            present: true, matched: [true], sendReady: true, chipCount: 1,
            chipTexts: ["package.json"], inputFiles: [],
          } } };
        }
        if (expression.includes("Upload & tools")) return { result: { value: { success: true } } };
        return { result: { value: {} } };
      }
      return {};
    },
  };
  const res = await attachFiles(mockCdp, "sess-d3-ok", geminiAdapter, [testFile], {
    sleep: async () => {},
    now: () => 0,
  });
  assert.deepEqual(res.attached, [testFile]);
});

// D3 r3 (2026-11-26): the live failure `chipCount=1, inputFiles=[]` could
// not be located because the thrown message dropped matched / chipTexts /
// sendReady, and the setter's own outcome was never read back — the verify
// loop reads input.files up to 7 s after the setter, by which time React
// may already have consumed and cleared it. The failure message now carries
// the full diag plus the immediate post-setter read-back; the read-back is
// diagnostic only and must never change the pass/fail decision.
test("D3 driver.attachFiles (gemini): failure message carries the full diag incl. setter read-back (reported shape)", async () => {
  const testFile = path.resolve("package.json");
  let fakeNow = 1000;
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression || "");
        // Order matters: the verify JS also mentions input.files.
        if (expression.includes("chipCount")) {
          return { result: { value: {
            present: false, matched: [false], sendReady: true, chipCount: 1,
            chipTexts: [""], inputFiles: [],
          } } };
        }
        if (expression.includes("Upload & tools")) return { result: { value: { success: true } } };
        if (expression.includes("input.files")) {
          return { result: { value: ["package.json"] } };
        }
        return { result: { value: {} } };
      }
      return {};
    },
  };
  await assert.rejects(
    () => attachFiles(mockCdp, "sess-d3-diag", geminiAdapter, [testFile], {
      sleep: async () => { fakeNow += 200; },
      now: () => fakeNow,
      attachmentVerifyTimeoutMs: 1000,
    }),
    (err) => {
      assert.equal(err?.code, "ATTACH_UPLOAD_FAILED");
      assert.match(err.message, /chip not visible/i);
      // The reported live shape, now self-diagnosing: setter landed
      // (setterInputFiles has the name) but the one matched chip carries
      // no filename text — an empty shell / wrapper, not a real chip.
      assert.match(err.message, /"chipCount":1/);
      assert.match(err.message, /"matched":\[false\]/);
      assert.match(err.message, /"chipTexts":\[""\]/);
      assert.match(err.message, /"sendReady":true/);
      assert.match(err.message, /"setterInputFiles":\["package\.json"\]/);
      return true;
    },
  );
});

test("D3 driver.attachFiles: empty setter read-back does not fail an upload whose chip verifies (diagnostic only)", async () => {
  const testFile = path.resolve("package.json");
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression || "");
        if (expression.includes("chipCount")) {
          return { result: { value: {
            present: true, matched: [true], sendReady: true, chipCount: 1,
            chipTexts: ["package.json"], inputFiles: [],
          } } };
        }
        if (expression.includes("Upload & tools")) return { result: { value: { success: true } } };
        if (expression.includes("input.files")) return { result: { value: [] } };
        return { result: { value: {} } };
      }
      return {};
    },
  };
  const res = await attachFiles(mockCdp, "sess-d3-readback-empty", geminiAdapter, [testFile], {
    sleep: async () => {},
    now: () => 0,
  });
  assert.deepEqual(res.attached, [testFile]);
});

test("D3 driver.attachFiles: a failing setter read-back never masks the verify outcome", async () => {
  const testFile = path.resolve("package.json");
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression || "");
        if (expression.includes("chipCount")) {
          return { result: { value: {
            present: true, matched: [true], sendReady: true, chipCount: 1,
            chipTexts: ["package.json"], inputFiles: [],
          } } };
        }
        if (expression.includes("Upload & tools")) return { result: { value: { success: true } } };
        if (expression.includes("input.files")) throw new Error("evaluate exploded");
        return { result: { value: {} } };
      }
      return {};
    },
  };
  const res = await attachFiles(mockCdp, "sess-d3-readback-throws", geminiAdapter, [testFile], {
    sleep: async () => {},
    now: () => 0,
  });
  assert.deepEqual(res.attached, [testFile]);
});

test("D3 engine: failed attachment verification returns failed and never submits the prompt", async () => {
  await withTempDir(async (home) => {
    const counters = {};
    const cdp = {
      send: async (method) => {
        if (method === "Runtime.evaluate") return { result: { value: "" } };
        return {};
      },
      close() {},
    };
    const deps = {
      enforceCooldown: async () => {},
      skipTurnLock: true,
      pace: async () => 0,
      recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1234, port: 9222 } }),
      connectCdp: async () => cdp,
      driver: {
        openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
        waitForEditor: async () => true,
        readTurnState: async () => ({
          userTurns: 0, answerTurns: 0, answerText: "", stopVisible: false,
          editorEmpty: true, loggedOut: false, pageError: null,
        }),
        attachFiles: async () => {
          throw new WfaError("ATTACH_UPLOAD_FAILED", "Attachment chip not visible within 7000ms");
        },
        typePrompt: async () => {
          counters.typed = (counters.typed || 0) + 1;
          return { typedChars: 1, replacedChars: 0 };
        },
        submitTurn: async () => {
          counters.submitted = (counters.submitted || 0) + 1;
          return {};
        },
        waitForCompletion: async () => ({ status: "completed", reason: "completed", text: "answer", evidence: {} }),
      },
    };
    const result = await runCdpTurn({
      provider: "chatgpt",
      prompt: "The repository is in the attachment. Read it.",
      home,
      files: [path.resolve("package.json")],
      deps,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "ATTACH_UPLOAD_FAILED");
    assert.equal(result.text, "");
    assert.equal(counters.typed ?? 0, 0);
    assert.equal(counters.submitted ?? 0, 0);
  });
});

// ---------------------------------------------------------------------------
// F4 — download attachments produced by providers
// ---------------------------------------------------------------------------

test("F4 verifyDownloadedFile: matching size and hash returns the record; mismatches fail closed", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "report.zip");
    const content = Buffer.from("fake provider download", "utf8");
    await writeFile(filePath, content);
    const sha256 = createHash("sha256").update(content).digest("hex");

    const ok = await verifyDownloadedFile(filePath, { expectedSizeBytes: content.length, expectedSha256: sha256 });
    assert.equal(ok.fileName, "report.zip");
    assert.equal(ok.sizeBytes, content.length);
    assert.equal(ok.sha256, sha256);

    await assert.rejects(
      () => verifyDownloadedFile(filePath, { expectedSha256: "0".repeat(64) }),
      (err) => err?.code === "DOWNLOAD_VERIFY_FAILED" && /hash mismatch/i.test(err.message),
    );
    await assert.rejects(
      () => verifyDownloadedFile(filePath, { expectedSizeBytes: content.length + 1 }),
      (err) => err?.code === "DOWNLOAD_VERIFY_FAILED" && /size mismatch/i.test(err.message),
    );
    await assert.rejects(
      () => verifyDownloadedFile(path.join(dir, "missing.zip")),
      (err) => err?.code === "DOWNLOAD_VERIFY_FAILED",
    );
  });
});

test("F4 waitForDownloadedFile: ignores .crdownload, returns the final file once its size is stable", async () => {
  let polls = 0;
  const fakeReaddir = async () => {
    polls += 1;
    if (polls <= 2) return ["report.zip.crdownload"];
    return ["report.zip"];
  };
  const fakeStat = async (filePath) => {
    if (String(filePath).endsWith(".crdownload")) return { isFile: () => true, size: 10, mtimeMs: 1 };
    return { isFile: () => true, size: 42, mtimeMs: 7 };
  };
  let fakeNow = 1000;
  const found = await waitForDownloadedFile("/tmp/dl", {
    before: new Map(),
    timeoutMs: 5000,
    pollIntervalMs: 250,
    sleep: async () => { fakeNow += 250; },
    now: () => fakeNow,
    readdir: fakeReaddir,
    stat: fakeStat,
  });
  assert.equal(found.fileName, "report.zip");
  assert.equal(found.sizeBytes, 42);
  assert.ok(polls >= 4, "final file must be observed stable across two polls");
});

test("F4 waitForDownloadedFile: pre-existing unchanged files are not treated as downloads; timeout is distinct", async () => {
  let fakeNow = 1000;
  await assert.rejects(
    () => waitForDownloadedFile("/tmp/dl", {
      before: new Map([["old.zip", { size: 9, mtimeMs: 3 }]]),
      timeoutMs: 500,
      pollIntervalMs: 250,
      sleep: async () => { fakeNow += 250; },
      now: () => fakeNow,
      readdir: async () => ["old.zip"],
      stat: async () => ({ isFile: () => true, size: 9, mtimeMs: 3 }),
    }),
    (err) => err?.code === "DOWNLOAD_TIMEOUT",
  );
});

test("F4 enableDownloadBehavior: Page.setDownloadBehavior first, Browser fallback when Page is gone", async () => {
  await withTempDir(async (dir) => {
    const downloadDir = path.join(dir, "dl");
    const calls = [];
    const mockCdp = {
      send: async (method, params = {}) => {
        calls.push({ method, params });
        return {};
      },
    };
    const res = await enableDownloadBehavior(mockCdp, "sess-1", downloadDir);
    assert.equal(res.method, "Page.setDownloadBehavior");
    assert.equal(res.downloadPath, downloadDir);
    assert.deepEqual(calls[0].params, { behavior: "allow", downloadPath: downloadDir });

    const fallbackCalls = [];
    const failingCdp = {
      send: async (method, params = {}) => {
        fallbackCalls.push({ method, params });
        if (method === "Page.setDownloadBehavior") throw new Error("Page.setDownloadBehavior wasn't found");
        return {};
      },
    };
    const res2 = await enableDownloadBehavior(failingCdp, "sess-1", downloadDir);
    assert.equal(res2.method, "Browser.setDownloadBehavior");
    assert.equal(fallbackCalls[1].method, "Browser.setDownloadBehavior");

    const deadCdp = { send: async () => { throw new Error("nope"); } };
    await assert.rejects(
      () => enableDownloadBehavior(deadCdp, "sess-1", downloadDir),
      (err) => err?.code === "DOWNLOAD_CAPTURE_FAILED",
    );
  });
});

test("F4 downloadFromProvider: click + capture + verify returns a turn-record download entry", async () => {
  await withTempDir(async (dir) => {
    const downloadDir = path.join(dir, "dl");
    const content = Buffer.from("provider attachment bytes", "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const methods = [];
    let sleeps = 0;
    const mockCdp = {
      send: async (method, params = {}) => {
        methods.push(method);
        if (method === "Page.setDownloadBehavior") return {};
        if (method === "Runtime.evaluate") {
          return { result: { value: { clicked: true, matchedCount: 1, fileName: "report.zip" } } };
        }
        return {};
      },
    };
    const record = await downloadFromProvider(mockCdp, "sess-1", geminiAdapter, {
      downloadDir,
      fileName: "report.zip",
      timeoutMs: 5000,
      pollIntervalMs: 50,
      expectedSha256: sha256,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) await writeFile(path.join(downloadDir, "report.zip"), content);
      },
    });
    assert.equal(record.fileName, "report.zip");
    assert.equal(record.sizeBytes, content.length);
    assert.equal(record.sha256, sha256);
    assert.equal(record.provider, "gemini");
    assert.equal(typeof record.downloadedAt, "string");
    assert.ok(methods.includes("Page.setDownloadBehavior"));
    assert.ok(methods.includes("Runtime.evaluate"));
  });
});

test("F4 downloadFromProvider: no download control clicked -> DOWNLOAD_CONTROL_NOT_FOUND, nothing captured", async () => {
  await withTempDir(async (dir) => {
    const downloadDir = path.join(dir, "dl");
    const mockCdp = {
      send: async (method) => {
        if (method === "Page.setDownloadBehavior") return {};
        if (method === "Runtime.evaluate") {
          return { result: { value: { clicked: false, reason: "download_control_not_found", matchedCount: 0 } } };
        }
        return {};
      },
    };
    await assert.rejects(
      () => downloadFromProvider(mockCdp, "sess-1", chatgptAdapter, {
        downloadDir, fileName: "report.zip", timeoutMs: 500,
      }),
      (err) => err?.code === "DOWNLOAD_CONTROL_NOT_FOUND",
    );
  });
});

test("F4 downloadFromProvider: adapter without a download hook -> DOWNLOAD_NOT_SUPPORTED", async () => {
  await withTempDir(async (dir) => {
    const mockCdp = { send: async () => ({}) };
    await assert.rejects(
      () => downloadFromProvider(mockCdp, "sess-1", { id: "claude" }, {
        downloadDir: path.join(dir, "dl"),
      }),
      (err) => err?.code === "DOWNLOAD_NOT_SUPPORTED",
    );
  });
});

test("F4 downloadFromProvider: captured file failing hash verification yields no record", async () => {
  await withTempDir(async (dir) => {
    const downloadDir = path.join(dir, "dl");
    const content = Buffer.from("tampered bytes", "utf8");
    let sleeps = 0;
    const mockCdp = {
      send: async (method) => {
        if (method === "Page.setDownloadBehavior") return {};
        if (method === "Runtime.evaluate") return { result: { value: { clicked: true, matchedCount: 1 } } };
        return {};
      },
    };
    await assert.rejects(
      () => downloadFromProvider(mockCdp, "sess-1", geminiAdapter, {
        downloadDir,
        fileName: "report.zip",
        timeoutMs: 5000,
        pollIntervalMs: 50,
        expectedSha256: "0".repeat(64),
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1) await writeFile(path.join(downloadDir, "report.zip"), content);
        },
      }),
      (err) => err?.code === "DOWNLOAD_VERIFY_FAILED",
    );
  });
});

test("F4 adapter download hook: named control is clicked, a non-matching control is not", () => {
  const target = makeElement({ text: "Download report.zip", ariaLabel: "Download report.zip" });
  const other = makeElement({ text: "Download other.zip", ariaLabel: "Download other.zip" });
  const hit = runPageJs(geminiAdapter.buildDownloadClickJs("report.zip"), makeDownloadDocument([other, target]));
  assert.equal(hit.clicked, true);
  assert.equal(target.clicked, true);
  assert.equal(other.clicked, false);

  const target2 = makeElement({ text: "Download report.zip", ariaLabel: "Download report.zip" });
  const other2 = makeElement({ text: "Download other.zip", ariaLabel: "Download other.zip" });
  const miss = runPageJs(chatgptAdapter.buildDownloadClickJs("report.zip"), makeDownloadDocument([other2]));
  assert.equal(miss.clicked, false);
  assert.equal(miss.reason, "download_control_not_found");
  assert.equal(other2.clicked, false);
  assert.equal(target2.clicked, false);

  const first = makeElement({ text: "Download something.zip", ariaLabel: "Download something.zip" });
  const unnamed = runPageJs(chatgptAdapter.buildDownloadClickJs(null), makeDownloadDocument([first]));
  assert.equal(unnamed.clicked, true);
  assert.equal(first.clicked, true);
});

test("F4 turn store already persists the downloads field when a record carries it", async () => {
  await withTempDir(async (home) => {
    const entry = buildDownloadRecord({
      fileName: "report.zip",
      path: "C:\\Users\\wang\\Downloads\\report.zip",
      sizeBytes: 1234,
      sha256: "a".repeat(64),
      provider: "gemini",
    });
    const saved = await recordTurn(home, {
      id: "turn-d3f4-1",
      provider: "chatgpt",
      state: "completed",
      downloads: [entry],
    });
    assert.deepEqual(saved.downloads, [entry]);
    const reloaded = await readTurn(home, "turn-d3f4-1");
    assert.deepEqual(reloaded.downloads, [entry]);
  });
});

// ---------------------------------------------------------------------------
// D3 follow-up (2026-11-26 branch acceptance): the chip verified by
// attachFiles is transient — Gemini dropped d3b-probe.zip between verify
// and submit, the prompt went out with no file, and the CLI then timed out
// silently after 150s. Fix: re-verify at submit time (fail closed, no
// submit) and confirm the filename in the conversation post-submit
// (explicit SUBMITTED_WITH_UNVERIFIED_ATTACHMENT, never a silent timeout).
// ---------------------------------------------------------------------------

test("D3 post-submit verify JS (gemini): filename in the newest user turn -> matched", () => {
  const js = geminiAdapter.buildAttachmentPostSubmitVerifyJs(["/tmp/d3b-probe.zip"]);
  const res = runPageJs(js, makePostSubmitDocument({
    userTurns: [makeElement({ text: "old turn" }), makeElement({ text: "Read d3b-probe.zip" })],
  }));
  assert.equal(res.userTurns, 2);
  assert.deepEqual(res.matched, [true]);
  assert.deepEqual(res.fileNames, ["d3b-probe.zip"]);
});

test("D3 post-submit verify JS (gemini): newest user turn without the filename -> matched false", () => {
  const js = geminiAdapter.buildAttachmentPostSubmitVerifyJs(["/tmp/d3b-probe.zip"]);
  const res = runPageJs(js, makePostSubmitDocument({
    userTurns: [makeElement({ text: "Read d3b-probe.zip" }), makeElement({ text: "No attachment or zip file was provided" })],
  }));
  assert.equal(res.userTurns, 2);
  assert.deepEqual(res.matched, [false]);
});

test("D3 post-submit verify JS (gemini): no user turn rendered yet -> matched false", () => {
  const js = geminiAdapter.buildAttachmentPostSubmitVerifyJs(["/tmp/d3b-probe.zip"]);
  const res = runPageJs(js, makePostSubmitDocument({ userTurns: [] }));
  assert.equal(res.userTurns, 0);
  assert.deepEqual(res.matched, [false]);
});

test("D3 post-submit verify JS (chatgpt): filename in the user article -> matched; wrong name -> false", () => {
  const js = chatgptAdapter.buildAttachmentPostSubmitVerifyJs(["/tmp/bundle.zip"]);
  const right = runPageJs(js, makePostSubmitDocument({
    userTurns: [makeElement({ text: "bundle.zip\nThe repository is in the attachment." })],
  }));
  assert.equal(right.userTurns, 1);
  assert.deepEqual(right.matched, [true]);
  const wrong = runPageJs(js, makePostSubmitDocument({
    userTurns: [makeElement({ text: "other.zip\nThe repository is in the attachment." })],
  }));
  assert.deepEqual(wrong.matched, [false]);
});

test("D3 post-submit verify JS (claude): filename in the user message -> matched", () => {
  const js = claudeAdapter.buildAttachmentPostSubmitVerifyJs(["/tmp/bundle.zip"]);
  const res = runPageJs(js, makePostSubmitDocument({
    userTurns: [makeElement({ text: "bundle.zip" })],
  }));
  assert.equal(res.userTurns, 1);
  assert.deepEqual(res.matched, [true]);
});

test("D3 driver.verifyAttachments: returns the adapter diag (present false keeps the caller in charge of failing closed)", async () => {
  let calls = 0;
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "Runtime.evaluate" && String(params?.expression || "").includes("chipCount")) {
        calls += 1;
        return { result: { value: {
          present: false, matched: [false], sendReady: true, chipCount: 0,
          chipTexts: [], inputFiles: [],
        } } };
      }
      return {};
    },
  };
  let fakeNow = 1000;
  const diag = await verifyAttachments(mockCdp, "sess-d3", geminiAdapter, ["/tmp/bundle.zip"], {
    sleep: async () => { fakeNow += 200; },
    now: () => fakeNow,
    timeoutMs: 1000,
    intervalMs: 200,
  });
  assert.equal(diag.present, false);
  assert.deepEqual(diag.matched, [false]);
  assert.ok(calls >= 1);

  const okCdp = {
    send: async () => ({ result: { value: {
      present: true, matched: [true], sendReady: true, chipCount: 1,
      chipTexts: ["bundle.zip"], inputFiles: [],
    } } }),
  };
  const ok = await verifyAttachments(okCdp, "sess-d3", geminiAdapter, ["/tmp/bundle.zip"], {
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(ok.present, true);

  const noBuilder = await verifyAttachments(okCdp, "sess-d3", { id: "plain" }, ["/tmp/bundle.zip"], {
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(noBuilder, null);
});

test("D3 driver.confirmAttachmentsPostSubmit: new user turn with the filename confirms; an old turn alone does not", async () => {
  const scripted = (states) => {
    let calls = 0;
    return {
      send: async (method) => {
        if (method !== "Runtime.evaluate") return {};
        const state = states[Math.min(calls, states.length - 1)];
        calls += 1;
        return { result: { value: state } };
      },
    };
  };
  let fakeNow = 1000;
  const tick = { sleep: async () => { fakeNow += 500; }, now: () => fakeNow };

  const confirmed = await confirmAttachmentsPostSubmit(
    scripted([
      { userTurns: 0, matched: [false], fileNames: ["bundle.zip"] },
      { userTurns: 1, matched: [true], fileNames: ["bundle.zip"] },
    ]),
    "sess-d3", geminiAdapter, ["/tmp/bundle.zip"],
    { ...tick, baselineUserTurns: 0, timeoutMs: 10000, intervalMs: 500 },
  );
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.userTurns, 1);
  assert.deepEqual(confirmed.matched, [true]);

  // Baseline guard: a pre-existing turn that already contains the name
  // must not confirm the new submission; only the new turn counts.
  fakeNow = 1000;
  const baselineGuarded = await confirmAttachmentsPostSubmit(
    scripted([
      { userTurns: 1, matched: [true], fileNames: ["bundle.zip"] },
      { userTurns: 2, matched: [true], fileNames: ["bundle.zip"] },
    ]),
    "sess-d3", geminiAdapter, ["/tmp/bundle.zip"],
    { ...tick, baselineUserTurns: 1, timeoutMs: 10000, intervalMs: 500 },
  );
  assert.equal(baselineGuarded.confirmed, true);
  assert.equal(baselineGuarded.userTurns, 2);
});

test("D3 driver.confirmAttachmentsPostSubmit: timeout distinguishes unrendered turn from turn without the file", async () => {
  let fakeNow = 1000;
  const tick = { sleep: async () => { fakeNow += 500; }, now: () => fakeNow };
  const neverRendered = await confirmAttachmentsPostSubmit(
    { send: async () => ({ result: { value: { userTurns: 0, matched: [false], fileNames: ["bundle.zip"] } } }) },
    "sess-d3", geminiAdapter, ["/tmp/bundle.zip"],
    { ...tick, baselineUserTurns: 0, timeoutMs: 1000, intervalMs: 500 },
  );
  assert.equal(neverRendered.confirmed, false);
  assert.equal(neverRendered.reason, "user_turn_not_rendered");

  fakeNow = 1000;
  const noFile = await confirmAttachmentsPostSubmit(
    { send: async () => ({ result: { value: { userTurns: 1, matched: [false], fileNames: ["bundle.zip"] } } }) },
    "sess-d3", geminiAdapter, ["/tmp/bundle.zip"],
    { ...tick, baselineUserTurns: 0, timeoutMs: 1000, intervalMs: 500 },
  );
  assert.equal(noFile.confirmed, false);
  assert.equal(noFile.reason, "attachment_not_in_user_turn");
  assert.deepEqual(noFile.matched, [false]);

  const noFiles = await confirmAttachmentsPostSubmit(
    { send: async () => { throw new Error("must not evaluate"); } },
    "sess-d3", geminiAdapter, [], { ...tick },
  );
  assert.equal(noFiles.confirmed, true);
  assert.equal(noFiles.skipped, true);

  const unsupported = await confirmAttachmentsPostSubmit(
    { send: async () => ({}) },
    "sess-d3", { id: "plain" }, ["/tmp/bundle.zip"], { ...tick },
  );
  assert.equal(unsupported.confirmed, null);
  assert.equal(unsupported.supported, false);
});

function makeEngineDriver(overrides = {}) {
  const counters = { typed: 0, submitted: 0, completed: 0 };
  const driver = {
    openTab: async () => ({ targetId: "target-1", sessionId: "session-1" }),
    waitForEditor: async () => true,
    readTurnState: async () => ({
      userTurns: 0, answerTurns: 0, answerText: "", stopVisible: false,
      editorEmpty: true, loggedOut: false, pageError: null,
    }),
    attachFiles: async () => ({ attached: [], provider: "gemini" }),
    verifyAttachments: async () => ({
      present: true, matched: [true], chipCount: 1,
      chipTexts: ["package.json"], sendReady: true, inputFiles: [],
    }),
    confirmAttachmentsPostSubmit: async () => ({
      confirmed: true, userTurns: 1, matched: [true], fileNames: ["package.json"],
    }),
    typePrompt: async () => {
      counters.typed += 1;
      return { typedChars: 1, replacedChars: 0 };
    },
    submitTurn: async () => {
      counters.submitted += 1;
      return {};
    },
    waitForCompletion: async () => {
      counters.completed += 1;
      return { status: "completed", reason: "completed", text: "answer", evidence: {} };
    },
    ...overrides,
  };
  return { driver, counters };
}

function makeEngineDeps(driver) {
  return {
    enforceCooldown: async () => {},
    skipTurnLock: true,
    pace: async () => 0,
    config: { stagger: { minMs: 0, maxMs: 0 } },
    recoverBrowser: async () => ({ action: "ADOPT", chrome: { pid: 1234, port: 9222 } }),
    connectCdp: async () => ({
      send: async (method) => {
        if (method === "Runtime.evaluate") return { result: { value: "" } };
        return {};
      },
      close() {},
    }),
    driver,
  };
}

test("D3 engine (a): pre-submit re-verify fails -> ATTACH_UPLOAD_FAILED, prompt never submitted", async () => {
  await withTempDir(async (home) => {
    const { driver, counters } = makeEngineDriver({
      verifyAttachments: async () => ({
        present: false, matched: [false], chipCount: 0,
        chipTexts: [], sendReady: true, inputFiles: [],
      }),
    });
    const result = await runCdpTurn({
      provider: "gemini",
      prompt: "The repository is in the attachment. Read it.",
      home,
      files: [path.resolve("package.json")],
      deps: makeEngineDeps(driver),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "ATTACH_UPLOAD_FAILED");
    assert.equal(result.text, "");
    assert.equal(result.evidence.stage, "pre_submit_reverify");
    assert.equal(result.sendCommittedAt, undefined);
    assert.equal(counters.typed, 1, "prompt may be typed, but must not be sent");
    assert.equal(counters.submitted, 0);
    assert.equal(counters.completed, 0);
  });
});

test("D3 engine (b): verify passes at submit, attachment gone post-submit -> SUBMITTED_WITH_UNVERIFIED_ATTACHMENT, no silent timeout", async () => {
  await withTempDir(async (home) => {
    const { driver, counters } = makeEngineDriver({
      confirmAttachmentsPostSubmit: async () => ({
        confirmed: false,
        reason: "attachment_not_in_user_turn",
        userTurns: 1,
        baselineUserTurns: 0,
        matched: [false],
        fileNames: ["package.json"],
      }),
    });
    const result = await runCdpTurn({
      provider: "gemini",
      prompt: "The repository is in the attachment. Read it.",
      home,
      files: [path.resolve("package.json")],
      deps: makeEngineDeps(driver),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "SUBMITTED_WITH_UNVERIFIED_ATTACHMENT");
    assert.equal(result.text, "");
    assert.equal(counters.submitted, 1, "the prompt was submitted before the drop was detected");
    assert.equal(counters.completed, 0, "must not wait out the completion timeout on an unverified attachment");
    assert.equal(typeof result.sendCommittedAt, "number", "turn record must carry sendCommittedAt");
    assert.equal(result.evidence.attachmentPostSubmit.confirmed, false);
    assert.equal(result.evidence.attachmentPostSubmit.reason, "attachment_not_in_user_turn");
    assert.deepEqual(result.evidence.fileNames, ["package.json"]);
  });
});

test("D3 engine (c): post-submit confirmation passes -> turn completes and the confirmation is recorded", async () => {
  await withTempDir(async (home) => {
    const { driver, counters } = makeEngineDriver();
    const result = await runCdpTurn({
      provider: "gemini",
      prompt: "The repository is in the attachment. Read it.",
      home,
      files: [path.resolve("package.json")],
      deps: makeEngineDeps(driver),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.reason, "completed");
    assert.equal(counters.submitted, 1);
    assert.equal(counters.completed, 1);
    assert.equal(result.evidence.attachmentPostSubmit.confirmed, true);
    assert.deepEqual(result.evidence.attachmentPostSubmit.matched, [true]);
  });
});
