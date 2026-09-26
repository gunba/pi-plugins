#!/usr/bin/env node
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { collectArtifacts } from "./cleanup/collector.mjs";

let agentDir = getAgentDir(), apply = false;
const extraRoots = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--apply") apply = true;
  else if (arg === "--agent-dir" || arg === "--sessions") {
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    if (arg === "--agent-dir") agentDir = resolve(value);
    else extraRoots.push({ path: resolve(value) });
  } else if (arg === "--help") {
    console.log("Usage: node pi-output-budget/cleanup.mjs [--agent-dir PATH] [--sessions PATH ...] [--apply]\nDefault: dry run. --apply requires all Pi processes stopped. Include every custom session root with --sessions.");
    process.exit(0);
  } else throw new Error(`Unknown argument: ${arg}`);
}
const roots = [
  { path: join(agentDir, "sessions"), optional: true },
  { path: join(agentDir, "subagents", "sessions"), optional: true },
  ...extraRoots,
];
const report = await collectArtifacts({ directory: join(agentDir, "tool-output"), roots, apply });
// Counts avoid turning a preview of orphan IDs into new transcript references.
const { candidates, deleted, ...summary } = report;
console.log(JSON.stringify({ ...summary, mode: apply ? "apply" : "preview", sessionRoots: roots.map(root => root.path),
  candidates: candidates.length, deleted: deleted.length }, null, 2));
if (!report.complete || (apply && !report.applied)) process.exitCode = 1;
