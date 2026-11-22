import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundleRepository } from "../src/repository.js";
import { archiveRepository, collectTrackedSources } from "../src/repository-archive.js";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  windowsHide: true,
});

test("inline and archive use the same tracked-file selection union", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-selection-"));
  const out = await mkdtemp(path.join(os.tmpdir(), "wfa-selection-out-"));
  try {
    git(root, "init", "-q");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# test\n");
    await writeFile(path.join(root, "src", "app.js"), "export const app = true;\n");
    await writeFile(path.join(root, "src", "app.min.js"), "const a=1;\n");
    await writeFile(path.join(root, "src", "app.min.css"), ".a{color:red}\n");
    await writeFile(path.join(root, ".npmrc"), "private=true\n");
    await writeFile(path.join(root, "secrets.json"), '{"secret":true}\n');
    await writeFile(path.join(root, "src", "logo.png"), Buffer.from([0, 1, 2]));

    git(root, "add", "-f", ".");

    // This file is deliberately untracked.
    await writeFile(path.join(root, "src", "untracked.js"), "not tracked\n");

    const tracked = await collectTrackedSources({ cwd: root });
    assert.deepEqual(tracked.selected.sort(), [
      "README.md", "src/app.js",
    ]);

    const reasons = Object.fromEntries(
      tracked.skipped.map((item) => [item.path, item.reason]),
    );
    assert.equal(reasons[".npmrc"], "sensitive filename");
    assert.equal(reasons["secrets.json"], "sensitive filename");
    assert.equal(reasons["src/app.min.js"], "minified source filename");
    assert.equal(reasons["src/app.min.css"], "minified source filename");
    assert.equal(reasons["src/logo.png"], "binary or generated filename");

    const inline = await bundleRepository({
      cwd: root,
      includes: ["src/app.js"],
      prompt: "review src/app.js",
    });
    const archive = await archiveRepository({
      cwd: root,
      outDir: out,
      prompt: "review src/app.js",
    });

    assert.equal(inline.stats.listed, tracked.selected.length);
    assert.equal(archive.stats.listed, tracked.selected.length);
    assert.equal(archive.stats.files, tracked.selected.length);
    assert.equal(inline.stats.files, 1);
    assert.match(inline.content, /export const app = true/);
    assert.doesNotMatch(inline.content, /app\.min\.js/);
    assert.doesNotMatch(inline.content, /untracked\.js/);
    assert.ok((await readFile(archive.file)).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
