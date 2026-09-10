import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Attempts and decoder usage overlap. Sum provider responses once, never both. */
export function summarizeLedger(records) {
  const attempts = new Map(), responses = new Map(), invocations = new Map();
  const allowances = [];
  let legacyRequests = 0;
  const warnings = new Set();
  for (const record of records) {
    if (record.kind === "invocation") invocations.set(record.requestId, record);
    if (record.kind === "request") {
      if (!record.attemptId) { legacyRequests++; continue; }
      attempts.set(record.attemptId, record);
    }
    if (record.kind === "response" && record.attemptId && record.usage &&
      typeof record.usage.input_tokens === "number") {
      const existing = responses.get(record.attemptId);
      if (existing && JSON.stringify(existing.usage) !== JSON.stringify(record.usage)) {
        warnings.add("Conflicting usage for a single attempt; inspect the source log.");
      }
      // completed/done may describe the same response. Do not double count.
      if (!existing || record.event === "response.completed") responses.set(record.attemptId, record);
    }
    if (record.kind === "allowance") allowances.push({
      time: record.time, requestId: record.requestId, attemptId: record.attemptId,
      primary: record.primary, secondary: record.secondary,
    });
    if (record.kind === "headers" && record.allowance && Object.keys(record.allowance).length) {
      allowances.push({ time: record.time, requestId: record.requestId, headers: record.allowance });
    }
  }
  const groups = new Map();
  for (const [attemptId, request] of attempts) {
    const invocation = invocations.get(request.inferenceRequestId ?? request.requestId) ?? {};
    const dimensions = {
      rootSessionId: request.rootSessionId ?? invocation.rootSessionId ?? "unknown",
      sessionId: request.sessionId ?? invocation.sessionId ?? "unknown",
      model: request.model ?? "unknown",
      kind: request.prewarm ? "prewarm" : request.callKind ?? invocation.callKind ?? "unknown",
      origin: request.origin ?? invocation.origin ?? "unknown",
      transport: request.transport,
      continuationReason: request.continuationReason ?? "unknown",
    };
    const key = JSON.stringify(dimensions);
    const group = groups.get(key) ?? { ...dimensions, attempts: 0, measuredAttempts: 0, uncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 };
    group.attempts++;
    const usage = responses.get(attemptId)?.usage;
    if (usage) {
      const cached = usage.cached_tokens ?? 0;
      if (cached < 0 || cached > usage.input_tokens) {
        warnings.add("Invalid cached/input relationship; excluded that attempt's usage.");
      } else {
        group.measuredAttempts++;
        group.uncachedInput += usage.input_tokens - cached;
        group.cachedInput += cached;
        group.output += usage.output_tokens ?? 0;
        group.reasoning += usage.reasoning_tokens ?? 0;
      }
    }
    groups.set(key, group);
  }
  if (legacyRequests) warnings.add("Legacy requests lack attempt IDs and are excluded from attempt totals.");
  const unjoinedResponses = [...responses.keys()].filter(id => !attempts.has(id)).length;
  if (unjoinedResponses) warnings.add("Some responses have no matching request in the supplied logs.");
  return {
    attempts: attempts.size, measuredAttempts: [...groups.values()].reduce((sum, group) => sum + group.measuredAttempts, 0),
    legacyRequests, unjoinedResponses, groups: [...groups.values()], allowances, warnings: [...warnings],
    note: "Reported token usage, not a subscription charge formula. Reasoning is part of output. Prewarm and inference are separate. Decoder usage is not added again. Allowance observations may overlap concurrent sessions; compare only matching reset epochs.",
  };
}

export async function readLedger(files) {
  const records = [];
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  }
  return summarizeLedger(records);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("Usage: node ledger.mjs <run.jsonl> [run.jsonl ...]"); process.exitCode = 1; }
  else console.log(JSON.stringify(await readLedger(files), null, 2));
}
