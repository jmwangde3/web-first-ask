import path from "node:path";
import { executeTask as executeLegacyTask } from "./runner.js";
import { refreshTask, guardedBatch } from "./runner-stall.js";
import { runProcess } from "./ask-bridge.js";
import { PolicyStore } from "./policy-store.js";
import { WfaError } from "./errors.js";
import { bundleRepository, repositoryBlock, resolveRepository } from "./repository.js";

function positiveInteger(value, label, allowZero = false) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new WfaError("ARGUMENT_ERROR", `${label} must be ${allowZero ? "a nonnegative" : "a positive"} integer.`);
  }
  return number;
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
    cwd: workspaceRoot, excludes: input.repoExcludes ?? [], includes: input.files ?? [], prompt: input.prompt,
  }) : null;
  if (bundle && !bundle.stats.listed) {
    throw new WfaError("BUNDLE_REPO_EMPTY", "--bundle-repo found no eligible tracked files. Select paths with --file or adjust --exclude.");
  }
  let prompt = input.prompt;
  // The inline bundle and the remote-reading contract are mutually exclusive.
  // In particular do not ask a bundled follow-up to return REPO_UNREADABLE.
  if (repository.available && !bundle) prompt = `${repositoryBlock(repository)}\n\n${prompt}`;
  if (bundle) prompt += `\n\n${bundle.content}\nEND SOURCE BUNDLE`;
  const store = dependencies.store instanceof PolicyStore ? dependencies.store : new PolicyStore(dependencies.home);
  store.intent = { sessionPolicy, followupTaskId: input.followupTaskId ?? null,
    stallTimeoutSeconds, repository, bundleRepo: Boolean(bundle) };
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
      sequentialBatches: true,
    }, {
      ...dependencies, store,
      runProcess: (...args) => guardedBatch(dependencies.runProcess ?? runProcess, ...args, store, stallTimeoutSeconds),
    });
    if (result.dryRun) {
      result.preview.repository = repository;
      result.preview.repositoryWarnings = repository.warnings ?? [];
      result.preview.bundleRepo = bundle?.stats ?? null;
      result.preview.sessionPolicy = sessionPolicy;
      result.preview.stallTimeoutSeconds = stallTimeoutSeconds;
    }
    return result;
  } catch (error) {
    if (bundle && error.code === "PROMPT_OVERSIZE") {
      throw new WfaError("PROMPT_OVERSIZE", `${error.message} Narrow --bundle-repo with --file <path> and --exclude 'docs/**'; do not rely on --allow-oversize because upstream truncates prompts.`);
    }
    throw error;
  } finally {
    store.intent = null;
    store.allowUnreadableFollowup = null;
  }
}

export { refreshTask };
