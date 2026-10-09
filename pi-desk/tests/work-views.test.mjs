import test from "node:test";
import assert from "node:assert/strict";
import { openView, panelViews } from "../src/client/work-views.ts";

test("Work renders each controller once, without terminal summaries and duplicate actions", () => {
	const views = [
		{ id: "work", kind: "work", data: [{ id: "messages", detail: "/inbox" }], actions: [{ id: "messages", label: "Manage" }] },
		{ id: "messages", kind: "details", data: { items: [{ id: "member" }] } },
		{ id: "plan", kind: "details", data: { items: [{ id: "task" }] } },
		{ id: "config", kind: "details", surface: "settings" },
		{ id: "scope:child/work", kind: "work" },
		{ id: "scope:child/messages", kind: "details" },
	];
	assert.deepEqual(panelViews(views, "workspace").map(v => v.id), ["messages", "plan", "scope:child/messages"]);
	assert.deepEqual(panelViews(views, "view", "config").map(v => v.id), ["config"]);
	assert.deepEqual(panelViews(views, "view", "work"), []);
});

test("Work section navigation targets its structured controller, including child scopes", () => {
	assert.deepEqual(openView("work"), { panel: "workspace", focused: undefined });
	assert.deepEqual(openView("work", "messages"), { panel: "workspace", focused: "messages" });
	assert.deepEqual(openView("work", "plan"), { panel: "workspace", focused: "plan" });
	assert.deepEqual(openView("scope:child/work", "messages"), { panel: "workspace", focused: "scope:child/messages" });
	assert.deepEqual(openView("messages"), { panel: "workspace", focused: "messages" });
	assert.deepEqual(openView("config"), { panel: "view", focused: "config" });
});
