import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { safeWorkText, workPanelLines } from "../view.ts";
import { WorkModal } from "../modal.ts";
import { goalWorkSection, todoWorkSection, subagentWorkSection } from "../sections.ts";

const theme = { fg(_color, text) { return `\x1b[36m${text}\x1b[39m`; }, bold(text) { return `\x1b[1m${text}\x1b[22m`; } };
const plain = { fg(_color, text) { return text; }, bold(text) { return text; } };
const goal = { id: "g", revision: 2, phase: "active", activation: "armed", roundsStarted: 3, maxGoalRounds: 50, objective: "Verify 漢字 👨‍👩‍👧‍👦 é 🇦🇺" };
const todos = [{ content: "finished", status: "completed" }, { content: "current", status: "in_progress" }, { content: "next", status: "pending" }];
const agents = [{ id: "a", label: "Unit tests", state: "running", activity: "testing" }, { id: "b", label: "Compile", state: "error", errorMessage: "Compiler failed" }];
const snapshot = () => [["goal", goalWorkSection(goal)], ["todos", todoWorkSection(todos)], ["subagents", subagentWorkSection(agents)]];
const mouse = (y, extra = {}) => ({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y, width: 100, height: 20, shift: false, alt: false, ctrl: false, ...extra });
const modal = (data = snapshot(), theme = plain, height = 24) => new WorkModal(data, "goal", theme, getKeybindings(), () => height, () => {}, () => {});

for (const width of [0, 1, 2, 8, 16, 24, 40, 80, 132, 240]) {
	test(`summary and modal stay within ${width} cells with Unicode and ANSI themes`, () => {
		const data = snapshot();
		data[0][1].summary = goal.objective.repeat(300);
		for (const line of workPanelLines(data, theme, width)) assert.ok(visibleWidth(line) <= width);
		for (const height of [1, 3, 6, 12, 24]) {
			const lines = modal(data, theme, height).render(width);
			assert.ok(lines.length <= height);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
		}
	});
}

test("collapsed summaries retain priority state and current task, without a global expansion control", () => {
	const lines = workPanelLines(snapshot(), plain, 120);
	assert.match(lines[1], /Goal active · armed · Verify/);
	assert.doesNotMatch(lines[1], /3\/50/);
	assert.match(lines[2], /Todos 1\/3 done · 1 active · 1 pending · current/);
	assert.match(lines[3], /Subagents ! 1 attention · 1 running/);
	assert.match(workPanelLines(snapshot(), plain, 24)[3], /! 1 attention/);
	assert.match(lines.join("\n"), /\/work/);
	assert.doesNotMatch(lines.join("\n"), /alt\+|ctrl\+o/i);
	assert.deepEqual(workPanelLines([], plain, 80), []);
});

test("modal tabs select complete details without expansion controls", () => {
	const view = modal();
	view.render(100);
	const response = view.handleMouse(mouse(1, { x: 10 }));
	assert.equal(response.handled, true);
	assert.equal(response.focus, undefined);
	let lines = view.render(100);
	assert.match(lines.join("\n"), /\[in progress\] current/);
	assert.doesNotMatch(lines.join("\n"), /Verify/);
	view.handleMouse(mouse(1, { x: 2 }));
	lines = view.render(100);
	assert.doesNotMatch(lines.join("\n"), /\[in progress\] current/);
	assert.match(lines.join("\n"), /Verify/);
	assert.equal(view.handleMouse(mouse(1, { type: "drag" })), undefined);
	assert.equal(view.handleMouse(mouse(1, { shift: true })), undefined);
});

test("all lines of a long objective remain reachable through bounded paging", () => {
	const objective = Array.from({ length: 700 }, (_, i) => `Objective line ${i}: 漢字`).join("\n");
	const data = [["goal", goalWorkSection({ ...goal, objective })]];
	const view = modal(data, plain, 12);
	const collected = new Set();
	for (let page = 0; page < 120; page++) {
		for (const match of view.render(100).join("\n").matchAll(/Objective line (\d+):/g)) collected.add(Number(match[1]));
		view.handleInput("\x1b[6~");
	}
	assert.equal(collected.size, 700);
	view.dispose();
	assert.deepEqual(view.render(100), []);
});

test("wheel scrolling preserves navigation and allows selection in detail text", () => {
	const data = snapshot();
	data[0][1].detail = Array.from({ length: 50 }, (_, i) => `Detail ${i}`).join("\n");
	const view = modal(data, plain, 12);
	let lines = view.render(100);
	assert.match(lines.join("\n"), /Todos|Subagents/);
	assert.equal(view.handleMouse(mouse(2)), undefined);
	assert.equal(view.handleMouse(mouse(2, { type: "wheel", button: "none", wheelDelta: 3 })).handled, true);
	lines = view.render(100);
	assert.match(lines.join("\n"), /Detail 3/);
	assert.doesNotMatch(lines.join("\n"), /Detail 0/);
});

test("updates rewrap and clamp details; disposing retires the modal", () => {
	const data = snapshot();
	data[0][1].detail = "old\n".repeat(200);
	const view = modal(data, plain, 12);
	view.render(80); view.handleInput("\x1b[F");
	data[0][1].detail = "Replacement objective";
	view.update(data);
	assert.match(view.render(20).join("\n"), /Replacement/);
	assert.doesNotMatch(view.render(80).join("\n"), /\bold\b/);
	view.update([]);
	assert.match(view.render(80).join("\n"), /No details available/);
	view.dispose();
	assert.deepEqual(view.render(80), []);
});

test("goal projections preserve pause, completion, blocker and corruption state", () => {
	for (const phase of ["active", "paused", "complete", "blocked"]) {
		const section = goalWorkSection({ ...goal, phase, activation: "disarmed", blockedReason: phase === "blocked" ? { code: "round-limit", message: "Too many rounds\nMore detail" } : undefined });
		assert.match(section.status, new RegExp(phase));
		assert.match(section.detail, /disarmed/);
		assert.doesNotMatch(section.status, /\d+\/\d+/);
		assert.match(section.detail, /Automatic continuations: 3 \(limit 50\)/);
		if (phase === "blocked") assert.match(section.detail, /round-limit: Too many rounds\nMore detail/);
	}
	assert.equal(goalWorkSection(undefined, "bad history").tone, "error");
	assert.equal(goalWorkSection(undefined), undefined);
	assert.equal(todoWorkSection([]), undefined);
	assert.equal(subagentWorkSection([]), undefined);
});

test("terminal controls remain inert and the original objective is unchanged", () => {
	const objective = "title\nnext\x1b[2J\x9b31m\t\u2028end", original = { ...goal, objective };
	const view = modal([["goal", goalWorkSection(original)]]);
	const lines = view.render(200);
	assert.match(lines.join("|"), /next\\u001b\[2J\\u009b31m/);
	for (const line of lines) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
	assert.equal(original.objective, objective);
	assert.equal(safeWorkText("a\r\nb\rc", true), "a\nb\nc");
});
