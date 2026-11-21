import { DEFAULT_CONFIG } from "./constants.js";
import { WfaError } from "./errors.js";
import { normalizeProviders, validateConcurrency } from "./jobs.js";
import { getPaths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./util.js";

function validateBrowserMode(mode) {
  if (mode !== "headless" && mode !== "headful") {
    throw new WfaError("INVALID_BROWSER_MODE", 'Browser mode must be "headless" or "headful".');
  }
  return mode;
}

export async function loadConfig(home) {
  const user = await readJson(getPaths(home).config, {});
  const userConfig = { ...user };
  delete userConfig.defaultReasoning;
  const configuredProviders = userConfig.defaultProviders ?? DEFAULT_CONFIG.defaultProviders;
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    browserMode: validateBrowserMode(userConfig.browserMode ?? DEFAULT_CONFIG.browserMode),
    defaultProviders: normalizeProviders(
      Array.isArray(configuredProviders) ? configuredProviders : [configuredProviders],
      DEFAULT_CONFIG.defaultProviders,
    ),
    defaultConcurrency: validateConcurrency(
      userConfig.defaultConcurrency ?? DEFAULT_CONFIG.defaultConcurrency,
      1,
      userConfig.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency,
    ),
    defaultCompareProviders: user.defaultCompareProviders ?? DEFAULT_CONFIG.defaultCompareProviders,
  };
}

export async function saveBrowserMode(store, mode) {
  validateBrowserMode(mode);
  await store.withLock(async () => {
    const config = await readJson(store.paths.config, {});
    await writeJsonAtomic(store.paths.config, { ...config, browserMode: mode });
  });
}
