import assert from "node:assert/strict";
import test from "node:test";
import { messageWeight, reduceEvents } from "../src/client/state.ts";

test("root message streams and inactive conversation caches stay bounded", () => {
	const sessions = Array.from({ length: 32 }, (_, index) => ({ key: `session-${index}`, ui: { generation: "g" } }));
	let state = { host: { name: "Sample", cwd: "/tmp", sessions }, messages: {}, focused: ["session-0"] };
	const events = (session, count) => Array.from({ length: count }, (_, index) => ({
		type: "worker", key: session, message: {
			type: "chat", generation: "g", message: { id: `entry:${index}`, entryId: String(index),
				order: index, revision: index, role: "assistant", blocks: [{ type: "text", text: "x".repeat(2000) }], timestamp: 0 },
		},
	}));
	state = reduceEvents(state, events("session-0", 500));
	assert.equal(state.messages["session-0"].length, 80);
	assert.equal(state.messages["session-0"].at(-1).entryId, "499");
	for (const session of sessions.slice(1)) state = reduceEvents(state, events(session.key, 100));
	assert.ok(state.messages["session-0"]);
	assert.ok(Object.keys(state.messages).length <= 16);
	assert.ok(Object.values(state.messages).flat().reduce((size, message) => size + messageWeight(message), 0) <= 2_000_000);
});
