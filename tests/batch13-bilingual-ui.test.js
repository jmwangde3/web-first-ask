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
