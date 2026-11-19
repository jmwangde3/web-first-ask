import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG } from "./constants.js";
import { getPaths } from "./paths.js";

export async function loadConfig(home) {
  const paths = getPaths(home);
  let user = {};
  try {
    user = JSON.parse(await readFile(paths.config, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const userConfig = { ...user };
  delete userConfig.defaultReasoning;
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    defaultCompareProviders: user.defaultCompareProviders ?? DEFAULT_CONFIG.defaultCompareProviders,
  };
}
