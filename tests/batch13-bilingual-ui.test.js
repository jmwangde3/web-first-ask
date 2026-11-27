import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";

test("bilingual UI: ChatGPT fileInputSelector and Gemini upload selectors cover both EN and ZH", () => {
  assert.match(chatgptAdapter.fileInputSelector, /附加文件/);
  assert.match(chatgptAdapter.fileInputSelector, /Attach files/);
  assert.match(chatgptAdapter.fileInputSelector, /Upload files/);

  assert.match(geminiAdapter.uploadTriggerSelector, /Upload & tools/);
  assert.match(geminiAdapter.uploadTriggerSelector, /上传和工具/);
  assert.match(geminiAdapter.uploadMenuItemSelector, /Upload files/);
  assert.match(geminiAdapter.uploadMenuItemSelector, /上传文件/);
});

test("bilingual UI: Gemini buildEnsureModeJs switches Task/Chat for both EN and ZH button labels", () => {
  for (const [mode, label] of [["task", "Task"], ["task", "任务"], ["chat", "Chat"], ["chat", "聊天"]]) {
    let pressed = "false";
    let clicked = false;
    const fakeBtn = {
      innerText: label,
      getAttribute: (k) => (k === "aria-pressed" ? pressed : null),
      click: () => { clicked = true; pressed = "true"; },
    };
    const fakeDoc = {
      querySelectorAll: () => [fakeBtn],
      querySelector: () => ({ getAttribute: () => "" }),
    };
    const res = vm.runInNewContext(geminiAdapter.buildEnsureModeJs(mode), { document: fakeDoc });
    assert.equal(res.ok, true, `mode=${mode} label=${label}`);
    assert.equal(res.switched, true);
    assert.equal(clicked, true);
  }
});

test("bilingual UI: Gemini buildLoginProbeJs detects English Google Account / Profile and Chinese labels", () => {
  for (const matchedSelector of ['button[aria-label*="Google Account"]', 'img[aria-label*="Profile"]', 'button[aria-label*="Google 账号"]']) {
    const fakeDoc = {
      title: "Google Gemini",
      querySelector: (sel) => (sel === matchedSelector ? {} : null),
    };
    const res = vm.runInNewContext(geminiAdapter.buildLoginProbeJs(), {
      document: fakeDoc,
      location: { hostname: "gemini.google.com", origin: "https://gemini.google.com" },
    });
    assert.equal(res.loggedIn, true, `must detect signed-in for ${matchedSelector}`);
  }
});

test("bilingual UI: Gemini sendSelector covers zh-CN '发送' and EN 'Send message' and attachment verify succeeds", () => {
  for (const label of ["Send message", "Send", "发送消息", "发送", "傳送訊息", "傳送"]) {
    assert.ok(
      geminiAdapter.sendSelector.includes(`button[aria-label="${label}"]`),
      `sendSelector must include exact aria-label="${label}"`,
    );
  }
  // Exact match only: must not use fuzzy *= which could match "Send feedback" / "发送反馈"
  assert.equal(geminiAdapter.sendSelector.includes("*="), false);

  const makeDoc = ({ hasChip, sendLabel }) => ({
    querySelectorAll: (sel) => {
      if (sel === geminiAdapter.attachmentChipSelector) {
        return hasChip
          ? [{ innerText: "TXT\nd3-attachment-r1d.txt", getBoundingClientRect: () => ({ width: 80, height: 24 }) }]
          : [];
      }
      if (sel === geminiAdapter.sendSelector) {
        return sendLabel
          ? [{
              disabled: false,
              getAttribute: (k) => (k === "aria-label" ? sendLabel : (k === "aria-disabled" ? "false" : null)),
              getBoundingClientRect: () => ({ width: 32, height: 32 }),
            }]
          : [];
      }
      return [];
    },
    querySelector: () => null,
  });

  const okZh = vm.runInNewContext(geminiAdapter.buildAttachmentVerifyJs(["d3-attachment-r1d.txt"]), {
    document: makeDoc({ hasChip: true, sendLabel: "发送" }),
  });
  assert.equal(okZh.present, true);
  assert.equal(okZh.sendReady, true);
  assert.deepEqual([...okZh.matched], [true]);

  const missingChip = vm.runInNewContext(geminiAdapter.buildAttachmentVerifyJs(["d3-attachment-r1d.txt"]), {
    document: makeDoc({ hasChip: false, sendLabel: "发送" }),
  });
  assert.equal(missingChip.present, false);
});
