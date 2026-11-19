import test from "node:test";
import assert from "node:assert/strict";
import { buildCodePrompt, buildComparePrompt } from "../src/prompts.js";

test("code prompt demands complete replacement files rather than a plan or diff", () => {
  const prompt = buildCodePrompt({
    requirement: "Fix task recovery.",
    filePaths: ["src/tasks.js", "test/tasks.test.js"],
  });
  assert.match(prompt, /完整、可直接保存的全部内容/);
  assert.match(prompt, /不得输出 diff 代替/);
  assert.match(prompt, /FILE: 相对仓库路径/);
  assert.match(prompt, /Fix task recovery/);
  assert.match(prompt, /src\/tasks.js/);
  assert.match(prompt, /test\/tasks.test.js/);
});


test("multi-provider prompt asks each provider to work independently", () => {
  const prompt = buildComparePrompt("Implement the same requirement.");
  assert.match(prompt, /独立完成/);
  assert.match(prompt, /完整代码/);
});
