import path from "node:path";
import { DEFAULT_CONFIG, PROVIDERS } from "./constants.js";
import { isArchiveAttachment } from "./attachments.js";
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
  filesByProvider = {},
  images = [],
  modelByProvider = {},
  allowGeminiAttachments = false,

  downloadImages = false,
}) {
  const suffix = taskId.replaceAll("-", "").slice(0, 8);
  return providers.map((provider) => {
    if (provider === "gemini" && images.length) {
      throw new WfaError("GEMINI_IMAGE_UNSUPPORTED", "ask-bridge batch does not support image attachments for Gemini. Use --file for supported document formats or omit Gemini from this image request.");
    }
    const providerFiles = filesByProvider[provider] ?? files;
    // Archives are exempt: they upload as opaque attachments and measured fast
    // in batch. Everything else would hit ask-bridge's whole-filename check,
    // which reports ordinary names as never attached (known-issues U1).
    const archiveOnly = providerFiles.length > 0 && providerFiles.every((file) => isArchiveAttachment(file));
    if (provider === "gemini" && providerFiles.length && !allowGeminiAttachments && !archiveOnly) {
      throw new WfaError(
        "GEMINI_ATTACHMENT_UNSUPPORTED",
        "Gemini receives text attachments inline, not as uploads: ask-bridge confirms an attachment by matching the whole filename against the page text, so ordinary names are reported as never attached about 50 s later (known issue U1). Use a zip/tar archive (those upload natively), inline the content into a prompt under 40 KiB, drop Gemini with --providers chatgpt, or force the upload with --allow-gemini-attachments and a filename stem of 20 characters or fewer.",
      );
    }
    const job = {
      id: `wfa-${provider}-${suffix}`,
      provider,
      prompt: promptByProvider[provider] ?? prompt,
      timeout: timeoutSeconds,
      files: providerFiles,
      images,
      downloadImages,
    };
    if (!fresh && sessions[provider]) job.session = sessions[provider];
    if (modelByProvider[provider]) job.model = modelByProvider[provider];

    return job;
  });
}

export function validateConcurrency(concurrency, providerCount, maxConcurrency = 3) {
  // Dual-provider parallel by default; explicit `--concurrency 1` forces serial execution.
  const value = concurrency ?? DEFAULT_CONFIG.defaultConcurrency;
  if (!Number.isInteger(value) || value < 1 || value > maxConcurrency) {
    throw new WfaError("INVALID_CONCURRENCY", `Concurrency must be an integer between 1 and ${maxConcurrency}; 1 runs ${providerCount} provider(s) sequentially.`);
  }
  return value;
}

export function resolveAttachmentPaths(paths = [], cwd = process.cwd()) {
  return paths.map((item) => path.resolve(cwd, item));
}

