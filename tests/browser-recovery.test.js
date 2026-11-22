import test from "node:test";
import assert from "node:assert/strict";
import { decideBrowserRecovery, recoverBrowser } from "../src/browser/recovery.js";
import { getWfaVersion } from "../src/browser/paths.js";

const profileDir = "/tmp/wfa-fake/chrome-profile";
const started = "2026-11-23T00:00:00.000Z";
const processInfo = {
  pid: 4001, creationDate: started, executablePath: "/opt/chrome/chrome",
  commandLine: `chrome --user-data-dir="${profileDir}" --remote-debugging-port=0`,
};
const ready = {
  schema: 1, phase: "ready", brokerPid: 3000, brokerInstanceId: "old-broker",
  brokerStartedAt: started, chromeLaunchId: "old-launch", chromePid: 4001,
  chromeStartedAt: started, chromePath: processInfo.executablePath,
  userDataDir: profileDir, requestedDebugPort: 0, actualDebugPort: 39123,
  wfaVersion: "0.3.0",
};
const launching = { ...ready, phase: "launching", chromePid: null,
  chromeStartedAt: null, actualDebugPort: null };
const active = { port: 39123, wsPath: "/devtools/browser/abc" };

function makeProbes(overrides = {}) {
  return {
    isPidAlive: () => true,
    queryProcess: () => processInfo,
    findProfileOwner: () => null,
    probeProfileLock: () => "free",
    readDevToolsActivePort: () => active,
    cdpProbe: () => ({ ok: true, browser: "Chrome/158", webSocketDebuggerUrl: "ws://127.0.0.1:39123/devtools/browser/abc" }),
    getListeningPid: () => 4001,
    ...overrides,
  };
}

const cases = [
  ["corrupt lock", { status: "corrupt", lock: null }, {}, true, "RECOVERY_REQUIRED", "lock_corrupt"],
  ["no lock and free", { status: "missing", lock: null }, {}, false, "SAFE_START", "no_lock_profile_free"],
  ["no lock and held", { status: "missing", lock: null }, { probeProfileLock: () => "held" }, false, "RECOVERY_REQUIRED", "no_lock_profile_held"],
  ["launching abandoned", { status: "ok", lock: launching }, {}, true, "SAFE_START", "launch_abandoned_profile_free"],
  ["launching verified", { status: "ok", lock: launching }, { findProfileOwner: () => processInfo }, true, "ADOPT", "launch_phase_verified"],
  ["launching owner too old", { status: "ok", lock: launching }, { findProfileOwner: () => ({ ...processInfo, creationDate: "2026-11-22T23:59:55.000Z" }) }, true, "RECOVERY_REQUIRED", "launch_phase_unverified"],
  ["launching held without owner", { status: "ok", lock: launching }, { probeProfileLock: () => "held" }, false, "RECOVERY_REQUIRED", "launch_phase_unverified"],
  ["ready pid dead and free", { status: "ok", lock: ready }, { isPidAlive: () => false }, true, "SAFE_START", "lock_pid_dead_profile_free"],
  ["ready pid dead and held", { status: "ok", lock: ready }, { isPidAlive: () => false, probeProfileLock: () => "held" }, true, "RECOVERY_REQUIRED", "lock_pid_dead_profile_held"],
  ["process query failed", { status: "ok", lock: ready }, { queryProcess: () => null }, true, "RECOVERY_REQUIRED", "process_query_failed"],
  ["identity changed and free", { status: "ok", lock: ready }, { queryProcess: () => ({ ...processInfo, creationDate: "2026-11-22T23:59:45.000Z" }) }, true, "SAFE_START", "identity_mismatch_profile_free"],
  ["identity changed and held", { status: "ok", lock: ready }, { queryProcess: () => ({ ...processInfo, commandLine: "chrome --user-data-dir=/another-profile" }), probeProfileLock: () => "held" }, false, "RECOVERY_REQUIRED", "identity_mismatch_profile_held"],
  ["cdp unreachable has work", { status: "ok", lock: ready }, { readDevToolsActivePort: () => null }, true, "RECOVERY_REQUIRED", "cdp_unreachable_has_work"],
  ["cdp unreachable no work", { status: "ok", lock: ready }, { readDevToolsActivePort: () => null }, false, "SAFE_START", "cdp_unreachable_no_work"],
  ["port owner differs", { status: "ok", lock: ready }, { getListeningPid: () => 9999 }, false, "RECOVERY_REQUIRED", "port_owner_mismatch"],
  ["verified ready", { status: "ok", lock: ready }, {}, true, "ADOPT", "verified"],
  ["lock missing phase is corrupt", { status: "ok", lock: (({ phase, ...withoutPhase }) => withoutPhase)(ready) }, {}, true, "RECOVERY_REQUIRED", "lock_corrupt"],
  ["unknown profile lock and no owner", { status: "missing", lock: null }, { probeProfileLock: () => "unknown" }, false, "SAFE_START", "no_lock_profile_free"],
  ["ambiguous launching owner uses earliest", { status: "ok", lock: launching }, { findProfileOwner: () => ({ ...processInfo, ambiguous: true }) }, false, "ADOPT", "launch_phase_verified"],
];

for (const [name, lock, overrides, work, action, reason] of cases) {
  test(name, async () => {
    const decision = await decideBrowserRecovery({ lock, profileDir, hasUncollectedWork: work,
      probes: makeProbes(overrides) });
    assert.equal(decision.action, action);
    assert.equal(decision.reason, reason);
    assert.equal(decision.killPid, reason === "cdp_unreachable_no_work" ? ready.chromePid : null);
    assert.equal(decision.evidence.lockStatus, lock.status);
  });
}

test("missing work flag fails closed and records assumption", async () => {
  const decision = await decideBrowserRecovery({ lock: { status: "ok", lock: ready }, profileDir,
    probes: makeProbes({ readDevToolsActivePort: () => null }) });
  assert.equal(decision.reason, "cdp_unreachable_has_work");
  assert.equal(decision.evidence.hasUncollectedWork, true);
  assert.equal(decision.evidence.assumedUncollectedWork, true);
});

test("async probes are awaited in decision-table order and stop at unreachable CDP", async () => {
  const seen = [];
  const ordered = (name, value) => async () => { seen.push(name); return value; };
  const decision = await decideBrowserRecovery({ lock: { status: "ok", lock: ready }, profileDir,
    hasUncollectedWork: false, probes: makeProbes({
      isPidAlive: ordered("isPidAlive", true),
      queryProcess: ordered("queryProcess", processInfo),
      readDevToolsActivePort: ordered("readDevToolsActivePort", null),
      cdpProbe: ordered("cdpProbe", { ok: true }),
      getListeningPid: ordered("getListeningPid", 4001),
      probeProfileLock: ordered("probeProfileLock", "held"),
    }) });
  assert.equal(decision.action, "SAFE_START");
  assert.equal(decision.killPid, ready.chromePid);
  assert.deepEqual(seen, ["isPidAlive", "queryProcess", "readDevToolsActivePort"]);
});

test("corrupt and phase-less locks do not call any probe", async () => {
  const probes = new Proxy({}, { get: () => { throw new Error("unexpected probe access"); } });
  for (const lock of [{ status: "corrupt", lock: null },
    { status: "ok", lock: (({ phase, ...withoutPhase }) => withoutPhase)(ready) }]) {
    const decision = await decideBrowserRecovery({ lock, profileDir, probes });
    assert.equal(decision.reason, "lock_corrupt");
  }
});

test("missing lock never calls CDP probes", async () => {
  const calls = [];
  const decision = await decideBrowserRecovery({ lock: { status: "missing", lock: null }, profileDir,
    probes: makeProbes({
      probeProfileLock: async () => { calls.push("lock"); return "free"; },
      findProfileOwner: async () => { calls.push("owner"); return null; },
      readDevToolsActivePort: () => { throw new Error("CDP was called"); },
    }) });
  assert.equal(decision.action, "SAFE_START");
  assert.deepEqual(calls, ["lock", "owner"]);
});

test("missing, throwing and rejecting probes produce named recovery decisions", async () => {
  for (const [probes, expected, message] of [
    [{}, "probe_probeProfileLock_failed", "Missing probe: probeProfileLock"],
    [{ probeProfileLock: () => { throw new Error("sync probe error"); } }, "probe_probeProfileLock_failed", "sync probe error"],
    [{ probeProfileLock: async () => { throw new Error("async probe error"); } }, "probe_probeProfileLock_failed", "async probe error"],
    [{ probeProfileLock: async () => "free" }, "probe_findProfileOwner_failed", "Missing probe: findProfileOwner"],
  ]) {
    const decision = await decideBrowserRecovery({ lock: { status: "missing", lock: null },
      profileDir, probes });
    assert.equal(decision.action, "RECOVERY_REQUIRED");
    assert.equal(decision.reason, expected);
    assert.equal(decision.killPid, null);
    assert.equal(decision.evidence.probeError, message);
  }
});

function injectedRecovery(lock, extra = {}) {
  const writes = [];
  const events = [];
  const calls = { launches: 0, kills: 0, archives: 0, profileChecks: 0 };
  const probes = {
    ...makeProbes(), readLock: async () => lock,
    writeLockAtomic: async (_, value) => { writes.push(structuredClone(value)); events.push(`write:${value.phase}`); },
    archiveLock: async () => { calls.archives += 1; events.push("archive"); return "archive"; },
    launchChrome: async () => { calls.launches += 1; events.push("launch"); return { pid: 9009, creationDate: started,
      executablePath: processInfo.executablePath, actualDebugPort: active.port,
      wsPath: active.wsPath, userDataDir: profileDir }; },
    terminateProcessAndWait: async () => { calls.kills += 1; events.push("kill"); },
    probeProfileLock: async () => { calls.profileChecks += 1; events.push("profile"); return "free"; },
    ...extra,
  };
  return { probes, calls, writes, events };
}

test("SAFE_START writes launching before spawn then ready", async () => {
  const ctx = injectedRecovery({ status: "missing", lock: null });
  ctx.probes.launchChrome = async () => {
    assert.equal(ctx.writes.length, 1);
    assert.equal(ctx.writes[0].phase, "launching");
    assert.equal(ctx.writes[0].chromePid, null);
    assert.equal(ctx.writes[0].actualDebugPort, null);
    ctx.calls.launches += 1;
    return { pid: 9009, creationDate: started, executablePath: processInfo.executablePath,
      actualDebugPort: active.port, wsPath: active.wsPath, userDataDir: profileDir };
  };
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", probes: ctx.probes });
  assert.equal(output.action, "SAFE_START");
  assert.deepEqual(ctx.writes.map((item) => item.phase), ["launching", "ready"]);
  assert.equal(ctx.writes[1].chromePid, 9009);
  assert.equal(ctx.writes[0].wfaVersion, getWfaVersion());
  assert.equal(output.evidence.assumedUncollectedWork, true);
});

test("ADOPT launching fills pid and never starts another Chrome", async () => {
  const ctx = injectedRecovery({ status: "ok", lock: launching }, { findProfileOwner: () => processInfo });
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", hasUncollectedWork: true, probes: ctx.probes });
  assert.equal(output.action, "ADOPT");
  assert.equal(output.reason, "launch_phase_verified");
  assert.equal(ctx.calls.launches, 0);
  assert.equal(ctx.writes.length, 1);
  assert.equal(ctx.writes[0].phase, "ready");
  assert.equal(ctx.writes[0].chromePid, processInfo.pid);
  assert.equal(ctx.writes[0].chromeStartedAt, started);
});

test("SAFE_START kill requires second identity verification", async () => {
  let queries = 0;
  const ctx = injectedRecovery({ status: "ok", lock: ready }, {
    readDevToolsActivePort: () => null,
    queryProcess: () => (++queries === 1 ? processInfo : { ...processInfo, commandLine: "chrome --user-data-dir=/not-the-profile" }),
  });
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", hasUncollectedWork: false, probes: ctx.probes });
  assert.equal(output.action, "RECOVERY_REQUIRED");
  assert.equal(output.reason, "kill_reverify_failed");
  assert.equal(output.chrome, null);
  assert.equal(ctx.calls.kills, 0);
  assert.equal(ctx.calls.profileChecks, 0);
  assert.equal(ctx.calls.launches, 0);
  assert.equal(ctx.writes.length, 0);
});

test("verified kill waits for profile release before archiving and restarting", async () => {
  const ctx = injectedRecovery({ status: "ok", lock: ready }, { readDevToolsActivePort: () => null });
  let checks = 0;
  ctx.probes.probeProfileLock = async () => {
    ctx.events.push("profile");
    ctx.calls.profileChecks += 1;
    return ++checks === 1 ? "held" : "free";
  };
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", hasUncollectedWork: false, probes: ctx.probes });
  assert.equal(output.action, "SAFE_START");
  assert.equal(ctx.calls.kills, 1);
  assert.equal(ctx.calls.profileChecks, 2);
  assert.equal(ctx.calls.archives, 1);
  assert.equal(ctx.calls.launches, 1);
  assert.deepEqual(ctx.events.slice(0, 5), ["kill", "profile", "profile", "archive", "write:launching"]);
});

test("non-kill SAFE_START skips post-kill profile wait", async () => {
  const ctx = injectedRecovery({ status: "missing", lock: null });
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", hasUncollectedWork: false, probes: ctx.probes });
  assert.equal(output.action, "SAFE_START");
  assert.equal(ctx.calls.profileChecks, 1, "only the decision-time profile probe runs");
});

test("unknown profile lock after kill returns without archiving or launching", async () => {
  const ctx = injectedRecovery({ status: "ok", lock: ready }, {
    readDevToolsActivePort: () => null, probeProfileLock: async () => "unknown",
  });
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", hasUncollectedWork: false, probes: ctx.probes });
  assert.equal(output.action, "RECOVERY_REQUIRED");
  assert.equal(output.reason, "profile_lock_unknown");
  assert.equal(output.chrome, null);
  assert.deepEqual(ctx.events, ["kill"]);
});

test("held profile lock after kill times out without archiving or launching", async () => {
  const ctx = injectedRecovery({ status: "ok", lock: ready }, {
    readDevToolsActivePort: () => null, probeProfileLock: async () => "held",
  });
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", hasUncollectedWork: false, probes: ctx.probes });
  assert.equal(output.action, "RECOVERY_REQUIRED");
  assert.equal(output.reason, "profile_lock_timeout");
  assert.equal(output.chrome, null);
  assert.deepEqual(ctx.events, ["kill"]);
});

test("post-kill profile probe errors remain structured", async () => {
  const ctx = injectedRecovery({ status: "ok", lock: ready }, {
    readDevToolsActivePort: () => null,
    probeProfileLock: async () => { throw new Error("lock probe failed"); },
  });
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", hasUncollectedWork: false, probes: ctx.probes });
  assert.equal(output.reason, "probe_probeProfileLock_failed");
  assert.equal(output.evidence.probeError, "lock probe failed");
  assert.equal(output.chrome, null);
  assert.deepEqual(ctx.events, ["kill"]);
});

test("ADOPT refuses missing port without rewriting the lock", async () => {
  let reads = 0;
  const ctx = injectedRecovery({ status: "ok", lock: ready }, {
    readDevToolsActivePort: () => (++reads === 1 ? active : null),
  });
  const output = await recoverBrowser({ home: "/tmp/wfa-fake", probes: ctx.probes });
  assert.equal(output.reason, "adopt_missing_active_port");
  assert.equal(output.chrome, null);
  assert.equal(ctx.writes.length, 0);
  assert.equal(ctx.calls.launches, 0);
});

test("invalid caller mode throws INVALID_ARGUMENT", async () => {
  await assert.rejects(recoverBrowser({ mode: "invalid" }), { code: "INVALID_ARGUMENT" });
});
