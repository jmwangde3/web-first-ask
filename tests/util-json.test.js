import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "../src/util.js";
import { WfaError } from "../src/errors.js";

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "wfa-json-"));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("readJson reports a corrupted tasks ledger with recovery guidance", async () => {
  await withHome(async (home) => {
    const file = path.join(home, "tasks.json");
    await writeFile(file, '{"version":1,"tasks":', "utf8");

    await assert.rejects(
      () => readJson(file, {}),
      (error) => {
        assert.ok(error instanceof WfaError);
        assert.equal(error.code, "LEDGER_CORRUPT");
        assert.match(error.message, /tasks\.json/);
        assert.match(error.message, /ledger/i);
        assert.match(error.hint, /\.bak/);
        assert.match(error.hint, /wfa doctor/);
        assert.equal(error.details.path, file);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), '{"version":1,"tasks":');
  });
});

test("readJson preserves the missing-file fallback and native read errors", async () => {
  await withHome(async (home) => {
    const fallback = { version: 1, tasks: {} };
    const result = await readJson(path.join(home, "missing.json"), fallback);
    assert.deepEqual(result, fallback);
    assert.notStrictEqual(result, fallback);

    await assert.rejects(
      () => readJson(home, {}),
      (error) => error.code === "EISDIR" || error.code === "EPERM",
    );
  });
});

test("writeJsonAtomic saves the previous JSON before an overwrite", async () => {
  await withHome(async (home) => {
    const file = path.join(home, "tasks.json");
    const oldValue = { version: 1, tasks: { old: true } };
    const newValue = { version: 1, tasks: { current: true } };

    await writeJsonAtomic(file, oldValue);
    await assert.rejects(() => readFile(`${file}.bak`), /ENOENT/);

    await writeJsonAtomic(file, newValue);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), newValue);
    assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, "utf8")), oldValue);
  });
});

test("CLI prints LEDGER_CORRUPT and backup hint for a corrupt tasks.json", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "tasks.json"), "{not-json", "utf8");
    const bin = fileURLToPath(new URL("../bin/wfa.js", import.meta.url));
    const result = spawnSync(process.execPath, [bin, "list", "--no-refresh"], {
      env: { ...process.env, WFA_HOME: home },
      encoding: "utf8",
      timeout: 10000,
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /wfa: LEDGER_CORRUPT:/);
    assert.match(result.stderr, /tasks\.json/);
    assert.match(result.stderr, /hint:.*\.bak/);
  });
});

test("WfaError retains the existing options signature", () => {
  const details = { path: "tasks.json" };
  const error = new WfaError("EXAMPLE", "example", { details });
  assert.equal(error.code, "EXAMPLE");
  assert.deepEqual(error.details, details);
  assert.equal(error.hint, null);
});
