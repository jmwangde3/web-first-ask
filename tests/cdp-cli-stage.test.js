import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCdpCommand } from "../src/engines/cdp-cli.js";

function createMockStream() {
  let content = "";
  return {
    write: (chunk) => {
      content += chunk;
      return true;
    },
    get output() {
      return content;
    },
    clear: () => {
      content = "";
    },
  };
}

function mockBrokerDeps(turnResult) {
  const record = { instanceId: "mock-inst", pid: 5000, port: 9444, host: "127.0.0.1", token: "tok" };
  const created = { status: 202, json: { id: "mock-turn-stage" } };
  return {
    ensureBroker: async () => record,
    createTurn: async () => created,
    waitForTurn: async () => turnResult,
  };
}

test("runCdpCommand ask: json output replaces text with staged receipt and summary when staged", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-stage-"));
  const stdout = createMockStream();
  const stderr = createMockStream();
  const fileText = `FILE: app.js\n\`\`\`js\nconsole.log("ok");\n\`\`\`\n`;
  const brokerDeps = mockBrokerDeps({
    id: "mock-turn-stage",
    provider: "chatgpt",
    state: "completed",
    text: fileText,
  });

  try {
    const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "test", "--json"], {
      stdout,
      stderr,
      home,
      ...brokerDeps,
    });
    assert.equal(res.code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.text, undefined, "text should be omitted from json output when staged");
    assert.ok(parsed.staged, "staged object should be present");
    assert.equal(parsed.staged.files.length, 1);
    assert.ok(parsed.summary.includes("FILE: app.js"));
    assert.ok(parsed.textBytes > 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runCdpCommand ask: plain output displays stage receipts instead of code body", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-stage-"));
  const stdout = createMockStream();
  const stderr = createMockStream();
  const fileText = `FILE: app.js\n\`\`\`js\nconsole.log("ok");\n\`\`\`\n`;
  const brokerDeps = mockBrokerDeps({
    id: "mock-turn-stage",
    provider: "gemini",
    state: "completed",
    text: fileText,
  });

  try {
    const res = await runCdpCommand(["ask", "--provider", "gemini", "--prompt", "test"], {
      stdout,
      stderr,
      home,
      ...brokerDeps,
    });
    assert.equal(res.code, 0);
    assert.ok(stdout.output.includes("stageRoot:"));
    assert.ok(stdout.output.includes("manifestPath:"));
    assert.ok(stdout.output.includes("app.js"));
    assert.ok(!stdout.output.includes('console.log("ok");'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runCdpCommand ask: retains full text when --no-stage is passed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-stage-"));
  const stdout = createMockStream();
  const stderr = createMockStream();
  const fileText = `FILE: app.js\n\`\`\`js\nconsole.log("ok");\n\`\`\`\n`;
  const brokerDeps = mockBrokerDeps({
    id: "mock-turn-stage",
    provider: "chatgpt",
    state: "completed",
    text: fileText,
  });

  try {
    const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "test", "--no-stage", "--json"], {
      stdout,
      stderr,
      home,
      ...brokerDeps,
    });
    assert.equal(res.code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.staged, undefined);
    assert.equal(parsed.text, fileText);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runCdpCommand ask: retains full text when answer has no FILE blocks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-stage-"));
  const stdout = createMockStream();
  const stderr = createMockStream();
  const brokerDeps = mockBrokerDeps({
    id: "mock-turn-stage",
    provider: "chatgpt",
    state: "completed",
    text: "Plain conversation answer.",
  });

  try {
    const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "test", "--json"], {
      stdout,
      stderr,
      home,
      ...brokerDeps,
    });
    assert.equal(res.code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.staged, undefined);
    assert.equal(parsed.text, "Plain conversation answer.");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runCdpCommand ask: staging failure falls back to full text with a warning", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-cli-stage-fail-"));
  const stdout = createMockStream();
  const stderr = createMockStream();
  const fileText = `FILE: app.js\n\`\`\`js\nconsole.log("ok");\n\`\`\`\n`;
  const brokerDeps = mockBrokerDeps({
    id: "mock-turn-stage-fail",
    provider: "chatgpt",
    state: "completed",
    text: fileText,
  });

  try {
    const res = await runCdpCommand(["ask", "--provider", "chatgpt", "--prompt", "test", "--json"], {
      stdout,
      stderr,
      home,
      ...brokerDeps,
      stageCdpResponse: async () => {
        const error = new Error("FILE block is not followed by a complete fenced body.");
        error.code = "INCOMPLETE_FILE_BLOCK";
        throw error;
      },
    });
    assert.equal(res.code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.text, fileText, "staging failure must not lose the answer");
    assert.equal(parsed.staged, undefined);
    assert.match(stderr.output, /stage skipped: INCOMPLETE_FILE_BLOCK/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
