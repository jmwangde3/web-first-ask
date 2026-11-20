import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderError, stderrForJob } from "../src/provider-errors.js";

test("classifies a 429 with an explicit retry delay and keeps retry manual", () => {
  const result = classifyProviderError({ error: "HTTP 429: retry in 120 seconds", state: "failed" });
  assert.equal(result.errorCode, "RATE_LIMITED");
  assert.equal(result.retryAfterSeconds, 120);
  assert.equal(result.retryAfterEstimated, false);
  assert.match(result.recoveryHint, /will not automatically resend/i);
});

test("parses Retry-After header units and clamps extreme values", () => {
  const minutes = classifyProviderError({ error: "HTTP 429; retry in 3 minutes" });
  assert.equal(minutes.retryAfterSeconds, 180);
  const header = classifyProviderError({ error: "Retry-After: 999999" });
  assert.equal(header.retryAfterSeconds, 86400);
  assert.equal(header.retryAfterEstimated, false);
});

test("classifies a known ask-bridge login preflight message", () => {
  const result = classifyProviderError({ error: "not logged in to chatgpt; run ask-bridge --backend browser login" });
  assert.equal(result.errorCode, "LOGIN_REQUIRED");
  assert.match(result.recoveryHint, /wfa login --provider/);
});

test("does not downgrade a completed non-empty response based on stale error text", () => {
  const result = classifyProviderError({
    error: "HTTP 429 rate limit",
    stderr: "429",
    jobId: "job-1",
    state: "completed",
    hasResponse: true,
  });
  assert.equal(result.errorCode, null);
});

test("stderr classification is scoped to the matching job ID", () => {
  const stderr = "job-a: HTTP 429 too many requests\njob-b: navigation timeout";
  assert.equal(stderrForJob(stderr, "job-b"), "job-b: navigation timeout");
  assert.equal(classifyProviderError({ stderr, jobId: "job-b" }).errorCode, "PROVIDER_ERROR");
  assert.equal(classifyProviderError({ stderr, jobId: "job-a" }).errorCode, "RATE_LIMITED");
});

test("Cloudflare challenge is separated from login and rate-limit states", () => {
  assert.equal(classifyProviderError({ error: "Cloudflare Turnstile verification required" }).errorCode, "CLOUDFLARE_BLOCKED");
});
