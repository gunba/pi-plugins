import { globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { run } from "node:test";
import { tap } from "node:test/reporters";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const timings = JSON.parse(readFileSync(new URL("./timings.json", import.meta.url), "utf8"));
const workers = 2;

/** Discover Node's default test patterns, including newly added unprofiled files. */
export function discover() {
  const extensions = ["js", "mjs", "cjs", ...(process.features.typescript ? ["ts", "mts", "cts"] : [])];
  const pattern = `**/{test,test/**/*,test-*,*[._-]test}.{${extensions.join(",")}}`;
  return [...new Set(globSync(pattern, { cwd: root, exclude: path => path.split(/[\\/]/).includes("node_modules") }))]
    .map(path => path.split(sep).join("/")).sort();
}

/** Longest-first bins keep expensive files on different VMs; every file occurs once. */
export function partition(files, count, platform = process.platform) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("A shard count must be positive");
  const measured = timings[platform] ?? {}, cost = file => measured[file] ?? 1000;
  const bins = Array.from({ length: count }, () => ({ files: [], milliseconds: 0 }));
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const bin = bins.reduce((a, b) => a.milliseconds <= b.milliseconds ? a : b);
    bin.files.push(file); bin.milliseconds += cost(file);
  }
  return bins;
}

/** Process isolation and the original timeout are retained; any failure makes CI fail. */
export async function execute(files) {
  process.chdir(root);
  const events = run({
    files: files.map(file => resolve(root, file)), isolation: "process",
    concurrency: workers, timeout: 120000,
    execArgv: ["--test-timeout=120000", "--test-concurrency=" + workers],
  });
  events.on("test:fail", () => { process.exitCode = 1; });
  events.on("test:complete", data => {
    if (data.file && resolve(root, data.name) === resolve(data.file)) console.log("# CI_FILE_TIMING " + JSON.stringify({
      file: relative(root, data.file).split(sep).join("/"), milliseconds: data.details.duration_ms,
    }));
  });
  const output = events.compose(tap);
  output.pipe(process.stdout, { end: false });
  await finished(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const match = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? "");
  if (!match) throw new Error("Usage: run-tests.mjs <shard>/<total> [--list]");
  const index = Number(match[1]), total = Number(match[2]);
  if (index < 1 || index > total) throw new Error("Shard index is outside its range");
  const files = discover();
  if (!files.length) throw new Error("No tests were discovered");
  const bins = partition(files, total);
  console.log("# CI_SHARD " + JSON.stringify({ index, total, workers, files: bins[index - 1].files.length, discovered: files.length }));
  if (process.argv.includes("--list")) console.log(JSON.stringify(bins, null, 2));
  else await execute(bins[index - 1].files);
}
