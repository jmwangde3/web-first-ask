import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { archiveRepository, buildZip, collectTrackedSources, repositoryArchiveBlock } from "../src/repository-archive.js";
import { isArchiveAttachment } from "../src/attachments.js";
import { buildJobs } from "../src/jobs.js";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", windowsHide: true,
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
}).trim();

function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, "EOCD record not found");
  assert.equal(buffer.readUInt16LE(eocd + 4), 0);
  assert.equal(buffer.readUInt16LE(eocd + 6), 0);
  const count = buffer.readUInt16LE(eocd + 10);
  assert.equal(count, buffer.readUInt16LE(eocd + 8));
  const entries = [];
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "bad central directory signature");
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "bad local header signature");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(start, start + compressed);
    const data = method === 0 ? payload : inflateRawSync(payload);
    assert.equal(data.length, uncompressed, `size mismatch for ${name}`);
    entries.push({ name, data, checksum, method });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function withRepo(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-archive-repo-"));
  const out = await mkdtemp(path.join(os.tmpdir(), "wfa-archive-out-"));
  try {
    git(root, "init", "-q");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(root, "src", "a.js"), "export const a = 1;\n");
    await writeFile(path.join(root, "src", "b.js"), "export const b = 2;\n");
    await writeFile(path.join(root, "README.md"), "# demo\n");
    await writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(root, ".env"), "SECRET=1\n");
    await writeFile(path.join(root, "node_modules", "dep", "index.js"), "junk\n");
    git(root, "add", "-f", ".");
    git(root, "commit", "-q", "-m", "init");
    return await fn({ root, out });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("buildZip round-trips names, empty files and both storage methods", () => {
  const entries = [
    { name: "src/中文.js", data: Buffer.from("const 值 = 1;\n", "utf8") },
    { name: "empty.txt", data: Buffer.alloc(0) },
    { name: "big.txt", data: Buffer.from("ab".repeat(20000), "utf8") },
  ];
  const zip = buildZip(entries);
  const restored = readZip(zip);
  assert.equal(restored.length, 3);
  for (const [index, entry] of restored.entries()) {
    assert.equal(entry.name, entries[index].name);
    assert.deepEqual(entry.data, entries[index].data);
  }
  // A highly repetitive body must actually be deflated, not stored.
  assert.equal(restored[2].method, 8);
  assert.ok(restored[2].data.length > 30000);
});

test("archiveRepository ships tracked text sources and drops sensitive or ignored ones", async () => {
  await withRepo(async ({ root, out }) => {
    const result = await archiveRepository({ cwd: root, outDir: out });
    const names = readZip(await readFile(result.file)).map((entry) => entry.name).sort();
    assert.deepEqual(names, ["README.md", "src/a.js", "src/b.js"]);
    assert.equal(result.stats.files, 3);
    const skipped = result.skipped.map((item) => item.path);
    assert.ok(skipped.includes(".env"), "sensitive file must be skipped");
    assert.ok(skipped.includes("logo.png"), "binary file must be skipped");
    assert.ok(skipped.includes("node_modules/dep/index.js"), "vendored file must be skipped");
  });
});

test("archiveRepository honours --exclude and keeps mentioned files", async () => {
  await withRepo(async ({ root, out }) => {
    const result = await archiveRepository({ cwd: root, outDir: out, excludes: ["src/**"], prompt: "please fix src/b.js" });
    const names = readZip(await readFile(result.file)).map((entry) => entry.name).sort();
    assert.deepEqual(names, ["README.md"]);
    assert.equal(result.stats.listed, 1);
  });
});

test("archiveRepository compresses a real tree well below its source size", async () => {
  await withRepo(async ({ root, out }) => {
    const many = Array.from({ length: 40 }, (_, i) => `export function fn${i}() { return ${i}; }\n`).join("");
    await writeFile(path.join(root, "src", "bulk.js"), many);
    git(root, "add", "src/bulk.js");
    git(root, "commit", "-q", "-m", "bulk");
    const result = await archiveRepository({ cwd: root, outDir: out });
    assert.ok(result.stats.archiveBytes < result.stats.sourceBytes);
    assert.ok(result.stats.ratio < 1);
  });
});

test("collectTrackedSources reports the skip reason for every dropped file", async () => {
  await withRepo(async ({ root }) => {
    const { selected, skipped } = await collectTrackedSources({ cwd: root });
    assert.ok(selected.includes("src/a.js"));
    const reasons = Object.fromEntries(skipped.map((item) => [item.path, item.reason]));
    assert.equal(reasons[".env"], "sensitive filename");
    assert.equal(reasons["logo.png"], "binary or generated filename");
  });
});

test("repositoryArchiveBlock names the attachment and the commit", async () => {
  await withRepo(async ({ root, out }) => {
    const result = await archiveRepository({ cwd: root, outDir: out });
    const block = repositoryArchiveBlock(result, { commit: "abc123", branch: "main" });
    assert.match(block, /^REPOSITORY ARCHIVE/);
    assert.match(block, /END REPOSITORY ARCHIVE$/);
    assert.ok(block.includes(path.basename(result.file)));
    assert.ok(block.includes("abc123"));
    assert.ok(block.includes("branch main"));
    assert.match(block, /repository-relative/);
  });
});

test("archive attachments are recognised so Gemini accepts them natively", () => {
  assert.ok(isArchiveAttachment("repo.zip"));
  assert.ok(isArchiveAttachment("REPO.ZIP"));
  assert.ok(isArchiveAttachment("src.tgz"));
  assert.ok(!isArchiveAttachment("src/a.js"));
  assert.ok(!isArchiveAttachment("report.pdf"));
  const jobs = buildJobs({
    taskId: "11111111-2222-3333-4444-555555555555",
    providers: ["chatgpt", "gemini"],
    prompt: "look at the archive",
    timeoutSeconds: 60,
    files: [path.join(os.tmpdir(), "repo.zip")],
  });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[1].files, [path.join(os.tmpdir(), "repo.zip")]);
  assert.throws(() => buildJobs({
    taskId: "11111111-2222-3333-4444-555555555555",
    providers: ["gemini"],
    prompt: "look at the document",
    timeoutSeconds: 60,
    files: [path.join(os.tmpdir(), "report.pdf")],
  }), /GEMINI_ATTACHMENT_UNSUPPORTED|Gemini document attachments/);
});

test("two archives of the same repository in the same second do not collide", async () => {
  await withRepo(async ({ root, out }) => {
    const first = await archiveRepository({ cwd: root, outDir: out });
    const second = await archiveRepository({ cwd: root, outDir: out });
    assert.notEqual(first.file, second.file);
    assert.ok((await readFile(first.file)).length > 0);
    assert.ok((await readFile(second.file)).length > 0);
  });
});

test("secret-shaped source lines are reported, not shipped as an unscanned blob", async () => {
  await withRepo(async ({ root, out }) => {
    await writeFile(path.join(root, "src", "config.js"), 'export const api_key = "' + "abcdefghijklmnop" + '";\n');
    git(root, "add", "src/config.js");
    git(root, "commit", "-q", "-m", "config");
    const result = await archiveRepository({ cwd: root, outDir: out });
    assert.equal(result.scannedFiles, result.stats.files);
    assert.ok(result.secretFindings.some((finding) =>
      finding.source === "src/config.js" && finding.kind === "secret_assignment"));
  });
});

test("pruning keeps a fresh archive that may still be uploading", async () => {
  await withRepo(async ({ root, out }) => {
    const first = await archiveRepository({ cwd: root, outDir: out, keepArchives: 1 });
    const second = await archiveRepository({ cwd: root, outDir: out, keepArchives: 1 });
    await readFile(first.file);
    await readFile(second.file);
    // Once the old one is past the protected window, the count wins again.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(first.file, old, old);
    await archiveRepository({ cwd: root, outDir: out, keepArchives: 1 });
    await assert.rejects(() => readFile(first.file), /ENOENT/);
  });
});

test("the archive block admits a dirty working tree instead of claiming the commit", async () => {
  await withRepo(async ({ root, out }) => {
    const result = await archiveRepository({ cwd: root, outDir: out });
    const clean = repositoryArchiveBlock(result, { commit: "abc123", branch: "main" });
    assert.doesNotMatch(clean, /uncommitted changes/);
    const dirty = repositoryArchiveBlock(result, {
      commit: "abc123", branch: "main", dirty: true, dirtyFiles: ["src/a.js"],
    });
    assert.match(dirty, /uncommitted changes/);
    assert.match(dirty, /1 file\(s\)/);
  });
});
