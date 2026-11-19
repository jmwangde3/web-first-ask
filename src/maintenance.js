import { resolveAskBridge, runProcess } from "./ask-bridge.js";
import { WfaError } from "./errors.js";
import { isBlockingChild } from "./state.js";
import { isPidAlive, uuid } from "./util.js";

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

export function assertUpstreamAvailable(ledger) {
  const update = ledger.upstreamUpdate;
  if (update && [update.ownerPid, update.commandPid, update.helperPid].some(isPidAlive)) {
    throw new WfaError("UPSTREAM_UPDATE_ACTIVE", "ask-bridge is being updated. Wait for the updater before starting another request.");
  }
  if (update) delete ledger.upstreamUpdate;
}

export async function updateAskBridge(config, store, run = runProcess) {
  const updateId = uuid();
  await store.transaction(({ tasks }) => {
    assertUpstreamAvailable(tasks);
    for (const task of Object.values(tasks.tasks)) {
      const unresolved = Object.entries(task.children ?? {}).find(([, child]) =>
        isBlockingChild(child) || isPidAlive(child.childPid)
      );
      if (unresolved) {
        throw new WfaError("UPSTREAM_UPDATE_BLOCKED", `Cannot update ask-bridge while task ${task.taskId} has unresolved ${unresolved[0]} state ${unresolved[1].state}. Collect or explicitly resolve the task first.`);
      }
    }
    tasks.upstreamUpdate = { id: updateId, ownerPid: process.pid };
  });

  const recordPid = (field, pid) => store.transaction(({ tasks }) => {
    if (tasks.upstreamUpdate?.id === updateId) tasks.upstreamUpdate[field] = pid;
  });
  let helperPid;
  let helperRecord;
  try {
    const result = await run(resolveAskBridge(config), ["update"], {
      timeoutMs: UPDATE_TIMEOUT_MS,
      // The Windows helper inherits both pipes and waits for the command
      // process to exit before replacing the binary.
      drainGraceMs: UPDATE_TIMEOUT_MS,
      onSpawn: (pid) => recordPid("commandPid", pid),
      onStdout: (stdout) => {
        if (helperPid) return;
        const match = stdout.match(/^Progress: updater started with PID (\d+)\./m);
        if (!match) return;
        helperPid = Number(match[1]);
        helperRecord = recordPid("helperPid", helperPid).then(() => null, (error) => error);
      },
    });
    const recordError = await helperRecord;
    if (recordError) throw recordError;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.timedOut || result.stdioDrainTimedOut) {
      throw new WfaError("UPSTREAM_UPDATE_FAILED", "ask-bridge update exceeded the wait limit. Wait for any background installer to finish, then run wfa doctor.");
    }
    if (result.spawnError || result.processError || result.code !== 0) {
      const detail = result.spawnError?.message ?? result.processError?.message ?? `ask-bridge update exited with ${result.code}.`;
      throw new WfaError("UPSTREAM_UPDATE_FAILED", detail);
    }
    if (helperPid && !result.stdout?.includes("ask-bridge-update: update command completed.")) {
      throw new WfaError("UPSTREAM_UPDATE_FAILED", "The Windows background installer did not report completion. Check its output and run wfa doctor after it exits.");
    }
  } finally {
    await store.transaction(({ tasks }) => {
      const update = tasks.upstreamUpdate;
      if (update?.id !== updateId) return;
      if ([update.commandPid, update.helperPid, helperPid].some(isPidAlive)) {
        update.ownerPid = null;
        if (helperPid) update.helperPid = helperPid;
      } else {
        delete tasks.upstreamUpdate;
      }
    });
  }
}
