// D9 — Gemini conversation-reuse test harness (backlog item D9, unverified).
//
// MANUAL-RUN TOOL ONLY. It performs exactly two `wfa cdp ask` calls against
// Gemini with the same local `--conversation-id` key, using the two prompts
// the operator supplies explicitly on the command line, then compares the
// two runs (conversation URL, userTurns, title) and prints a PASS/FAIL
// verdict. It never invents a prompt, never resends anything, and stops
// after the first ask if that ask fails.
//
// Usage (Windows, PowerShell, logged-in Chrome required):
//   node scripts/gemini-conversation-reuse.mjs --key d9-test-1 `
//     --prompt1 "Reply with exactly: FIRST-OK" `
//     --prompt2 "Reply with exactly: SECOND-OK, and quote the previous reply's marker word"
//   # optional: --mode background (default) | visible, --home <wfa-home>, --out <report.json>
//
// What it does, step by step:
//   1. ask #1 with --conversation-id <key> (opens a NEW Gemini conversation,
//      stores its URL under the key in the conversation store);
//   2. `wfa cdp read --task-id <id1> --json` for conversationUrl + userTurns;
//   3. ask #2 with the SAME key (should REUSE the stored URL);
//   4. read #2 the same way;
//   5. loads the conversation-store entry for the key and prints the report.
// Full procedure, observations and pass/fail criteria live in
// docs/gemini-conversation-reuse-test.md. This script is the scripted form
// of that procedure — not a substitute for reading it.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getHomeDir } from "../src/paths.js";
import { loadSession, getConversationSessionPath } from "../src/browser/conversation-store.js";

const WFA_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/wfa.js");

// Pure comparison: no browser, no I/O — unit-tested in
// tests/stall-measurement-d5-d6-d9.test.js.
export function compareReuseRuns(first, second) {
  const firstUrl = typeof first?.conversationUrl === "string" ? first.conversationUrl : "";
  const secondUrl = typeof second?.conversationUrl === "string" ? second.conversationUrl : "";
  const firstTurns = Number(first?.userTurns) || 0;
  const secondTurns = Number(second?.userTurns) || 0;
  const firstTitle = typeof first?.title === "string" ? first.title : "";
  const secondTitle = typeof second?.title === "string" ? second.title : "";
  const sameUrl = Boolean(firstUrl) && firstUrl === secondUrl;
  const userTurnsGrew = secondTurns === firstTurns + 1;
  const secondCompleted = second?.status === "completed";
  // Gemini names a conversation after the first answer; an empty title on
  // either side is "unknown", not a failure — only a real mismatch counts.
  const titleSame = firstTitle && secondTitle ? firstTitle === secondTitle : null;
  const pass = sameUrl && userTurnsGrew && secondCompleted;
  return {
    pass,
    verdict: pass ? "PASS" : "FAIL",
    checks: { sameUrl, userTurnsGrew, secondCompleted, titleSame },
    details: {
      firstUrl, secondUrl, firstTurns, secondTurns, firstTitle, secondTitle,
      firstStatus: first?.status ?? null, secondStatus: second?.status ?? null,
    },
  };
}

export function buildReuseReport({ key, first, second, comparison, storeEntry, storePath }) {
  return [
    "Gemini conversation-reuse test (D9)",
    `key: ${key}`,
    `ask #1: task=${first?.taskId ?? "?"} status=${first?.status ?? "?"} userTurns=${comparison.details.firstTurns} url=${comparison.details.firstUrl || "(none)"}`,
    `ask #2: task=${second?.taskId ?? "?"} status=${second?.status ?? "?"} userTurns=${comparison.details.secondTurns} url=${comparison.details.secondUrl || "(none)"}`,
    `title #1: ${JSON.stringify(comparison.details.firstTitle)}  title #2: ${JSON.stringify(comparison.details.secondTitle)}`,
    `store entry: ${storePath}`,
    `  stored url: ${storeEntry?.conversationUrl ?? "(none)"}  turnCount: ${storeEntry?.turnCount ?? "(none)"}`,
    `checks: sameUrl=${comparison.checks.sameUrl} userTurnsGrew=${comparison.checks.userTurnsGrew} secondCompleted=${comparison.checks.secondCompleted} titleSame=${comparison.checks.titleSame}`,
    `verdict: ${comparison.verdict}${comparison.pass ? " — same key reused the conversation" : " — reuse FAILED, see docs/gemini-conversation-reuse-test.md 'If it fails'"}`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = { mode: "background", wfa: WFA_BIN, home: getHomeDir() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === "--key") options.key = next();
    else if (arg === "--prompt1") options.prompt1 = next();
    else if (arg === "--prompt2") options.prompt2 = next();
    else if (arg === "--mode") options.mode = next();
    else if (arg === "--home") options.home = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--wfa") options.wfa = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runWfa(wfaBin, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [wfaBin, ...args], {
      timeout: 900000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0 && !stdout) {
        reject(new Error(`wfa ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), code: err?.code ?? 0 });
    });
  });
}

function parseJsonOutput(stdout, label) {
  const text = String(stdout).trim();
  try {
    return JSON.parse(text);
  } catch {
    // --json output is a single object; tolerate surrounding log lines.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error(`${label}: could not parse JSON output: ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(start, end + 1));
  }
}

async function runAskAndRead({ wfa, home, key, prompt, mode }) {
  const ask = await runWfa(wfa, [
    "cdp", "ask", "--provider", "gemini",
    "--conversation-id", key, "--prompt", prompt,
    "--mode", mode, "--json",
  ]);
  const asked = parseJsonOutput(ask.stdout, "ask");
  if (!asked.id) throw new Error(`ask returned no task id: ${ask.stdout.slice(0, 200)}`);
  const read = await runWfa(wfa, [
    "cdp", "read", "--task-id", asked.id, "--provider", "gemini", "--json",
  ]);
  const readBack = parseJsonOutput(read.stdout, "read");
  return {
    taskId: asked.id,
    status: asked.status ?? readBack.status ?? null,
    conversationUrl: readBack.conversationUrl ?? asked.conversationUrl ?? "",
    userTurns: readBack.evidence?.userTurns ?? null,
    title: readBack.evidence?.title ?? "",
    ask,
    readBack,
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(
      "usage: node scripts/gemini-conversation-reuse.mjs --key <id> --prompt1 <text> --prompt2 <text> [--mode background|visible] [--home <dir>] [--out <report.json>]\n"
      + "Runs exactly two Gemini asks with the same --conversation-id key and compares them (D9).\n"
      + "See docs/gemini-conversation-reuse-test.md for the full procedure.\n",
    );
    return 0;
  }
  if (!options.key || !options.prompt1 || !options.prompt2) {
    throw new Error("Refusing to run: --key, --prompt1 and --prompt2 are all required (no default prompts — the operator must supply both asks explicitly).");
  }
  if (!["background", "visible", "headless"].includes(options.mode)) {
    throw new Error(`Invalid --mode: ${options.mode}`);
  }

  process.stdout.write(`D9: ask #1 with key ${JSON.stringify(options.key)} …\n`);
  const first = await runAskAndRead({ ...options, prompt: options.prompt1 });
  process.stdout.write(`D9: ask #1 done: task=${first.taskId} status=${first.status} userTurns=${first.userTurns}\n`);
  if (first.status !== "completed") {
    throw new Error(`Ask #1 did not complete (status=${first.status}); stopping — ask #2 NOT run. Inspect with: wfa cdp read --task-id ${first.taskId} --provider gemini --json`);
  }

  process.stdout.write(`D9: ask #2 with the same key ${JSON.stringify(options.key)} …\n`);
  const second = await runAskAndRead({ ...options, prompt: options.prompt2 });
  process.stdout.write(`D9: ask #2 done: task=${second.taskId} status=${second.status} userTurns=${second.userTurns}\n`);

  const storePath = getConversationSessionPath(options.home, "gemini", options.key);
  const storeEntry = await loadSession(options.home, "gemini", options.key);
  const comparison = compareReuseRuns(first, second);
  const reportText = buildReuseReport({ key: options.key, first, second, comparison, storeEntry, storePath });
  const report = {
    item: "D9",
    key: options.key,
    mode: options.mode,
    ranAt: new Date().toISOString(),
    first: { taskId: first.taskId, status: first.status, conversationUrl: first.conversationUrl, userTurns: first.userTurns, title: first.title },
    second: { taskId: second.taskId, status: second.status, conversationUrl: second.conversationUrl, userTurns: second.userTurns, title: second.title },
    storeEntry,
    storePath,
    comparison,
  };
  const outPath = options.out ?? path.join(process.cwd(), `gemini-reuse-test-${options.key}-${Date.now()}.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${reportText}\nreport written to: ${outPath}\n`);
  return comparison.pass ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`wfa: ${err.message}\n`);
    process.exitCode = 2;
  }
}
