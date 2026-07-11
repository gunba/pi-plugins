import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import subagents, {
	normalizeAgentName,
	taskSummary,
	thinkingAtOrBelow,
} from "../extensions/subagents.ts";
import {
	SubagentDashboard,
	flattenDashboardAgents,
	orchestrationSummary,
} from "../extensions/subagent-dashboard.ts";

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
};

function agents(count, deep = false) {
	const out = [
		{
			name: "main",
			taskId: "main",
			parent: null,
			taskName: "",
			state: "running",
			startedAt: 1,
			updatedAt: 1,
		},
	];
	for (let index = 0; index < count; index++) {
		let state = "running";
		if (index % 7 === 0) state = "done";
		else if (index % 11 === 0) state = "stopped";
		out.push({
			name: `Agent${index}`,
			taskId: `task-${String(index).padStart(4, "0")}`,
			parent: deep && index > 0 ? `Agent${index - 1}` : "main",
			taskName: `Investigate orchestration case ${index}`,
			state,
			startedAt: index + 2,
			updatedAt: index + 2,
			thinking: "medium",
		});
	}
	return out;
}

test("human names are selected explicitly and kept separate from task labels", () => {
	assert.equal(normalizeAgentName("maya"), "Maya");
	assert.equal(normalizeAgentName("Élodie"), "Élodie");
	assert.equal(normalizeAgentName("anne-marie"), "Anne-marie");
	assert.throws(() => normalizeAgentName("auth race repro"), /first name/i);
	assert.throws(() => normalizeAgentName("Agent42"), /first name/i);
	assert.equal(
		taskSummary("  Inspect\n\nall   nested agents  "),
		"Inspect all nested agents",
	);
});

test("subagent thinking cannot exceed its parent's level", () => {
	assert.equal(thinkingAtOrBelow(undefined, "high"), "high");
	assert.equal(thinkingAtOrBelow("low", "high"), "low");
	assert.equal(thinkingAtOrBelow("max", "max"), "max");
	assert.throws(() => thinkingAtOrBelow("xhigh", "high"), /exceeds/i);
	assert.throws(() => thinkingAtOrBelow("minimal", "off"), /exceeds/i);
});

test("root registration exposes tools without calling runtime actions during loading", () => {
	const tools = [];
	const handlers = [];
	subagents({
		getThinkingLevel: () => {
			throw new Error("Extension runtime not initialized");
		},
		registerTool: (tool) => tools.push(tool),
		on: (event, handler) => handlers.push({ event, handler }),
	});
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["spawn", "message", "kill", "wait", "inspect_agent", "control_agent"],
	);
	assert.ok(handlers.some(({ event }) => event === "agent_settled"));
	assert.ok(handlers.some(({ event }) => event === "thinking_level_select"));
});

test("a 50-level orchestration tree remains ordered and searchable", () => {
	const rows = flattenDashboardAgents(agents(50, true));
	assert.equal(rows.length, 50);
	assert.equal(rows[0].depth, 0);
	assert.equal(rows.at(-1).depth, 49);
	assert.equal(rows.at(-1).agent.taskId, "task-0049");
});

test("compact status summarizes large teams without rendering every agent", () => {
	const summary = orchestrationSummary(agents(50));
	assert.match(summary, /^Subagents:/);
	assert.match(summary, /active/);
	assert.match(summary, /done/);
	assert.match(summary, /need attention/);
	assert.match(summary, /\/subagents/);
});

test("dashboard virtualizes 50 agents and obeys narrow and wide render widths", () => {
	const snapshot = {
		agents: agents(50, true),
		feed: ["main→Agent1: inspect"],
		transcript: [
			"user",
			"This is a deliberately long agent conversation line that should wrap across the full-screen transcript pane instead of being truncated before its final marker ENDMARK",
			"",
			"tool result · read",
			"ok",
		],
	};
	const dashboard = new SubagentDashboard(
		snapshot,
		"Agent25",
		theme,
		() => {},
		() => {},
		() => 50,
	);
	for (const width of [20, 60, 120]) {
		const lines = dashboard.render(width);
		assert.equal(lines.length, 50, `dashboard did not fill terminal height at width ${width}`);
		assert.match(lines.join("\n"), /ENDMARK/);
		assert.ok(
			lines.every((line) => visibleWidth(line) <= width),
			`line exceeded width ${width}`,
		);
		dashboard.invalidate();
	}
});
