#!/usr/bin/env node
import { main } from "../src/cli.js";
import { WfaError } from "../src/errors.js";

try {
  process.exitCode = await main() ?? 0;
} catch (error) {
  if (error instanceof WfaError) {
    process.stderr.write(`wfa: ${error.code}: ${error.message}\n`);
    if (error.hint) process.stderr.write(`hint: ${error.hint}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`wfa: ${message}\n`);
    process.stderr.write("hint: this looks like an internal wfa failure; re-run with WFA_DEBUG=1 and report it with the stack\n");
  }
  if (process.env.WFA_DEBUG === "1" && error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  }
  process.exitCode = 1;
}
