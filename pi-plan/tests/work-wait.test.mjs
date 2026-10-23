import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, executeTool } from "./helpers.mjs";
import { WATCH_CHANGED } from "../../pi-watch/index.ts";
import { PLAN_ROUND_MESSAGE } from "../src/constants.ts";

test("automatic plans never spend rounds while a watch is active, and continue when the last one ends", async () => {
	const h = createExtensionHarness({ idle: false }); await h.start();
	const watching = globalThis[Symbol.for("gunba.pi-watch.v1")], id = h.ctx.sessionManager.getSessionId();
	await executeTool(h, "create_plan", { objective: "finish real work", auto_continue: true });
	watching.set(id, 1);
	h.setIdle(true);
	for (let i = 0; i < 4; i++) await h.emit("agent_settled");
	assert.equal(h.sentMessages.length, 0);
	watching.delete(id);
	h.events.emit(WATCH_CHANGED, { sessionId: id, count: 0 });
	assert.equal(h.sentMessages.filter(item => item.message.customType === PLAN_ROUND_MESSAGE).length, 1);
	await h.emit("session_shutdown");
});
