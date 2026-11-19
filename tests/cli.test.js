import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.js";

const deprecatedCases = [
  ["--reasoning", ["ask", "--reasoning", "high", "--prompt", "test"]],
  ["--reasoning-map", ["compare", "--reasoning-map", "chatgpt=high", "--prompt", "test"]],
  ["--reasoning=value", ["ask", "--reasoning=high", "--prompt", "test"]],
];

for (const [label, args] of deprecatedCases) {
  test(`rejects disabled reasoning option ${label}`, async () => {
    await assert.rejects(
      () => main(args),
      (error) => error?.code === "REASONING_DISABLED",
    );
  });
}