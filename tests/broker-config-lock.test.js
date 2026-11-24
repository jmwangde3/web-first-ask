import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startBroker } from "../src/broker/server.js";

test("broker: invalid concurrency configuration fails before acquiring instance lock", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-broker-config-"));
  try {
    await assert.rejects(startBroker({ home, runner: { async run() {} }, maxPerProvider: 0 }), {
      code: "INVALID_ARGUMENT",
    });
    await assert.rejects(access(path.join(home, "broker.lock")), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
