import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npm = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(existsSync);
if (!npm) throw new Error("npm must be installed alongside Node");

const command = (label, directory, name, expected, direct, extra = []) => new Promise((accept, reject) => {
  const cwd = join(root, directory), pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  // Preserve future lifecycle hooks and script changes; simple Node tools need no npm/cmd wrapper.
  const simple = pkg.scripts?.[name] === expected && !pkg.scripts?.["pre" + name] && !pkg.scripts?.["post" + name];
  const args = simple ? [...direct, ...extra] : [npm, "run", name, ...(extra.length ? ["--", ...extra] : [])];
  console.log("Checking " + label);
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: "inherit" });
  child.once("error", reject);
  child.once("close", code => code === 0 ? accept() : reject(new Error(label + " exited " + code)));
});
// Typechecks do not emit files; the build writes only dist. None consumes another's output.
const results = await Promise.allSettled([
  command("extensions", ".", "typecheck", "tsc --noEmit", ["node_modules/typescript/bin/tsc", "--noEmit"]),
  command("Desk types", "pi-desk", "typecheck", "tsc --noEmit", ["node_modules/typescript/bin/tsc", "--noEmit"]),
  command("Desk build", "pi-desk", "build", "node build.mjs", ["build.mjs"]),
]);
const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
if (errors.length) throw new AggregateError(errors, "A required quality check failed");
if (process.platform === "linux") await command("performance contract", "pi-desk", "bench", "node bench/performance.mjs", ["bench/performance.mjs"], ["--check"]);
