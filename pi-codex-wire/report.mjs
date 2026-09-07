import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Summarize marked intervals only. Do not infer subscription pricing from API costs. */
export function summarize(records) {
  const run = records.find(record => record.kind === "run");
  const marks = records.map((record, index) => ({ ...record, index })).filter(record => record.kind === "allowance-mark");
  const intervals = [];
  for (let i = 1; i < marks.length; i++) {
    const before = marks[i - 1], after = marks[i];
    const sample = records.slice(before.index + 1, after.index);
    const requests = sample.filter(record => record.kind === "request" && !record.prewarm);
    const usage = sample.filter(record => record.kind === "usage");
    const ids = new Set(requests.map(record => record.requestId));
    const results = new Set(usage.map(record => record.requestId));
    const reasons = [];
    if (before.resetId !== after.resetId || after.usedPercent < before.usedPercent) reasons.push("allowance-window-changed");
    if (!requests.length) reasons.push("no-recorded-requests");
    if ([...ids].some(id => !results.has(id)) || [...results].some(id => !ids.has(id))) reasons.push("incomplete-request-coverage");
    if (usage.some(record => ["error", "aborted"].includes(record.stopReason))) reasons.push("failed-or-aborted-request");
    if (sample.some(record => record.kind === "fallback")) reasons.push("transport-fallback");
    if (sample.some(record => record.kind === "context-window-replaced")) reasons.push("context-window-replaced");
    const sum = key => usage.reduce((total, record) => total + (record[key] ?? 0), 0);
    intervals.push({
      profile: run?.profile, from: before.time, to: after.time,
      usable: reasons.length === 0, warnings: reasons,
      allowancePercentagePoints: reasons.includes("allowance-window-changed") ? null : Number((after.usedPercent - before.usedPercent).toFixed(6)),
      requests: ids.size, wireAttempts: requests.length,
      models: [...new Set(requests.map(record => record.model))],
      efforts: [...new Set(requests.map(record => record.effort))],
      tiers: [...new Set(requests.map(record => record.serviceTier))],
      transports: [...new Set(requests.map(record => record.transport))],
      uncachedInput: sum("input"), cachedInput: sum("cached"), output: sum("output"), reasoning: sum("reasoning"),
    });
  }
  return { profile: run?.profile, intervals, note: "Compare repeated, isolated, matched workloads. A client-correlated difference does not establish intent." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("Usage: node report.mjs <run.jsonl> [run.jsonl ...]"); process.exitCode = 1; }
  else {
    const results = files.map(file => ({ file, ...summarize(readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))) }));
    console.log(JSON.stringify(results, null, 2));
  }
}
