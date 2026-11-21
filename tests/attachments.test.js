import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandAttachmentInputs } from "../src/attachments.js";

test("directory attachments recurse, classify images, skip generated/dependency and secret paths, and apply glob excludes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-attachments-"));
  try {
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, ".wfa"), { recursive: true });
    await writeFile(path.join(root, "src", "a.js"), "export const a = 1;\n");
    await writeFile(path.join(root, "src", "nested", "b.test.js"), "test();\n");
    await writeFile(path.join(root, "src", "readme.md"), "# notes\n");
    await writeFile(path.join(root, "src", "diagram.png"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(root, "src", "manual.pdf"), Buffer.from([4, 5, 6]));
    await writeFile(path.join(root, "src", ".env"), "API_KEY=" + "secret-secret-secret\n");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored\n");
    await writeFile(path.join(root, ".wfa", "active-brief.md"), "not an attachment\n");

    const result = await expandAttachmentInputs({
      files: ["src"],
      excludes: ["**/*.test.js"],
      cwd: root,
    });
    assert.deepEqual(result.files.map((item) => path.relative(root, item).replaceAll("\\", "/")), [
      "src/manual.pdf",
      "src/readme.md",
      "src/a.js",
    ].sort());
    assert.deepEqual(result.images.map((item) => path.relative(root, item).replaceAll("\\", "/")), ["src/diagram.png"]);
    assert.equal(result.count, 4);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("quoted glob patterns support recursive matching, brace alternatives and ! exclusions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-glob-"));
  try {
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(root, "src", "a.js"), "a\n");
    await writeFile(path.join(root, "src", "a.md"), "a\n");
    await writeFile(path.join(root, "src", "nested", "b.js"), "b\n");
    await writeFile(path.join(root, "src", "nested", "b.test.js"), "test\n");
    const result = await expandAttachmentInputs({
      files: ["src/**/*.{js,md}", "!**/*.test.js"],
      cwd: root,
    });
    assert.deepEqual(result.files.map((item) => path.relative(root, item).replaceAll("\\", "/")), [
      "src/a.js", "src/a.md", "src/nested/b.js",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("explicit image inputs reject non-image file types", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-image-"));
  try {
    const file = path.join(root, "notes.md");
    await writeFile(file, "hello");
    await assert.rejects(
      () => expandAttachmentInputs({ images: [file], cwd: root }),
      { code: "IMAGE_TYPE_UNSUPPORTED" },
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
