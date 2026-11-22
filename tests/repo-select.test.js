import test from "node:test";
import assert from "node:assert/strict";
import {
  DIRECTORY_FILE_EXTENSIONS,
  SKIP_DIRS,
  SKIP_EXT,
  SENSITIVE_NAME,
  TEXT_SOURCE_EXTENSIONS,
  isSelectableFile,
  matchesExclude,
  selectionReason,
} from "../src/repo-select.js";
import { isTextSourceAttachment } from "../src/attachments.js";

test("repository selection excludes the union of sensitive and minified filenames", () => {
  for (const file of [
    ".env", ".env.local", ".npmrc", ".netrc", ".pypirc",
    "credentials", "secrets.json", "service-account.json",
    "src/id_rsa", "src/id_ed25519", "private.pem",
    "private.key", "private.p12", "private.pfx",
    "private.keystore",
  ]) {
    assert.equal(selectionReason(file), "sensitive filename", file);
    assert.equal(isSelectableFile(file), false, file);
  }

  for (const file of [
    "src/library.min.js", "src/site.min.css",
    "assets/APP.MIN.JS", "assets/APP.MIN.CSS",
  ]) {
    assert.equal(selectionReason(file), "minified source filename", file);
    assert.equal(isSelectableFile(file), false, file);
  }

  assert.equal(isSelectableFile("src/app.js"), true);
  assert.equal(isSelectableFile("README.md"), true);
});

test("repository selection preserves binary, cache and exclude classifications", () => {
  assert.ok(SKIP_DIRS.has("node_modules"));
  assert.ok(SKIP_EXT.has(".pdf"));
  assert.ok(SENSITIVE_NAME.test("src/.npmrc"));

  assert.equal(selectionReason("logo.png"), "binary or generated filename");
  assert.equal(selectionReason("package.lock"), "binary or generated filename");
  assert.equal(selectionReason("node_modules/pkg/index.js"), "build/cache directory");

  assert.equal(matchesExclude("src/a.js", ["src/**"]), true);
  assert.equal(matchesExclude("src/nested/a.js", ["src/**"]), true);
  assert.equal(matchesExclude("src/a.test.js", ["*.test.js"]), true);
  assert.equal(matchesExclude("src/a.js", ["docs/**"]), false);
});

test("notebook is attachable but not a text-source attachment", () => {
  assert.equal(DIRECTORY_FILE_EXTENSIONS.has(".ipynb"), true);
  assert.equal(TEXT_SOURCE_EXTENSIONS.has(".ipynb"), false);
  assert.equal(isTextSourceAttachment("analysis.ipynb"), false);

  assert.equal(DIRECTORY_FILE_EXTENSIONS.has(".js"), true);
  assert.equal(TEXT_SOURCE_EXTENSIONS.has(".js"), true);
  assert.equal(isTextSourceAttachment("src/app.js"), true);
});
