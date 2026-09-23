import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import installMessageTimestamps, {
	TOOL_TIMING_ENTRY,
	embedToolTiming,
	formatElapsed,
	formatTimestamp,
} from "../extensions/message-timestamps.ts";

const at = (day, hour, minute, second = 0) => new Date(2026, 8, day, hour, minute, second).getTime();
const WIDTH = 60;
const toolLines = () => [
	"",
	`\x1b[48;2;40;50;40m${" ".repeat(WIDTH)}\x1b[49m`,
	`\x1b[48;2;40;50;40m \x1b[1mread\x1b[22m \x1b[36mC:\\file.txt\x1b[39m${" ".repeat(WIDTH - 17)}\x1b[49m`,
];

function harness(mode = "tui", branch = []) {
	const handlers = new Map();
	const statuses = [];
	const entries = [];
	const timers = [];
	let now = at(23, 12, 0), renderer, loads = 0;
	const clock = {
		now: () => now,
		setInterval(callback, ms) {
			const timer = { callback, ms, stopped: false, unref() {} };
			timers.push(timer);
			return timer;
		},
		clearInterval(timer) { timer.stopped = true; },
	};
	class ToolExecutionComponent {
		constructor(toolCallId) { this.toolCallId = toolCallId; }
		render() { return toolLines(); }
	}
	const originalRender = ToolExecutionComponent.prototype.render;
	const ctx = {
		mode,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify() {},
			setStatus(key, text) { statuses.push({ key, text }); },
		},
	};
	installMessageTimestamps({
		on(name, callback) {
			const list = handlers.get(name) ?? [];
			list.push(callback);
			handlers.set(name, list);
		},
		registerEntryRenderer(type, callback) {
			assert.equal(type, TOOL_TIMING_ENTRY);
			renderer = callback;
		},
		appendEntry(type, data) { entries.push({ type, data }); },
	}, clock, async () => { loads++; return { ToolExecutionComponent }; });
	return {
		entries, statuses, timers, ToolExecutionComponent, originalRender,
		advance(ms) { now += ms; },
		tick() { for (const timer of timers) if (!timer.stopped) timer.callback(); },
		async emit(name, event = {}) {
			for (const callback of handlers.get(name) ?? []) await callback(event, ctx);
		},
		render(callId) { return new ToolExecutionComponent(callId).render(WIDTH); },
		get loads() { return loads; },
		get oldEntryRenderer() { return renderer; },
	};
}

test("the tool title keeps its background and width while showing time inside the block", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("agent_start");
	await h.emit("tool_execution_start", { toolCallId: "call-1", toolName: "read" });
	const inProgress = h.render("call-1");
	assert.equal(inProgress.length, toolLines().length);
	assert.match(stripTerminalSequences(inProgress[2]), /read C:\\file\.txt\s+12:00 · 0s…\s*$/);
	assert.equal(visibleWidth(inProgress[2]), WIDTH);
	assert.ok(inProgress[2].includes("\x1b[48;2;40;50;40m"));
	assert.equal(h.entries.length, 0);
	h.advance(3200);
	await h.emit("tool_execution_end", { toolCallId: "call-1", toolName: "read", isError: false });
	const finished = h.render("call-1");
	assert.match(stripTerminalSequences(finished[2]), /12:00 · 3s\s*$/);
	assert.equal(finished.length, toolLines().length);
	assert.equal(h.render("other")[2], toolLines()[2], "unrelated tools remain unmodified");
	await h.emit("agent_end");
	assert.equal(h.statuses.at(-1).text, undefined);
	assert.equal(h.timers.at(-1).stopped, true);
	await h.emit("session_shutdown");
	assert.equal(h.ToolExecutionComponent.prototype.render, h.originalRender);
});

test("tool timing labels fall back to the clock time in narrow blocks", () => {
	const short = ["", `read C:\\very\\long\\path${" ".repeat(10)}\x1b[49m`];
	const output = embedToolTiming(short, visibleWidth(short[1]), "12:00 · 1m 5s", "12:00");
	assert.equal(output.length, short.length);
	assert.equal(visibleWidth(output[1]), visibleWidth(short[1]));
	assert.match(stripTerminalSequences(output[1]), /12:00\s*$/);
	assert.deepEqual(embedToolTiming(["read"], 4, "12:00"), ["read"]);
});

test("running tools retain the five-second quiet clock without appending session entries", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("agent_start");
	await h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" });
	assert.equal(h.statuses.at(-1).text, "bash · 12:00 · 0s running");
	h.advance(12_000);
	h.tick();
	assert.equal(h.statuses.at(-1).text, "bash · 12:00 · 12s running · quiet 12s");
	await h.emit("tool_execution_update");
	h.tick();
	assert.equal(h.statuses.at(-1).text, "bash · 12:00 · 12s running");
	assert.deepEqual(h.entries, []);
	await h.emit("session_shutdown");
});

test("previous timing rows disappear; their times move into the original tool blocks", async () => {
	const branch = [{
		type: "custom",
		customType: TOOL_TIMING_ENTRY,
		data: { tools: [{
			toolCallId: "old", toolName: "read",
			startedAt: at(22, 9, 3), finishedAt: at(22, 9, 3, 1), isError: false,
		}] },
	}];
	const h = harness("tui", branch);
	await h.emit("session_start");
	assert.equal(h.oldEntryRenderer(branch[0]), undefined);
	assert.match(stripTerminalSequences(h.render("old")[2]), /22 Sep 09:03 · 1s\s*$/);
	await h.emit("session_shutdown");
});

test("exact duration survives reload inside the existing tool-result record", async () => {
	const branch = [];
	const h = harness("tui", branch);
	await h.emit("session_start");
	await h.emit("tool_execution_start", { toolCallId: "saved", toolName: "read" });
	h.advance(4300);
	await h.emit("tool_execution_end", { toolCallId: "saved", toolName: "read", isError: false });
	const message = {
		role: "toolResult", toolCallId: "saved", toolName: "read", timestamp: at(23, 12, 0, 4),
		details: { truncation: { truncated: false } },
	};
	await h.emit("message_end", { message });
	assert.deepEqual(message.details.truncation, { truncated: false });
	assert.deepEqual(message.details.piMessageTimestamps, {
		startedAt: at(23, 12, 0), finishedAt: at(23, 12, 0) + 4300,
	});
	assert.deepEqual(h.entries, []);
	branch.push({ type: "message", message, timestamp: new Date(message.timestamp).toISOString() });
	await h.emit("session_shutdown");
	const reloaded = harness("tui", branch);
	await reloaded.emit("session_start");
	assert.match(stripTerminalSequences(reloaded.render("saved")[2]), /12:00 · 4s\s*$/);
	await reloaded.emit("session_shutdown");
});

test("old tool results show their completion time without inventing a duration", async () => {
	const h = harness("tui", [{
		type: "message", timestamp: new Date(at(22, 9, 3)).toISOString(),
		message: { role: "toolResult", toolCallId: "old", toolName: "read", timestamp: at(22, 9, 3) },
	}]);
	await h.emit("session_start");
	assert.match(stripTerminalSequences(h.render("old")[2]), /22 Sep 09:03\s*$/);
	assert.doesNotMatch(stripTerminalSequences(h.render("old")[2]), /<1s/);
	await h.emit("session_shutdown");
});

test("non-interactive modes do not patch the renderer or start timers", async () => {
	const h = harness("rpc");
	await h.emit("session_start");
	await h.emit("agent_start");
	await h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" });
	assert.equal(h.loads, 0);
	assert.deepEqual(h.entries, []);
	assert.deepEqual(h.timers, []);
	assert.deepEqual(h.statuses, []);
	assert.equal(h.ToolExecutionComponent.prototype.render, h.originalRender);
});

test("timestamps and elapsed durations remain compact", () => {
	assert.equal(formatTimestamp(at(23, 9, 4), at(23, 12, 0)), "09:04");
	assert.equal(formatTimestamp(at(22, 9, 4), at(23, 12, 0)), "22 Sep 09:04");
	assert.equal(formatElapsed(-100), "0s");
	assert.equal(formatElapsed(65_000), "1m 5s");
	assert.equal(formatElapsed(3_661_000), "1h 1m");
});
