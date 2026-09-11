import assert from "node:assert/strict";
import test from "node:test";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { safeWorkText, workPanelLines, WorkDetailView } from "../view.ts";
import { goalWorkSection, todoWorkSection, subagentWorkSection } from "../sections.ts";

export const theme = {
	fg(_color, text) { return `\x1b[36m${text}\x1b[39m`; },
	bold(text) { return `\x1b[1m${text}\x1b[22m`; },
};
export const plainTheme = { fg(_color, text) { return text; }, bold(text) { return text; } };
export const bindings = {
	"tui.select.up": ["up"], "tui.select.down": ["down"],
	"tui.select.pageUp": ["pageUp"], "tui.select.pageDown": ["pageDown"],
	"tui.select.confirm": ["enter"], "tui.select.cancel": ["escape", "ctrl+c"],
};
export const keybindings = {
	matches(data, action) { return (bindings[action] ?? []).some((key) => matchesKey(data, key)); },
	getKeys(action) { return bindings[action] ?? []; },
};
const goal = { id: "g", revision: 2, phase: "active", activation: "armed", roundsStarted: 3, maxGoalRounds: 50, objective: "Verify 漢字 👨‍👩‍👧‍👦 é 🇦🇺" };
const todos = [
	{ content: "finished", status: "completed" },
	{ content: "current", status: "in_progress" },
	{ content: "parallel", status: "in_progress" },
	{ content: "next", status: "pending" },
];
const agents = [
	{ id: "a", label: "Unit tests", state: "running", activity: "testing" },
	{ id: "b", label: "Blocked compile", state: "error", errorMessage: "Compiler failed" },
	{ id: "c", label: "Review", state: "waiting" },
	{ id: "d", label: "QA", state: "settled" },
];
const snapshot = () => [["goal", goalWorkSection(goal)], ["todos", todoWorkSection(todos)], ["subagents", subagentWorkSection(agents)]];
function viewHarness(data = snapshot(), options = {}) {
	let renders = 0;
	const results = [];
	let height = 12;
	const view = new WorkDetailView(data, { theme: plainTheme, keybindings, getHeight: () => height, requestRender() { renders++; }, done(value) { results.push(value); }, ...options });
	return { view, results, renders: () => renders, setHeight(value) { height = value; } };
}

for (const width of [0, 1, 2, 8, 16, 24, 40, 80, 132, 240]) {
	test(`panel and detail rows stay within ${width} cells with Unicode and ANSI themes`, () => {
		const data = snapshot();
		data[0][1].summary = `${goal.objective}\n${goal.objective.repeat(300)}`;
		const lines = workPanelLines(data, theme, width);
		assert.ok(lines.length <= 4);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
		const { view } = viewHarness(data, { theme });
		for (const expanded of [false, true]) {
			if (expanded) view.handleInput("\r");
			const rendered = view.render(width);
			assert.ok(rendered.length <= 12);
			for (const line of rendered) assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
		}
	});
}

test("collapsed summaries show concrete state, current task and attention before previews", () => {
	const lines = workPanelLines(snapshot(), plainTheme, 120);
	assert.match(lines.join("\n"), /Work · \/work expand/);
	assert.match(lines[1], /Goal active · armed · 3\/50 · Verify/);
	assert.match(lines[2], /Todos 1\/4 done · 2 active · 1 pending · current \(\+1 active\)/);
	assert.match(lines[3], /Subagents ! 1 attention · 1 running · 1 waiting · 1 ready/);
	assert.match(workPanelLines(snapshot(), plainTheme, 24)[3], /! 1 attention/);
	assert.doesNotMatch(lines.join("\n"), /ctrl\+o|Ctrl\+O/);
	assert.deepEqual(workPanelLines([], plainTheme, 80), []);
});

test("goal projections retain pause, disarmed, completion, blocker and corruption details", () => {
	for (const phase of ["active", "paused", "complete", "blocked"]) {
		const section = goalWorkSection({ ...goal, phase, activation: "disarmed", blockedReason: phase === "blocked" ? { code: "round-limit", message: "Too many rounds\nMore detail" } : undefined });
		assert.match(section.status, new RegExp(phase));
		assert.match(section.detail, /disarmed/);
		if (phase === "blocked") { assert.equal(section.tone, "warning"); assert.match(section.detail, /round-limit: Too many rounds\nMore detail/); }
	}
	const corrupt = goalWorkSection(undefined, "bad history\nprecise reason");
	assert.equal(corrupt.tone, "error");
	assert.equal(corrupt.status, "! corrupt");
	assert.match(corrupt.detail, /precise reason/);
	assert.equal(goalWorkSection(undefined), undefined);
	assert.equal(todoWorkSection([]), undefined);
	assert.equal(subagentWorkSection([]), undefined);
});

test("multiline goals start collapsed and the entire long objective is reachable by scrolling", () => {
	const objective = Array.from({ length: 700 }, (_, index) => `Objective line ${index}: ${"漢字 é 👩‍💻 ".repeat(4)}`).join("\n\n");
	const { view } = viewHarness([["goal", goalWorkSection({ ...goal, objective })]]);
	assert.doesNotMatch(view.render(100).join("\n"), /Objective line/);
	view.handleInput("\r");
	let lines = view.render(100);
	assert.match(lines.join("\n"), /Objective line 0/);
	assert.ok(lines.length <= 12);
	const collected = new Set();
	for (let page = 0; page < 350; page++) {
		for (const match of view.render(100).join("\n").matchAll(/Objective line (\d+):/g)) collected.add(Number(match[1]));
		view.handleInput("\x1b[6~");
	}
	assert.equal(collected.size, 700, "no objective line is truncated from the detail buffer");
	view.handleInput("\x1b[F");
	assert.match(view.render(100).join("\n"), /Manage with \/goal/);
	view.handleInput("\x1b[H");
	assert.match(view.render(100).join("\n"), /Objective line 0/);
	view.handleInput("\r");
	assert.doesNotMatch(view.render(100).join("\n"), /Objective line/);
});

test("detail height follows terminal shrink and text rewraps on width changes", () => {
	const { view, setHeight } = viewHarness([["goal", goalWorkSection({ ...goal, objective: "word ".repeat(2000) })]], { initialSection: "goal" });
	for (const height of [24, 12, 5, 3, 1]) {
		setHeight(height);
		for (const width of [20, 70, 140]) {
			const lines = view.render(width);
			assert.ok(lines.length <= height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
});

test("updates refresh live summaries/details, clamp scroll and remove cleared sections", () => {
	const { view } = viewHarness([["goal", goalWorkSection({ ...goal, objective: "old\n".repeat(200) })]], { initialSection: "goal" });
	view.render(80);
	view.handleInput("\x1b[F");
	view.update([["goal", goalWorkSection({ ...goal, objective: "Replacement objective" })]]);
	assert.match(view.render(80).join("\n"), /Replacement objective/);
	assert.doesNotMatch(view.render(80).join("\n"), /old/);
	view.update([]);
	assert.match(view.render(80).join("\n"), /No current work/);
});

test("selector navigates, expands todos and routes explicit dashboard action", () => {
	const data = snapshot();
	data[2][1].action = { label: "dashboard", run: async () => {} };
	const { view, results } = viewHarness(data);
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	assert.match(view.render(100).join("\n"), /\[in progress\] current/);
	view.handleInput("\r");
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	assert.match(view.render(100).join("\n"), /d dashboard/);
	view.handleInput("d");
	assert.deepEqual(results, ["subagents"]);
	view.handleInput("\x1b");
	assert.deepEqual(results, ["subagents", undefined]);
});

test("injected selection keybindings control expansion and appear in hints", () => {
	const custom = { matches(data, action) { return data === ({ "tui.select.confirm": "z", "tui.select.cancel": "c" })[action]; }, getKeys(action) { return action === "tui.select.confirm" ? ["z"] : ["c"]; } };
	const { view } = viewHarness(snapshot(), { keybindings: custom });
	assert.match(view.render(100).join("\n"), /z expand/);
	view.handleInput("z");
	assert.match(view.render(100).join("\n"), /Verify/);
});

test("terminal controls are inert; durable source text is unchanged", () => {
	const objective = "title\nnext\x1b[2J\x9b31m\t\u2028end";
	const original = { ...goal, objective };
	const section = goalWorkSection(original);
	assert.equal(original.objective, objective);
	assert.match(section.detail, /\x1b/);
	const { view } = viewHarness([["goal", section]], { initialSection: "goal" });
	const lines = view.render(200);
	assert.match(lines.join("|"), /title\|next\\u001b\[2J\\u009b31m/);
	for (const line of lines) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
	assert.equal(safeWorkText("a\r\nb\rc", true), "a\nb\nc");
});

test("disposing a detail view disables render, input and update callbacks; reopening is collapsed", () => {
	const { view, renders, results } = viewHarness(snapshot(), { initialSection: "goal" });
	view.dispose();
	const count = renders();
	view.update(snapshot());
	view.handleInput("\r");
	view.handleInput("\x1b");
	assert.deepEqual(view.render(80), []);
	assert.equal(renders(), count);
	assert.deepEqual(results, []);
	assert.doesNotMatch(viewHarness().view.render(100).join("\n"), /Verify/);
});
