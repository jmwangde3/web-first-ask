import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildLineNumberedBundle,
  resolveBriefText,
  scanSensitiveText,
  estimateTokens,
} from "../src/bundle.js";

test("line-numbered bundle preserves relative paths, blank lines and CRLF line numbers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-bundle-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const file = path.join(root, "src", "sample.js");
    await writeFile(file, "const a = 1;\r\n\r\nconst b = 2;\r\n", "utf8");
    const bundle = await buildLineNumberedBundle([file], { cwd: root });
    assert.match(bundle.content, /src\/sample\.js:1 \| const a = 1;/);
    assert.ok(bundle.content.includes("src/sample.js:2 | \n"));
    assert.match(bundle.content, /src\/sample\.js:3 \| const b = 2;/);
    assert.equal(bundle.files[0].lines, 3);
    assert.equal(bundle.sha256.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("bundle rejects binary and invalid UTF-8 input instead of silently corrupting it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-bundle-binary-"));
  try {
    const binary = path.join(root, "binary.js");
    await writeFile(binary, Buffer.from([0, 1, 2]));
    await assert.rejects(() => buildLineNumberedBundle([binary], { cwd: root }), { code: "BUNDLE_BINARY_FILE" });
    const invalid = path.join(root, "invalid.js");
    await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await assert.rejects(() => buildLineNumberedBundle([invalid], { cwd: root }), { code: "BUNDLE_INVALID_UTF8" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("brief auto-discovery is optional while an explicitly requested missing brief fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-brief-"));
  try {
    assert.equal(await resolveBriefText({ cwd: root, shouldAutoInject: true }), "");
    await assert.rejects(() => resolveBriefText({ cwd: root, briefFile: "missing.md" }), { code: "BRIEF_READ_FAILED" });
    await mkdir(path.join(root, ".wfa"), { recursive: true });
    await writeFile(path.join(root, ".wfa", "active-brief.md"), "# Hot state\nTask: recovery\n");
    assert.match(await resolveBriefText({ cwd: root, shouldAutoInject: true }), /Hot state/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("secret scanner reports source and line without exposing matched secret values", () => {
  const findings = scanSensitiveText("ok\nAPI_KEY=super-secret-token-value\n", "src/config.js");
  assert.deepEqual(findings, [{ source: "src/config.js", line: 2, kind: "secret_assignment" }]);
  assert.ok(estimateTokens("12345678") > 0);
});
