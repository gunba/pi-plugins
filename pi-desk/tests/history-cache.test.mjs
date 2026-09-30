import assert from "node:assert/strict";
import test from "node:test";
import { isActivityOnly, messageWeight, reduceEvents } from "../src/client/state.ts";

test("activity classification tolerates streaming gaps without changing native block indexes", () => {
	const event = message => ({ type: "worker", key: "session", message: { generation: "g", ...message } });
	for (const kind of ["text", "thinking"]) {
		let state = { host: { sessions: [{ key: "session", ui: { generation: "g" } }] }, messages: {} };
		state = reduceEvents(state, [event({ type: "chat", message: { id: "live:stream", revision: 1,
			order: 0, role: "assistant", timestamp: 0, blocks: [], complete: false } })]);
		assert.equal(isActivityOnly(state.messages.session[0]), false);
		for (const revision of [2, 3]) {
			state = reduceEvents(state, [event({ type: "delta", id: "live:stream", revision,
				index: 1, kind, text: "partial" })]);
			const message = state.messages.session[0];
			assert.equal(message.blocks[0], undefined);
			assert.equal(message.blocks[1].text, revision === 2 ? "partial" : "partialpartial");
			assert.equal(isActivityOnly(message), kind === "thinking");
			assert.equal(isActivityOnly({ ...message, role: "user" }), false);
		}
		state = reduceEvents(state, [event({ type: "block", id: "live:stream", revision: 4, index: 0,
			block: { type: "toolCall", id: "call", name: "read", arguments: "{}" } })]);
		assert.equal(state.messages.session[0].blocks[0].type, "toolCall");
		assert.equal(state.messages.session[0].blocks[1].text, "partialpartial");
		assert.equal(isActivityOnly(state.messages.session[0]), kind === "thinking");
	}
});

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
