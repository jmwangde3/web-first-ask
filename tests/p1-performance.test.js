import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareChromeStartup, runProcess } from "../src/ask-bridge.js";
import { prependBrief, scanSensitiveText } from "../src/bundle.js";
import { executeTask } from "../src/runner.js";
import { Store } from "../src/store.js";

test("Preferences discovery is cached per root, but login invalidates the paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wfa-chrome-cache-"));
  try {
    const firstDir = path.join(root, "Default");
    await mkdir(firstDir);
    const firstFile = path.join(firstDir, "Preferences");
    await writeFile(firstFile, JSON.stringify({ profile: { exit_type: "Normal" } }), "utf8");

    const initial = await prepareChromeStartup({ root, apply: false });
    assert.equal(initial.inspectedProfiles, 1);

    // A new profile must not cause another BFS within this cache lifetime.
    const secondDir = path.join(root, "Profile 1");
    await mkdir(secondDir);
    await writeFile(path.join(secondDir, "Preferences"),
      JSON.stringify({ profile: { exit_type: "Normal" } }), "utf8");

    const cached = await prepareChromeStartup({ root, apply: false });
    assert.equal(cached.inspectedProfiles, 1);

    // Contents are not cached: the existing profile must still be repaired.
    await writeFile(firstFile, JSON.stringify({ profile: { exit_type: "Crashed" } }), "utf8");
    const repaired = await prepareChromeStartup({ root });
    assert.deepEqual(repaired.repairedProfiles, [firstFile]);
    assert.equal(JSON.parse(await readFile(firstFile, "utf8")).profile.exit_type, "Normal");

    // A login run invalidates discovery, including when Chrome created a new
    // Preferences file after the first preparation.
    const login = await runProcess(process.execPath, ["-e", "", "login"], {
      env: { ...process.env, ASK_BRIDGE_CONFIG_DIR: root },
      timeoutMs: 5000,
    });
    assert.equal(login.code, 0);
    const refreshed = await prepareChromeStartup({ root, apply: false });
    assert.equal(refreshed.inspectedProfiles, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runProcess retains recent stdout/stderr and preserves cumulative callbacks", async () => {
  const script = [
    'process.stdout.write("x".repeat(205000) + "STDOUT_TAIL");',
    'process.stderr.write("y".repeat(13000) + "STDERR_TAIL");',
  ].join("\n");

  let observedStdout = "";
  let observedStderr = "";
  const result = await runProcess(process.execPath, ["-e", script], {
    timeoutMs: 10000,
    onStdout: (text) => { observedStdout = text; },
    onStderr: (text) => { observedStderr = text; },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 200000);
  assert.equal(result.stderr.length, 12000);
  assert.ok(result.stdout.endsWith("STDOUT_TAIL"));
  assert.ok(result.stderr.endsWith("STDERR_TAIL"));
  assert.equal(observedStdout, result.stdout);
  assert.equal(observedStderr, result.stderr);
});

test("shared prompt scanning retains provider locations and Gemini-only findings", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-p1-scan-home-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wfa-p1-scan-work-"));
  try {
    const source = path.join(workspaceRoot, "sample.js");
    const briefFile = path.join(workspaceRoot, "brief.md");
    const prompt = "api_key=abcdefghijklmnop\nPlease inspect the attachment.";
    const briefText = "# Shared context";
    await writeFile(source, "password=abcdefghijklmnop\n", "utf8");
    await writeFile(briefFile, `${briefText}\n`, "utf8");

    const result = await executeTask({
      kind: "ask",
      prompt,
      providers: ["chatgpt", "gemini"],
      workspace: "p1-scan",
      workspaceRoot,
      repository: { available: false, reason: "test" },
      briefFile,
      files: [source],
      dryRun: true,
    }, {
      home,
      store: new Store(home),
      skipPreflight: true,
      config: {
        defaultTimeoutSeconds: 1200,
        maxTimeoutSeconds: 7200,
        defaultConcurrency: 1,
        maxConcurrency: 3,
        downloadImages: false,
      },
    });

    assert.equal(result.dryRun, true);
    const findings = result.preview.sensitiveFindings;
    const expectedChatgpt = scanSensitiveText(
      prependBrief(prompt, briefText), "prompt:chatgpt",
    );
    assert.deepEqual(
      findings.filter((finding) => finding.source === "prompt:chatgpt"),
      expectedChatgpt,
    );

    const geminiFindings = findings.filter((finding) => finding.source === "prompt:gemini");
    assert.ok(geminiFindings.some((finding) =>
      finding.kind === "secret_assignment" && finding.line === expectedChatgpt[0].line));
    assert.ok(geminiFindings.some((finding) =>
      finding.kind === "secret_assignment" && finding.line > expectedChatgpt[0].line));
    assert.ok(findings.some((finding) =>
      finding.source === source && finding.kind === "secret_assignment"));
    assert.equal(result.preview.sendBlocked, true);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
