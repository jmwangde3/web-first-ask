import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as chatgptAdapter from "../src/browser/adapters/chatgpt.js";
import * as geminiAdapter from "../src/browser/adapters/gemini.js";
import { attachFiles } from "../src/browser/driver.js";

test("adapter upload contract exposes valid selectors and buildUploadJs", () => {
  // ChatGPT contract verification (bilingual ZH + EN)
  assert.ok(chatgptAdapter.fileInputSelector.includes('aria-label="附加文件"'));
  assert.ok(chatgptAdapter.fileInputSelector.includes('aria-label="Attach files"'));
  assert.ok(chatgptAdapter.fileInputSelector.includes('aria-label="Upload files"'));
  assert.ok(chatgptAdapter.uploadTriggerSelector.includes('aria-label="添加文件等内容"'));
  assert.ok(chatgptAdapter.uploadTriggerSelector.includes('aria-label="Add files"'));
  const chatgptJs = chatgptAdapter.buildUploadJs();
  assert.equal(typeof chatgptJs, "string");
  assert.ok(chatgptJs.includes("添加文件等内容"));

  // Gemini contract verification (bilingual EN + ZH)
  assert.ok(geminiAdapter.uploadTriggerSelector.includes('aria-label="Upload & tools"'));
  assert.ok(geminiAdapter.uploadTriggerSelector.includes('aria-label="上传和工具"'));
  assert.ok(geminiAdapter.uploadMenuItemSelector.includes('aria-label^="Upload files"'));
  assert.ok(geminiAdapter.uploadMenuItemSelector.includes('aria-label^="上传文件"'));
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
        const expression = String(params?.expression || "");
        // 附件验证表达式（含 chipCount）返回 chip 已出现；inputFiles 为空仍应判成功。
        if (expression.includes("chipCount")) {
          return { result: { value: {
            present: true, sendReady: true, matched: [true], chipCount: 1,
            chipTexts: ["package.json"], inputFiles: [],
          } } };
        }
        return { result: { value: { editorFound: true } } };
      }
      return {};
    },
  };

  const res = await attachFiles(mockCdp, "sess-1", chatgptAdapter, [testFile], {
    sleep: async () => {},
    now: () => 0,
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
        const expression = String(params?.expression || "");
        if (expression.includes("chipCount")) {
          return { result: { value: { present: true, sendReady: true, matched: [true], chipCount: 1, chipTexts: ["package.json"], inputFiles: [] } } };
        }
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
    now: () => 0,
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

test("driver.attachFiles: chip appears late but within timeout -> success", async () => {
  const testFile = path.resolve("package.json");
  let verifyCalls = 0;
  let fakeNow = 1000;
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "Runtime.evaluate" && String(params?.expression || "").includes("chipCount")) {
        verifyCalls += 1;
        const present = verifyCalls >= 3;
        return { result: { value: { present, matched: [present], sendReady: present, chipCount: present ? 1 : 0, chipTexts: present ? ["package.json"] : [], inputFiles: [] } } };
      }
      return {};
    },
  };
  const res = await attachFiles(mockCdp, "sess-late", chatgptAdapter, [testFile], {
    sleep: async () => { fakeNow += 200; },
    now: () => fakeNow,
  });
  assert.deepEqual(res.attached, [testFile]);
  assert.equal(verifyCalls, 3, "should poll until chip appears");
});

test("driver.attachFiles: chip never appears -> ATTACH_UPLOAD_FAILED (fail-closed)", async () => {
  const testFile = path.resolve("package.json");
  let fakeNow = 1000;
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "Runtime.evaluate" && String(params?.expression || "").includes("chipCount")) {
        return { result: { value: { present: false, matched: [false], chipCount: 0, chipTexts: [], inputFiles: [] } } };
      }
      return {};
    },
  };
  await assert.rejects(
    () => attachFiles(mockCdp, "sess-fail", chatgptAdapter, [testFile], {
      sleep: async () => { fakeNow += 200; },
      now: () => fakeNow,
      attachmentVerifyTimeoutMs: 1000,
    }),
    (err) => err?.code === "ATTACH_UPLOAD_FAILED" && /chip not visible/i.test(err.message)
  );
});

test("driver.attachFiles: input.files present but no chip -> still fails", async () => {
  const testFile = path.resolve("package.json");
  let fakeNow = 1000;
  const mockCdp = {
    send: async (method, params = {}) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "Runtime.evaluate" && String(params?.expression || "").includes("chipCount")) {
        return { result: { value: { present: false, matched: [false], chipCount: 0, chipTexts: [], inputFiles: ["package.json"] } } };
      }
      return {};
    },
  };
  await assert.rejects(
    () => attachFiles(mockCdp, "sess-fail2", chatgptAdapter, [testFile], {
      sleep: async () => { fakeNow += 200; },
      now: () => fakeNow,
      attachmentVerifyTimeoutMs: 1000,
    }),
    (err) => err?.code === "ATTACH_UPLOAD_FAILED"
  );
});
