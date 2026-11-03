import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const major = Number(process.argv[2]), arch = (process.env.RUNNER_ARCH ?? process.arch).toLowerCase();
const parts = version => version.split(".").map(Number);
const supported = version => /^\d+\.\d+\.\d+$/.test(version) && parts(version)[0] === major &&
  (major !== 22 || parts(version)[1] >= 19);
const npmExists = executable => [
  join(dirname(executable), "node_modules/npm/bin/npm-cli.js"),
  join(dirname(executable), "../lib/node_modules/npm/bin/npm-cli.js"),
].some(existsSync);
const candidates = [];
if (supported(process.versions.node) && npmExists(process.execPath))
  candidates.push({ version: process.versions.node, executable: process.execPath });
const cache = process.env.RUNNER_TOOL_CACHE;
if (cache && existsSync(join(cache, "node"))) {
  for (const version of readdirSync(join(cache, "node"))) {
    if (!supported(version)) continue;
    const directory = join(cache, "node", version, arch);
    const executable = process.platform === "win32" ? join(directory, "node.exe") : join(directory, "bin/node");
    if (existsSync(directory + ".complete") && existsSync(executable) && npmExists(executable))
      candidates.push({ version, executable });
  }
}
candidates.sort((a,b) => {
  const left = parts(a.version), right = parts(b.version);
  return right[0]-left[0] || right[1]-left[1] || right[2]-left[2];
});
const selected = candidates[0];
if (selected) {
  const actual = execFileSync(selected.executable, ["-p", "process.versions.node + ' ' + process.arch"],
    { encoding: "utf8", windowsHide: true }).trim();
  if (actual !== selected.version + " " + arch) throw new Error("Image Node does not match its version and architecture");
  appendFileSync(process.env.GITHUB_PATH, dirname(selected.executable) + "\n");
  appendFileSync(process.env.GITHUB_OUTPUT, "hit=true\n");
  console.log("Using image-cached Node " + actual);
} else appendFileSync(process.env.GITHUB_OUTPUT, "hit=false\n");
