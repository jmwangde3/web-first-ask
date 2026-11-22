import { readFileSync } from "node:fs";
import path from "node:path";

export function getBrowserPaths(home) {
  return {
    home,
    lock: path.join(home, "browser.lock"),
    brokerLock: path.join(home, "broker.lock"),
    profileDir: path.join(home, "chrome-profile"),
    logDir: path.join(home, "logs"),
  };
}

// Cache the package version for normal runtime calls. An injected reader bypasses
// the cache so a failed read can be tested without altering subsequent calls.
let cachedWfaVersion;

export function getWfaVersion(reader = readFileSync) {
  if (reader === readFileSync && cachedWfaVersion !== undefined) return cachedWfaVersion;
  let version = "unknown";
  try {
    const data = JSON.parse(reader(new URL("../../package.json", import.meta.url), "utf8"));
    if (typeof data?.version === "string" && data.version.trim()) version = data.version;
  } catch {
    // Missing, unreadable or invalid package metadata must not block recovery.
  }
  if (reader === readFileSync) cachedWfaVersion = version;
  return version;
}
