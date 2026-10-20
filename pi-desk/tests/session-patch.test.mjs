import assert from "node:assert/strict";
import test from "node:test";
import { applySessionChanges, sessionChanges } from "../src/shared/session-patch.ts";

test("a conversation's change crosses the relay as only what changed, and rebuilds the same conversation", () => {
	// Every change resent the whole entry, about 100 KB of mostly unchanged tool definitions and views.
	const tools = Array.from({ length: 98 }, (_, index) => ({ name: `tool_${index}`, description: "A tool description of a typical length, ".repeat(5) }));
	const before = { key: "a", state: "ready", error: "old error", snapshot: { activity: "running", tools, usage: { tokens: 10 } },
		ui: { generation: "g", views: [{ id: "plan", kind: "details", data: { items: [1, 2] } }, { id: "messages", kind: "details", data: { items: Array(400).fill("message") } }] } };
	const after = structuredClone(before);
	after.snapshot.activity = "idle"; after.snapshot.usage.tokens = 12; delete after.error;
	after.ui.views[0].data.items.push(3);
	const changes = sessionChanges(before, after);
	assert.deepEqual(applySessionChanges(before, changes), after);
	assert.ok(JSON.stringify(changes).length < JSON.stringify(after).length / 50, "a small change is small");
	const views = changes.find(change => change.path.join(".") === "ui.views");
	assert.deepEqual(views.ids, ["plan", "messages"]);
	assert.deepEqual(Object.keys(views.items), ["plan"], "only the view that changed is sent");
	assert.equal(applySessionChanges(before, changes).snapshot.tools, before.snapshot.tools, "unchanged parts are shared, not copied");
	assert.deepEqual(sessionChanges(after, after), []);
	// Views reordered, one removed and one added.
	const reordered = structuredClone(after); reordered.ui.views = [{ id: "work", kind: "work" }, after.ui.views[1]];
	assert.deepEqual(applySessionChanges(after, sessionChanges(after, reordered)), reordered);
	assert.throws(() => applySessionChanges({ ui: { views: [] } }, [{ path: ["ui", "views"], ids: ["missing"], items: {} }]), /never received/);
});
