// D5 offline summariser: pause distribution over pause-event JSONL logs.
//
// Usage (Windows, PowerShell):
//   node scripts/summarize-pauses.mjs <run-dir>\pause-events.jsonl [<more>.jsonl ...]
// Reads one or more log files written by `appendPauseEvents`
// (src/stall-measurement.js), prints counts plus pause-duration p50/p90/max.
// Multiple files are concatenated, so pass every run's log to get the
// distribution across background runs. Exits 1 when no events are found.
// No browser, no login, no network — pure offline log analysis.
import { readFile } from "node:fs/promises";
import { summarizePauses, formatPauseSummary } from "../src/stall-measurement.js";

const files = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (!files.length) {
  process.stderr.write("usage: node scripts/summarize-pauses.mjs <pause-events.jsonl> [...]\n");
  process.exitCode = 1;
} else {
  const events = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      process.stderr.write(`wfa: cannot read ${file}: ${err.message}\n`);
      process.exitCode = 1;
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        process.stderr.write(`wfa: skipping malformed line in ${file}: ${line.slice(0, 120)}\n`);
      }
    }
  }
  if (!events.length) {
    process.stderr.write("wfa: no pause events found in the given file(s)\n");
    process.exitCode = 1;
  } else {
    const summary = summarizePauses(events);
    process.stdout.write(`files: ${files.join(", ")}\nevents: ${events.length}\n${formatPauseSummary(summary)}\n`);
    if (summary.maxMs !== null && summary.maxMs > 420000) {
      process.stdout.write("verdict: a completed pause exceeded the 420 s stall default — revisit it (see D5 decision in src/stall-measurement.js)\n");
    } else if (summary.openPauses > 0) {
      process.stdout.write("verdict: open (censored) pauses present — durations unknown, more runs needed\n");
    } else {
      process.stdout.write("verdict: no completed pause exceeded the 420 s stall default in this data\n");
    }
  }
}
