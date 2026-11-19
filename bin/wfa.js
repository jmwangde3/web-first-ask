#!/usr/bin/env node
import { main } from "../src/cli.js";

try {
  process.exitCode = await main() ?? 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`wfa: ${message}\n`);
  process.exitCode = 1;
}
