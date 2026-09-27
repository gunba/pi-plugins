import assert from "node:assert/strict";
import test from "node:test";
import installMessageTimestamps, { formatElapsed, formatTimestamp } from "../extensions/message-timestamps.ts";

const at = (day, hour, minute, second = 0) => new Date(2026, 8, day, hour, minute, second).getTime();
function harness(mode = "tui") {
	const handlers = new Map(), statuses = [], timers = [];
	let now = at(23, 12, 0);
	const clock = {
		now: () => now,
		setInterval(callback, ms) {
			const timer = { callback, ms, stopped: false, unref() {} };
			timers.push(timer); return timer;
		},
		clearInterval(timer) { timer.stopped = true; },
	};
	const ctx = { mode, ui: { setStatus(key, text) { statuses.push({ key, text }); } } };
	// No renderer imports, UI notifications or transcript writes are available.
	installMessageTimestamps({ on(name, callback) { handlers.set(name, callback); } }, clock);
	return {
		statuses, timers,
		advance(ms) { now += ms; },
		tick() { for (const timer of timers) if (!timer.stopped) timer.callback(); },
		emit(name, event = {}) { return handlers.get(name)?.(event, ctx); },
	};
}

test("public lifecycle events retain the live clock through agent_end until final settlement", () => {
	const h = harness();
	h.emit("session_start"); h.emit("agent_start");
	h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" });
	assert.equal(h.statuses.at(-1).text, "bash · 12:00 · 0s running");
	h.advance(12_000); h.tick();
	assert.equal(h.statuses.at(-1).text, "bash · 12:00 · 12s running · quiet 12s");
	h.emit("tool_execution_update"); h.tick();
	assert.equal(h.statuses.at(-1).text, "bash · 12:00 · 12s running");
	h.emit("agent_end");
	assert.equal(h.timers.at(-1).stopped, false);
	h.emit("agent_settled");
	assert.equal(h.statuses.at(-1).text, undefined);
	assert.equal(h.timers.at(-1).stopped, true);
});

for (const mode of ["tui", "rpc", "json", "print"]) test(`${mode} captures timings without private rendering or mutating a frozen result`, () => {
	const h = harness(mode), args = { toolCallId: "saved", toolName: "read" };
	h.emit("session_start"); h.emit("agent_start"); h.emit("tool_execution_start", args);
	h.advance(4300); h.emit("tool_execution_end", args);
	const details = Object.freeze({ truncation: { truncated: false } });
	const message = Object.freeze({ role: "toolResult", ...args, timestamp: at(23, 12, 0, 4), details });
	const result = h.emit("message_end", { message });
	assert.deepEqual(result.message.details, { truncation: details.truncation,
		piMessageTimestamps: { startedAt: at(23, 12, 0), finishedAt: at(23, 12, 0) + 4300 } });
	assert.equal(message.details.piMessageTimestamps, undefined);
	assert.equal(h.emit("message_end", { message }), undefined, "a timing is consumed once");
	h.emit("session_shutdown");
	if (mode !== "tui") { assert.deepEqual(h.timers, []); assert.deepEqual(h.statuses, []); }
});

test("missing starts, non-object details and retired session timings are not invented or replaced", () => {
	for (const details of [[], "output", null]) {
		const h = harness(), args = { toolCallId: "a", toolName: "read" };
		h.emit("tool_execution_start", args); h.emit("tool_execution_end", args);
		assert.equal(h.emit("message_end", { message: { role: "toolResult", ...args, details } }), undefined);
	}
	const h = harness(), args = { toolCallId: "a", toolName: "read" };
	h.emit("tool_execution_end", args);
	assert.equal(h.emit("message_end", { message: { role: "toolResult", ...args } }), undefined);
	h.emit("tool_execution_start", args); h.emit("tool_execution_end", args); h.emit("session_tree");
	assert.equal(h.emit("message_end", { message: { role: "toolResult", ...args } }), undefined);
});

test("timestamps and elapsed durations remain compact", () => {
	assert.equal(formatTimestamp(at(23, 9, 4), at(23, 12, 0)), "09:04");
	assert.equal(formatTimestamp(at(22, 9, 4), at(23, 12, 0)), "22 Sep 09:04");
	assert.equal(formatElapsed(-100), "0s");
	assert.equal(formatElapsed(65_000), "1m 5s");
	assert.equal(formatElapsed(3_661_000), "1h 1m");
});
