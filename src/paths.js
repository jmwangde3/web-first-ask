import os from "node:os";
import path from "node:path";

export function getHomeDir(env = process.env) {
  if (env.WFA_HOME) return path.resolve(env.WFA_HOME);
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "web-first-ask");
  }
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "web-first-ask");
}

export function getPaths(home = getHomeDir()) {
  return {
    home,
    config: path.join(home, "config.json"),
    tasks: path.join(home, "tasks.json"),
    sessions: path.join(home, "sessions.json"),
    lock: path.join(home, ".store.lock"),
    runs: path.join(home, "runs"),
  };
}
