import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { executeTask } from "../src/runner.js";

const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));

async function withHome(prefix, fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function dryRunCli(home, args) {
  const run = spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, WFA_HOME: home },
    encoding: "utf8",
  });
  return { status: run.status, stderr: run.stderr, preview: run.stdout ? JSON.parse(run.stdout) : null };
}

test("config defaults to both providers, serial execution and a single login provider", async () => {
  await withHome("wfa-defaults-", async (home) => {
    const config = await loadConfig(home);
    assert.deepEqual(config.defaultProviders, ["chatgpt", "gemini"]);
    assert.equal(config.defaultConcurrency, 1);
    assert.equal(config.defaultProvider, "chatgpt");

    await writeFile(path.join(home, "config.json"), JSON.stringify({
      defaultProviders: "claude,chatgpt",
      defaultConcurrency: 2,
    }));
    const overridden = await loadConfig(home);
    assert.deepEqual(overridden.defaultProviders, ["claude", "chatgpt"]);
    assert.equal(overridden.defaultConcurrency, 2);
  });
});

test("CLI defaults to chatgpt+gemini serially and still allows narrowing", async () => {
  await withHome("wfa-defaults-cli-", async (home) => {
    const wide = dryRunCli(home, ["ask", "--prompt", "x", "--dry-run"]);
    assert.equal(wide.status, 0, wide.stderr);
    assert.deepEqual(wide.preview.providers, ["chatgpt", "gemini"]);
    assert.equal(wide.preview.concurrency, 1);

    const narrow = dryRunCli(home, ["ask", "--provider", "chatgpt", "--prompt", "x", "--dry-run"]);
    assert.equal(narrow.status, 0, narrow.stderr);
    assert.deepEqual(narrow.preview.providers, ["chatgpt"]);

    const explicit = dryRunCli(home, ["ask", "--providers", "chatgpt,gemini", "--concurrency", "2", "--prompt", "x", "--dry-run"]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.preview.concurrency, 2);
  });
});

test("Gemini gets text attachments inlined instead of uploaded", async () => {
  await withHome("wfa-gemini-inline-", async (home) => {
    const file = path.join(home, "note.md");
    await writeFile(file, "# Note\nbody\n");
    const { preview, status, stderr } = dryRunCli(home, ["ask", "--prompt", "review", "--file", file, "--dry-run"]);

    assert.equal(status, 0, stderr);
    assert.equal(preview.geminiAttachmentBlocked, false);
    assert.equal(preview.geminiInline.files, 1);
    assert.ok(preview.geminiInline.bytes >= 12);
    assert.ok(preview.promptBytesByProvider.gemini > preview.promptBytesByProvider.chatgpt);
    assert.equal(preview.blocked, false);
  });
});

test("a binary attachment blocks Gemini in dry-run and fails before launch", async () => {
  await withHome("wfa-gemini-binary-", async (home) => {
    const binary = path.join(home, "doc.pdf");
    await writeFile(binary, "%PDF-1.4 not text\n");

    const dry = dryRunCli(home, ["ask", "--prompt", "read", "--file", binary, "--dry-run"]);
    assert.equal(dry.status, 2, dry.stderr);
    assert.equal(dry.preview.blocked, true);
    assert.ok(dry.preview.blockReasons.includes("GEMINI_ATTACHMENT_UNSUPPORTED"));

    let launches = 0;
    await assert.rejects(
      () => executeTask({
        prompt: "read",
        providers: ["chatgpt", "gemini"],
        workspace: "binary-probe",
        workspaceRoot: home,
        files: [binary],
      }, {
        home,
        skipPreflight: true,
        runProcess: async () => { launches += 1; },
      }),
      (error) => error.code === "GEMINI_ATTACHMENT_UNSUPPORTED",
    );
    assert.equal(launches, 0);
  });
});

test("an oversized prompt is rejected before the task is created", async () => {
  await withHome("wfa-oversize-", async (home) => {
    // Pass the body through a file: Windows caps a command line at ~32 KiB.
    const promptFile = path.join(home, "big-prompt.txt");
    await writeFile(promptFile, "x".repeat(45 * 1024));
    const dry = dryRunCli(home, ["ask", "--prompt-file", promptFile, "--dry-run"]);
    assert.equal(dry.status, 2, dry.stderr ?? "no stderr");
    assert.equal(dry.preview.blocked, true);
    assert.deepEqual(dry.preview.blockReasons, ["PROMPT_OVERSIZE"]);

    let launches = 0;
    await assert.rejects(
      () => executeTask({
        prompt: "x".repeat(45 * 1024),
        providers: ["chatgpt", "gemini"],
        workspace: "oversize-probe",
      }, {
        home,
        skipPreflight: true,
        runProcess: async () => { launches += 1; },
      }),
      (error) => error.code === "PROMPT_OVERSIZE"
        && /exceeds 40960 bytes/.test(error.message)
        && /chatgpt=\d+ bytes/.test(error.message)
        && /--allow-oversize/.test(error.message),
    );
    assert.equal(launches, 0);
  });
});

test("splitPlan groups attachments by the prompt limit and conserves bytes", async () => {
  await withHome("wfa-splitplan-", async (home) => {
    const paths = [];
    for (const [name, bytes] of [["a.txt", 25 * 1024], ["b.txt", 25 * 1024], ["c.txt", 45 * 1024]]) {
      const filePath = path.join(home, name);
      await writeFile(filePath, "x".repeat(bytes));
      paths.push(filePath);
    }

    const { preview, status, stderr } = dryRunCliWithFiles(home, paths);
    assert.equal(status, 0, stderr);

    const groups = preview.promptSizeRisk.splitPlan;
    assert.equal(groups.reduce((sum, group) => sum + group.bytes, 0), preview.attachmentBytes);
    assert.deepEqual(groups.map((group) => group.files.length), [1, 1, 1]);
    assert.equal(groups[2].oversizeFile, true);
  });
});

function dryRunCliWithFiles(home, paths) {
  const args = ["ask", "--provider", "chatgpt", "--prompt", "x", "--dry-run"];
  for (const filePath of paths) args.push("--file", filePath);
  return dryRunCli(home, args);
}

test("--bundle-repo=zip previews a native attachment, keeps it out of the split plan, and scans inside it", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-zip-preview-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-zip-preview-home-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  const preview = () => {
    const run = spawnSync(process.execPath, [bin, "ask", "--provider", "chatgpt", "--bundle-repo=zip",
      "--prompt", "review the sources", "--dry-run"], {
      cwd: root, env: { ...process.env, WFA_HOME: home }, encoding: "utf8",
    });
    return { status: run.status, stderr: run.stderr, preview: run.stdout ? JSON.parse(run.stdout) : null };
  };
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "T");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.js"), "export const a = 1;\n");
    await writeFile(path.join(root, "src", "b.js"), "export const b = 2;\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("remote", "add", "origin", "git@github.com:test-org/zip-preview.git");

    const clean = preview();
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.preview.blocked, false);
    assert.equal(clean.preview.actualAttachmentCount, 1);
    assert.equal(clean.preview.repositoryArchive.files, 2);
    assert.deepEqual(clean.preview.promptSizeRisk.splitPlan, []);
    assert.deepEqual(clean.preview.unscannedAttachments, []);

    await writeFile(path.join(root, "src", "config.js"), 'export const api_key = "' + "abcdefghijklmnop" + '";\n');
    git("add", ".");
    git("commit", "-qm", "config");
    const risky = preview();
    assert.equal(risky.status, 2, risky.stderr);
    assert.equal(risky.preview.blocked, true);
    assert.ok(risky.preview.blockReasons.includes("SENSITIVE_CONTENT_DETECTED"));
    assert.ok(risky.preview.sensitiveFindings.some((finding) =>
      finding.source === "src/config.js" && finding.kind === "secret_assignment"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
