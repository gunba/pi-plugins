import assert from "node:assert/strict";
import test from "node:test";
import { applySessionChanges, applyStateChanges, sessionChanges, stateChanges } from "../src/shared/session-patch.ts";

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

test("compact changes leave out an unchanged order, send a changed item as its changes, and state as changes", () => {
	// With 160 agent views, every change resent 7 KB of view ids; every state event resent every conversation (635 KB).
	const views = Array.from({ length: 160 }, (_, index) => ({ id: `agent:${index}`, kind: "details", data: { items: [{ id: "a", text: "x".repeat(200) }] } }));
	const before = { key: "a", ui: { views: [{ id: "work", kind: "work", revision: 1, data: [{ id: "plan", summary: "s".repeat(500), status: "1/3" }] }, ...views] } };
	const after = structuredClone(before); after.ui.views[0].revision = 2; after.ui.views[0].data[0].status = "2/3";
	const changes = sessionChanges(before, after, [], true);
	assert.deepEqual(applySessionChanges(before, changes), after);
	assert.ok(JSON.stringify(changes).length < 200, JSON.stringify(changes));
	const reordered = structuredClone(after); reordered.ui.views.reverse();
	assert.deepEqual(applySessionChanges(after, sessionChanges(after, reordered, [], true)), reordered);
	assert.deepEqual(sessionChanges(before, after).find(change => change.path.join(".") === "ui.views").ids.length, 161, "browsers without compact changes get the old form");

	const other = { key: "b", ui: { views: [] } }, state = { name: "cachyos", parties: [{ id: "p", members: 3 }], sessions: [before, other] };
	const next = { name: "cachyos", parties: [{ id: "p", members: 4 }], sessions: [after, other, { key: "c", ui: { views: [] } }] };
	const sent = new Map(state.sessions.map(session => [session.key, session]));
	const patch = stateChanges(state, next, sent);
	assert.deepEqual(applyStateChanges(state, JSON.parse(JSON.stringify(patch)), sent), next);
	assert.deepEqual(Object.keys(patch.added), ["c"]); assert.deepEqual(Object.keys(patch.changed), ["a"]);
	assert.ok(JSON.stringify(patch).length < JSON.stringify(next).length / 50);
});
