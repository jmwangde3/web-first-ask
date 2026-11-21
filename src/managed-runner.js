import { readFile } from "node:fs/promises";
import path from "node:path";
import { executeTask as executeLegacyTask, refreshTask as refreshLegacyTask } from "./runner.js";
import { runProcess } from "./ask-bridge.js";
import { PolicyStore } from "./policy-store.js";
import { WfaError } from "./errors.js";
import { bundleRepository, repositoryBlock, resolveRepository } from "./repository.js";
import { createStallWatch } from "./stall-watch.js";

function positiveInteger(value, label, allowZero = false) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new WfaError("ARGUMENT_ERROR", `${label} must be ${allowZero ? "a nonnegative" : "a positive"} integer.`);
  }
  return number;
}

async function guardedBatch(run, command, args, options, store, timeoutSeconds) {
  if (!timeoutSeconds || !args.includes("batch")) return run(command, args, options);
  const inputFile = args[args.indexOf("--input") + 1];
  const outputDir = args[args.indexOf("--output-dir") + 1];
  const jobs = (await readFile(inputFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const taskId = path.basename(path.dirname(inputFile));
  const watch = createStallWatch(jobs, outputDir, timeoutSeconds);
  let pid = null;
  let settled = false;
  let timer;
  let settleAfterKill;
  let stopFallback;
  const afterKill = new Promise((resolve) => { settleAfterKill = resolve; });
  const tick = async () => {
    if (settled) return;
    const evidence = await watch.check();
    if (!evidence || settled) return;
    settled = true;
    store.stalls.set(taskId, { ...(store.stalls.get(taskId) ?? {}), ...evidence });
    if (pid && pid !== process.pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      const escalation = setTimeout(() => {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }, 5000);
      escalation.unref?.();
    }
    stopFallback = setTimeout(() => settleAfterKill({
      code: null, signal: "SIGTERM", stdout: "", stderr: "", spawnError: null,
      childMayRun: Boolean(pid), pid, stalled: evidence,
    }), 6000);
  };
  const wrapped = {
    ...options,
    onSpawn: async (value) => { pid = value; await options.onSpawn?.(value); },
    onStdoutLine: (line) => { watch.progress(line); options.onStdoutLine?.(line); },
    onStderrLine: (line) => { watch.progress(line); options.onStderrLine?.(line); },
  };
  timer = setInterval(() => { void tick(); }, 1000);
  try {
    const result = await Promise.race([run(command, args, wrapped), afterKill]);
    return result;
  } finally {
    settled = true;
    clearInterval(timer);
    clearTimeout(stopFallback);
  }
}

export async function executeTask(input, dependencies = {}) {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const repository = input.repository ?? await resolveRepository({
    cwd: workspaceRoot, repoUrl: input.repoUrl, noRepo: input.noRepo,
  });
  if (input.kind === "code" && !input.files?.length && !repository.available && !input.bundleRepo) {
    throw new WfaError("ARGUMENT_ERROR", `wfa code requires --file/--dir or a repository reference (${repository.reason}).`);
  }
  if (input.bundleRepo && input.noRepo) {
    throw new WfaError("ARGUMENT_ERROR", "--bundle-repo cannot be combined with --no-repo.");
  }
  if (input.followupTaskId && input.fresh) {
    throw new WfaError("FOLLOWUP_FRESH_CONFLICT", "--followup cannot be combined with --new-session/--fresh.");
  }
  if (input.continueSession && input.fresh) {
    throw new WfaError("ARGUMENT_ERROR", "--continue-session cannot be combined with --new-session/--fresh.");
  }
  const stallTimeoutSeconds = positiveInteger(input.stallTimeoutSeconds ?? 300, "--stall-timeout", true);
  const sessionPolicy = input.followupTaskId || input.continueSession ? "continue" : "fresh";
  const bundle = input.bundleRepo ? await bundleRepository({
    cwd: workspaceRoot, excludes: input.repoExcludes ?? [], includes: input.files ?? [],
  }) : null;
  if (bundle && !bundle.stats.files) {
    throw new WfaError("BUNDLE_REPO_EMPTY", "--bundle-repo found no eligible tracked UTF-8 files. Use --file <path> or adjust --exclude.");
  }
  let prompt = input.prompt;
  if (repository.available) prompt = `${repositoryBlock(repository)}\n\n${prompt}`;
  if (bundle) prompt += `\n\nREPOSITORY SOURCE BUNDLE (${bundle.stats.files} tracked files, ${bundle.stats.bytes} UTF-8 bytes; ${bundle.stats.skipped} skipped)\n${bundle.content}\nEND SOURCE BUNDLE`;
  const store = dependencies.store instanceof PolicyStore ? dependencies.store : new PolicyStore(dependencies.home);
  store.intent = { sessionPolicy, followupTaskId: input.followupTaskId ?? null, stallTimeoutSeconds, repository };
  store.allowUnreadableFollowup = null;
  if (input.followupTaskId) {
    const snapshot = await store.snapshot();
    const parent = snapshot.tasks.tasks[input.followupTaskId];
    const provider = input.providers?.length === 1 ? input.providers[0] : input.provider;
    if (provider && parent?.children?.[provider]?.repoUnreadable) {
      store.allowUnreadableFollowup = { taskId: input.followupTaskId, provider };
    }
  }
  try {
    const result = await executeLegacyTask({
      ...input, prompt, workspaceRoot,
      fresh: sessionPolicy === "fresh",
      noBrief: Boolean(input.noBrief || (repository.available && !input.briefFile)),
      files: bundle ? [] : input.files,
      bundleLines: bundle ? false : input.bundleLines,
    }, {
      ...dependencies, store,
      runProcess: (...args) => guardedBatch(dependencies.runProcess ?? runProcess, ...args, store, stallTimeoutSeconds),
    });
    if (result.dryRun) {
      result.preview.repository = repository;
      result.preview.bundleRepo = bundle?.stats ?? null;
      result.preview.sessionPolicy = sessionPolicy;
      result.preview.stallTimeoutSeconds = stallTimeoutSeconds;
    }
    return result;
  } catch (error) {
    if (bundle && error.code === "PROMPT_OVERSIZE") {
      throw new WfaError("PROMPT_OVERSIZE", `${error.message} Whole-repository inlining exceeded the safe 40 KiB prompt ceiling. Retry with --bundle-repo --exclude 'docs/**', select only required --file paths, or explicitly pass --allow-oversize.`);
    }
    throw error;
  } finally {
    store.intent = null;
    store.allowUnreadableFollowup = null;
  }
}

export { refreshLegacyTask as refreshTask };
