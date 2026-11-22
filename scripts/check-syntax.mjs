// Syntax-check every source file. The old npm script listed each module by
// hand, so adding or removing one broke `npm run check` instead of checking it.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const files = [
  "bin/wfa.js",
  ...readdirSync(new URL("src", root)).filter((name) => name.endsWith(".js")).map((name) => `src/${name}`),
];
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
