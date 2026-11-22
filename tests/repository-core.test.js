import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectCoreEntries } from "../src/repository.js";

async function withFixture(manifest, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-core-"));
  try {
    if (manifest !== undefined) {
      await writeFile(path.join(root, "package.json"),
        typeof manifest === "string" ? manifest : JSON.stringify(manifest),
        "utf8");
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("core entries prioritize manifest, README, main, bin and exports", async () => {
  await withFixture({
    main: "./lib/main.js",
    bin: { demo: "./bin/demo.js" },
    exports: {
      ".": {
        import: "./esm/index.js",
        require: "./cjs/index.cjs",
      },
      "./extra": "./lib/extra.js",
    },
  }, async (root) => {
    // This represents the tracked and eligible file list returned by Git.
    // Files not present here must never become core entry points.
    const eligible = [
      "package.json", "README.md",
      "lib/main.js", "bin/demo.js",
      "esm/index.js", "cjs/index.cjs", "lib/extra.js",
      "src/index.js", "index.js", "main.py",
      "unrelated.js",
    ];
    assert.deepEqual(await selectCoreEntries(root, eligible), [
      "package.json", "README.md",
      "lib/main.js", "bin/demo.js",
      "esm/index.js", "cjs/index.cjs", "lib/extra.js",
      "src/index.js",
    ]);
  });
});

test("core entries ignore absent, excluded, unsafe and duplicate paths", async () => {
  await withFixture({
    main: "../outside.js",
    bin: {
      excluded: "./dist/entry.js",
      real: "./src/index.js",
    },
    exports: {
      ".": ["./src/index.js", "/outside.js", "./not-tracked.js"],
    },
  }, async (root) => {
    const eligible = [
      "package.json", "README.md",
      "src/index.js", "index.js",
      "Cargo.toml", "go.mod", "pyproject.toml",
      "outside.js",
    ];
    assert.deepEqual(await selectCoreEntries(root, eligible), [
      "package.json", "README.md",
      "src/index.js", "index.js",
      "Cargo.toml", "go.mod", "pyproject.toml",
    ]);
  });
});

test("non-JavaScript repositories use existing conventional entry points", async () => {
  await withFixture(undefined, async (root) => {
    assert.deepEqual(await selectCoreEntries(root, [
      "README.md", "main.py", "Cargo.toml", "go.mod", "pyproject.toml",
    ]), [
      "README.md", "main.py", "Cargo.toml", "go.mod", "pyproject.toml",
    ]);
  });
});

test("malformed package metadata does not fail repository inventory", async () => {
  await withFixture("{bad json", async (root) => {
    assert.deepEqual(await selectCoreEntries(root, [
      "package.json", "README.md", "src/index.js",
    ]), [
      "package.json", "README.md", "src/index.js",
    ]);
  });
});
