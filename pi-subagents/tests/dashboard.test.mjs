import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	SubagentDashboard,
	activitySummary,
	flattenDashboardAgents,
} from "../extensions/subagent-dashboard.ts";

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
};

function agent(id, parentId, label, state, createdAt, extra = {}) {
	return {
		id,
		parentId,
		label,
		depth: extra.depth ?? 1,
		mode: extra.mode ?? "continuable",
		context: extra.context ?? "fresh",
		state,
		createdAt,
		updatedAt: createdAt,
		model: "test/model",
		thinkingLevel: "high",
		...extra,
	};
}

const rootSessionId = "root-session";
const agents = [
	agent("child-b", rootSessionId, "second child", "settled", 2),
	agent("grandchild", "child-a", "nested work", "waiting", 3, { depth: 2 }),
	agent("child-a", rootSessionId, "first child", "running", 1),
	agent("orphan", "missing", "diagnostic orphan", "error", 4),
];

test("dashboard flattens the durable tree in stable pre-order", () => {
	assert.deepEqual(
		flattenDashboardAgents(agents, rootSessionId).map(({ agent, depth }) => [agent.id, depth]),
		[
			["child-a", 0],
			["grandchild", 1],
			["child-b", 0],
			["orphan", 0],
		],
	);
});

test("activity summary distinguishes running, waiting, ready, and attention", () => {
	assert.equal(
		activitySummary(agents),
		"Subagents: 1 running · 1 waiting · 1 ready · 1 need attention  —  /subagents",
	);
});

test("dashboard renders bounded narrow and wide layouts", () => {
	for (const [width, height] of [
		[72, 24],
		[120, 30],
	]) {
		const dashboard = new SubagentDashboard(
			{
				rootSessionId,
				agents,
				feed: ["settlement · child-b"],
				transcript: ["user", "inspect", "assistant", "done"],
			},
			"child-a",
			theme,
			() => {},
			() => {},
			() => height,
		);
		const lines = dashboard.render(width);
		assert.equal(lines.length, height);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /background activity/i);
		assert.match(lines.join("\n"), /first child/);
		assert.match(lines.join("\n"), /test\/model/);
	}
});

test("dashboard keyboard actions use durable ids and interrupt rather than kill", () => {
	const actions = [];
	const selections = [];
	let renders = 0;
	const dashboard = new SubagentDashboard(
		{ rootSessionId, agents, feed: [], transcript: [] },
		"child-a",
		theme,
		() => renders++,
		(action) => actions.push(action),
		() => 20,
		(id) => selections.push(id),
	);
	dashboard.handleInput("m");
	dashboard.handleInput("x");
	assert.deepEqual(actions, [
		{ action: "message", id: "child-a" },
		{ action: "interrupt", id: "child-a" },
	]);
	dashboard.handleInput("j");
	assert.equal(dashboard.getSelectedId(), "grandchild");
	dashboard.handleInput("m");
	assert.equal(actions.length, 2, "nested descendants do not offer invalid direct-parent messages");
	assert.deepEqual(selections, ["grandchild"]);
	assert.ok(renders > 0);
});

test("dashboard search filters by label and preserves a valid selection", () => {
	const dashboard = new SubagentDashboard(
		{ rootSessionId, agents, feed: [], transcript: [] },
		undefined,
		theme,
		() => {},
		() => {},
		() => 18,
	);
	dashboard.handleInput("/");
	for (const character of "orphan") dashboard.handleInput(character);
	dashboard.handleInput("\r");
	assert.equal(dashboard.getSelectedId(), "orphan");
	assert.match(dashboard.render(80).join("\n"), /diagnostic orphan/);
	assert.doesNotMatch(dashboard.render(80).join("\n"), /first child/);
});
