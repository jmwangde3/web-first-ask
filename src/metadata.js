import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readBatchMetadata(outputDir, jobId) {
  const base = path.join(outputDir, jobId);
  let metadata = null;
  let responsePath = path.join(base, "response.md");
  let responseExists = false;

  try {
    metadata = JSON.parse(await readFile(path.join(base, "metadata.json"), "utf8"));
  } catch {
    metadata = null;
  }
  try {
    const body = await readFile(responsePath, "utf8");
    responseExists = body.trim().length > 0;
  } catch {
    responseExists = false;
  }

  if (!metadata) {
    return { state: "interrupted_unknown", threadUrl: null, error: "ask-bridge did not leave readable metadata.", responsePath: null };
  }

  const state = String(metadata.state ?? "unknown").toLowerCase();
  if (state === "completed" && !responseExists) {
    return {
      state: "failed",
      threadUrl: metadata.threadUrl ?? null,
      error: "ask-bridge marked the job completed but response.md is missing or empty.",
      responsePath: null,
    };
  }
  if (state === "in_progress") {
    return {
      state: "interrupted_unknown",
      threadUrl: metadata.threadUrl ?? null,
      error: "The batch process ended while metadata still showed in_progress. The prompt may already have been submitted; do not resend.",
      responsePath: null,
    };
  }
  const allowed = new Set(["completed", "failed", "timed_out", "recoverable", "cancelled"]);
  return {
    state: allowed.has(state) ? state : "interrupted_unknown",
    threadUrl: metadata.threadUrl ?? null,
    error: metadata.error ?? (allowed.has(state) ? null : `Unknown ask-bridge state: ${state}`),
    responsePath: state === "completed" && responseExists ? responsePath : null,
    elapsedSeconds: metadata.elapsedSeconds ?? null,
    pageId: metadata.pageId ?? null,
  };
}
