import assert from "node:assert/strict";
import test from "node:test";
import { Transcript } from "../src/host/transcript.ts";
import { mergeMessages } from "../src/client/state.ts";

test("saved tool timing metadata survives projection without replacing the process duration", () => {
	const transcript = new Transcript();
	const project = details => transcript.message({ role: "toolResult", toolName: "read", content: [], details }).tool;
	const timing = { startedAt: 1000, finishedAt: 5300 };
	assert.equal(project({ piMessageTimestamps: timing }).seconds, 4.3);
	assert.equal(project({ piMessageTimestamps: timing, wall_time_seconds: 2 }).seconds, 2);
	assert.equal(project({ piMessageTimestamps: { startedAt: 5300, finishedAt: 1000 } }).seconds, undefined);
	assert.equal(project({ piMessageTimestamps: { startedAt: "1000", finishedAt: 5300 } }).seconds, undefined);
	assert.equal(project({}).seconds, undefined);
});
test("complete patch details omit unprojected extension fields", () => {
	const transcript = new Transcript();
	const message = transcript.message({ role: "toolResult", toolName: "apply_patch", content: [], details: {
		changes: Array.from({ length: 33 }, (_, index) => ({ action: "updated", path: `file-${index}`, diff: "+1 sample", privateCheckpoint: "PRIVATE_DIFF_SENTINEL" })),
	} });
	const full = message.blocks.find(block => block.type === "text" && block.full).full;
	assert.ok(!Buffer.from(transcript.getAsset(full).base64, "base64").toString().includes("PRIVATE_DIFF_SENTINEL"));
});

test("distinct native entries retain separate identities when timestamps collide", () => {
	const transcript = new Transcript();
	const branch = ["a", "b"].map(id => ({ id, type: "message", parentId: null,
		timestamp: new Date(1000).toISOString(), message: { role: "user", timestamp: 1000, content: id } }));
	const page = transcript.history(branch);
	assert.deepEqual(page.messages.map(message => message.id), ["entry:a", "entry:b"]);
	assert.deepEqual(transcript.history(branch).messages.map(message => message.id), page.messages.map(message => message.id));
});

test("native branch order wins over message clocks", () => {
	const transcript = new Transcript();
	const branch = [
		{ id: "u", type: "message", message: { role: "user", timestamp: 1000, content: "question" } },
		{ id: "a", type: "message", message: { role: "assistant", timestamp: 900, content: [{ type: "text", text: "answer" }] } },
	];
	assert.deepEqual(mergeMessages([], transcript.history(branch).messages).map(message => message.role), ["user", "assistant"]);
});
