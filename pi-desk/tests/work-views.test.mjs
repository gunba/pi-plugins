import test from "node:test";
import assert from "node:assert/strict";
import { openView, panelViews } from "../src/client/work-views.ts";

test("Work renders each controller once, without terminal summaries and duplicate actions", () => {
	const views = [
		{ id: "work", kind: "work", data: [{ id: "scheduled", detail: "/schedule cancel <id>" }], actions: [{ id: "scheduled", label: "Cancel" }] },
		{ id: "scheduler", kind: "details", data: { items: [{ id: "reminder" }] } },
		{ id: "plan", kind: "details", data: { items: [{ id: "task" }] } },
		{ id: "config", kind: "details", surface: "settings" },
		{ id: "scope:child/work", kind: "work" },
		{ id: "scope:child/scheduler", kind: "details" },
	];
	assert.deepEqual(panelViews(views, "work").map(v => v.id), ["scheduler", "plan", "scope:child/scheduler"]);
	assert.deepEqual(panelViews(views, "view", "config").map(v => v.id), ["config"]);
	assert.deepEqual(panelViews(views, "view", "work"), []);
});

test("Work section navigation targets its structured controller, including child scopes", () => {
	assert.deepEqual(openView("work"), { panel: "work", focused: undefined });
	assert.deepEqual(openView("work", "scheduled"), { panel: "work", focused: "scheduler" });
	assert.deepEqual(openView("work", "plan"), { panel: "work", focused: "plan" });
	assert.deepEqual(openView("scope:child/work", "scheduled"), { panel: "work", focused: "scope:child/scheduler" });
	assert.deepEqual(openView("config"), { panel: "view", focused: "config" });
});
