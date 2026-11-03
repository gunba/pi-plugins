import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npm = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(existsSync);
if (!npm) throw new Error("npm must be installed alongside Node");

const command = (label, args) => new Promise((accept, reject) => {
  console.log("Checking " + label);
  const child = spawn(process.execPath, [npm, ...args], { cwd: root, windowsHide: true, stdio: "inherit" });
  child.once("error", reject);
  child.once("close", code => code === 0 ? accept() : reject(new Error(label + " exited " + code)));
});
// Typechecks do not emit files; the build writes only dist. None consumes another's output.
const results = await Promise.allSettled([
  command("extensions", ["run", "typecheck"]),
  command("Desk types", ["--prefix", "pi-desk", "run", "typecheck"]),
  command("Desk build", ["--prefix", "pi-desk", "run", "build"]),
]);
const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
if (errors.length) throw new AggregateError(errors, "A required quality check failed");
// Run the benchmark after the other checks so contention cannot distort its measurements.
if (process.platform === "linux") await command("performance contract", ["--prefix", "pi-desk", "run", "bench", "--", "--check"]);
