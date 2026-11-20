import path from "node:path";
import { PROVIDERS } from "./constants.js";
import { WfaError } from "./errors.js";

export function normalizeProviders(values, fallback = ["chatgpt"]) {
  const supplied = (values ?? []).filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  const raw = supplied.length ? supplied : fallback;
  const providers = [...new Set(raw.flatMap((value) => String(value).split(",")).map((v) => v.trim().toLowerCase()).filter(Boolean))];
  if (!providers.length) throw new WfaError("NO_PROVIDER", "At least one provider is required.");
  for (const provider of providers) {
    if (!PROVIDERS.includes(provider)) {
      throw new WfaError("INVALID_PROVIDER", `Unsupported provider "${provider}". Supported: ${PROVIDERS.join(", ")}.`);
    }
  }
  return providers;
}

export function buildJobs({
  taskId,
  providers,
  prompt,
  promptByProvider = {},
  timeoutSeconds,
  sessions = {},
  fresh = false,
  files = [],
  images = [],
  modelByProvider = {},

  downloadImages = false,
}) {
  const suffix = taskId.replaceAll("-", "").slice(0, 8);
  return providers.map((provider) => {
    if (provider === "gemini" && images.length) {
      throw new WfaError("GEMINI_IMAGE_UNSUPPORTED", "ask-bridge batch does not support image attachments for Gemini. Use --file for supported document formats or omit Gemini from this image request.");
    }
    const job = {
      id: `wfa-${provider}-${suffix}`,
      provider,
      prompt: promptByProvider[provider] ?? prompt,
      timeout: timeoutSeconds,
      files,
      images,
      downloadImages,
    };
    if (!fresh && sessions[provider]) job.session = sessions[provider];
    if (modelByProvider[provider]) job.model = modelByProvider[provider];

    return job;
  });
}

export function validateConcurrency(concurrency, providerCount, maxConcurrency = 3) {
  const value = concurrency ?? providerCount;
  if (!Number.isInteger(value) || value < 1 || value > maxConcurrency || value < providerCount) {
    throw new WfaError("INVALID_CONCURRENCY", `Concurrency must be between the number of selected providers (${providerCount}) and ${maxConcurrency}.`);
  }
  return value;
}

export function resolveAttachmentPaths(paths = [], cwd = process.cwd()) {
  return paths.map((item) => path.resolve(cwd, item));
}
