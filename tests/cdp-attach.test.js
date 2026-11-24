import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { attachFiles } from "../src/browser/driver.js";

test("adapter upload contract exposes valid selectors and buildUploadJs", () => {
  // ChatGPT contract verification
  assert.equal(chatgptAdapter.fileInputSelector, 'input[type="file"][aria-label="附加文件"]');
  assert.equal(chatgptAdapter.buildUploadJs(), null);

  // Gemini contract verification
  assert.equal(geminiAdapter.uploadTriggerSelector, 'button[aria-label="Upload & tools"]');
  assert.equal(geminiAdapter.uploadMenuItemSelector, '[role="menuitem"][aria-label^="Upload files"]');
  assert.equal(geminiAdapter.fileInputSelector, 'input[type="file"].hidden-file-input[accept^=".txt"]');
  const geminiJs = geminiAdapter.buildUploadJs();
  assert.equal(typeof geminiJs, "string");
  // 脚本内用 JSON.stringify 注入选择器（引号被转义），断言检查关键片段而非整串。
  assert.ok(geminiJs.includes("Upload & tools"));
  assert.ok(geminiJs.includes("Upload files"));
  assert.ok(geminiJs.includes("hidden-file-input"));
});

test("driver.attachFiles: full successful DOM.setFileInputFiles flow with mock CDP", async () => {
  const cdpSent = [];
  const testFile = path.resolve("package.json");

  const mockCdp = {
    send: async (method, params = {}, sessionId) => {
      cdpSent.push({ method, params, sessionId });
      if (method === "DOM.getDocument") {
        return { root: { nodeId: 1 } };
      }
      if (method === "DOM.querySelector") {
        return { nodeId: 42 };
      }
      if (method === "DOM.setFileInputFiles") {
        return {};
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { editorFound: true } } };
      }
      return {};
    },
  };

  const res = await attachFiles(mockCdp, "sess-1", chatgptAdapter, [testFile], {
    sleep: async () => {},
  });

  assert.deepEqual(res.attached, [testFile]);
  assert.equal(res.provider, "chatgpt");

  const methods = cdpSent.map((c) => c.method);
  assert.ok(methods.includes("DOM.getDocument"));
  assert.ok(methods.includes("DOM.querySelector"));
  assert.ok(methods.includes("DOM.setFileInputFiles"));

  const setCall = cdpSent.find((c) => c.method === "DOM.setFileInputFiles");
  assert.equal(setCall.params.nodeId, 42);
  assert.deepEqual(setCall.params.files, [testFile]);
});

test("driver.attachFiles: falls back to backendNodeId when DOM.querySelector fails", async () => {
  const cdpSent = [];
  const testFile = path.resolve("package.json");

  const mockCdp = {
    send: async (method, params = {}, sessionId) => {
      cdpSent.push({ method, params, sessionId });
      if (method === "DOM.getDocument") {
        return { root: { nodeId: 1 } };
      }
      if (method === "DOM.querySelector") {
        return { nodeId: 0 };
      }
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "obj-99", value: { editorFound: true } } };
      }
      if (method === "DOM.describeNode") {
        return { node: { backendNodeId: 888 } };
      }
      if (method === "DOM.setFileInputFiles") {
        return {};
      }
      return {};
    },
  };

  const res = await attachFiles(mockCdp, "sess-2", geminiAdapter, [testFile], {
    sleep: async () => {},
  });

  assert.deepEqual(res.attached, [testFile]);
  const setCall = cdpSent.find((c) => c.method === "DOM.setFileInputFiles");
  assert.equal(setCall.params.backendNodeId, 888);
  assert.equal(setCall.params.nodeId, undefined);
  assert.deepEqual(setCall.params.files, [testFile]);
});

test("driver.attachFiles: rejects relative paths explicitly", async () => {
  const mockCdp = {
    send: async () => ({}),
  };

  await assert.rejects(
    () => attachFiles(mockCdp, "sess-3", chatgptAdapter, ["relative/path/test.txt"]),
    {
      code: "ATTACHMENT_NOT_FOUND",
      message: /Attachment path must be absolute/,
    }
  );
});

test("driver.attachFiles: throws CANCELLED on aborted signal", async () => {
  const mockCdp = {
    send: async () => ({}),
  };
  const ctrl = new AbortController();
  ctrl.abort();

  await assert.rejects(
    () => attachFiles(mockCdp, "sess-4", chatgptAdapter, [path.resolve("package.json")], { signal: ctrl.signal }),
    {
      code: "CANCELLED",
    }
  );
});
