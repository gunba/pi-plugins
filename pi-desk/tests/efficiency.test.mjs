import assert from "node:assert/strict";
import test from "node:test";
import { addText, buildReport, emptyFile } from "../src/host/efficiency.ts";

const at = Date.parse("2026-10-16T10:00:00Z");
const assistant = (minutes, usage, provider = "anthropic", model = "claude-opus-5") => ({ type: "message", message: { role: "assistant", provider, model, timestamp: at + minutes * 60_000,
	usage: { ...usage, output: 10, cost: { input: usage.input / 1e6, output: 0, cacheRead: usage.cacheRead / 1e7, cacheWrite: usage.cacheWrite / 1e6, total: 0 } }, content: [] } });
const user = minutes => ({ type: "message", message: { role: "user", content: "next", timestamp: at + minutes * 60_000 } });
test("cache breaks are attributed to expiry, prompt changes, switches or nothing", () => {
	const state = emptyFile(), ttl = model => model.startsWith("anthropic/") ? 3_600_000 : undefined;
	const lines = [
		assistant(0, { input: 100, cacheRead: 0, cacheWrite: 50_000 }),
		user(1), assistant(2, { input: 100, cacheRead: 50_000, cacheWrite: 500 }),        // hit
		user(3), assistant(4, { input: 100, cacheRead: 0, cacheWrite: 50_000 }),          // unexplained, warm cache
		{ type: "message", message: { role: "system", content: "", timestamp: at } },
		user(5), assistant(6, { input: 100, cacheRead: 0, cacheWrite: 50_000 }),          // prompt or tools changed
		user(130), assistant(130, { input: 100, cacheRead: 0, cacheWrite: 50_000 }),      // expired after an hour
		{ type: "model_change" }, user(131), assistant(131, { input: 100, cacheRead: 0, cacheWrite: 50_000 }, "anthropic", "claude-sonnet-5"),
		{ type: "message", message: { role: "toolResult", toolCallId: "x", toolName: "read", isError: true, timestamp: at, content: [{ type: "text", text: "ENOENT: no such file or directory, access '/a/b.ts'" }] } },
	];
	addText(state, lines.map(line => JSON.stringify(line)).join("\n") + "\n", ttl);
	const report = buildReport([state, (() => { const other = emptyFile(); addText(other, JSON.stringify(lines.at(-1)) + "\n", ttl); return other; })()], at + 86_400_000);
	const breaks = Object.fromEntries(Object.entries(report.week.breaks).map(([cause, value]) => [cause, value.count]));
	assert.deepEqual(breaks, { expiry: 1, switch: 1, prompt: 1, contextEdit: 0, unknown: 0, unexplained: 1 });
	assert.equal(report.week.firstRequests, 5);
	assert.equal(report.week.firstMisses, 1, "only a miss on a cache that should have been warm counts");
	assert.equal(report.recurringErrors[0].signature, "enoent: no such file or directory, access <s>");
	assert.equal(report.recurringErrors[0].sessions, 2);
});
