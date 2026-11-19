import test from "node:test";
import assert from "node:assert/strict";
import { buildJobs, normalizeProviders, validateConcurrency } from "../src/jobs.js";

test("normalizes providers and defaults missing provider", () => {
  assert.deepEqual(normalizeProviders([undefined], ["chatgpt"]), ["chatgpt"]);
  assert.deepEqual(normalizeProviders(["chatgpt,gemini", "chatgpt"]), ["chatgpt", "gemini"]);
});

test("builds independent jobs for simultaneous providers", () => {
  const jobs = buildJobs({
    taskId: "12345678-1234-1234-1234-123456789012",
    providers: ["chatgpt", "gemini"],
    prompt: "same prompt",
    timeoutSeconds: 1200,
    sessions: {
      chatgpt: "https://chatgpt.com/c/one",
      gemini: "https://gemini.google.com/app/two",
    },
    reasoningByProvider: { chatgpt: "high" },
  });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].prompt, jobs[1].prompt);
  assert.equal(jobs[0].session, "https://chatgpt.com/c/one");
  assert.equal(jobs[1].session, "https://gemini.google.com/app/two");
  assert.equal(jobs[0].reasoning, "high");
  assert.equal(jobs[1].reasoning, undefined);
  assert.equal(jobs[0].downloadImages, false);
  assert.notEqual(jobs[0].id, jobs[1].id);
});

test("Gemini image attachments are rejected before upstream launch", () => {
  assert.throws(() => buildJobs({
    taskId: "12345678",
    providers: ["chatgpt", "gemini"],
    prompt: "image",
    timeoutSeconds: 30,
    images: ["C:/tmp/image.png"],
  }), /image attachments for Gemini/);
});

test("parallel concurrency must cover every selected provider", () => {
  assert.equal(validateConcurrency(undefined, 2, 3), 2);
  assert.equal(validateConcurrency(3, 2, 3), 3);
  assert.throws(() => validateConcurrency(1, 2, 3), /number of selected providers/);
});
