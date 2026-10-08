import test from "node:test";
import assert from "node:assert/strict";
import { openView, panelViews } from "../src/client/work-views.ts";

test("Work renders each controller once, without terminal summaries and duplicate actions", () => {
	const views = [
		{ id: "work", kind: "work", data: [{ id: "party", detail: "/party" }], actions: [{ id: "party", label: "Manage" }] },
		{ id: "party", kind: "details", data: { items: [{ id: "member" }] } },
		{ id: "plan", kind: "details", data: { items: [{ id: "task" }] } },
		{ id: "config", kind: "details", surface: "settings" },
		{ id: "scope:child/work", kind: "work" },
		{ id: "scope:child/party", kind: "details" },
	];
	assert.deepEqual(panelViews(views, "workspace").map(v => v.id), ["party", "plan", "scope:child/party"]);
	assert.deepEqual(panelViews(views, "view", "config").map(v => v.id), ["config"]);
	assert.deepEqual(panelViews(views, "view", "work"), []);
});

test("Work section navigation targets its structured controller, including child scopes", () => {
	assert.deepEqual(openView("work"), { panel: "workspace", focused: undefined });
	assert.deepEqual(openView("work", "party"), { panel: "workspace", focused: "party" });
	assert.deepEqual(openView("work", "plan"), { panel: "workspace", focused: "plan" });
	assert.deepEqual(openView("scope:child/work", "party"), { panel: "workspace", focused: "scope:child/party" });
	assert.deepEqual(openView("party"), { panel: "workspace", focused: "party" });
	assert.deepEqual(openView("config"), { panel: "view", focused: "config" });
});
