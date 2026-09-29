import assert from "node:assert/strict";
import test from "node:test";
import { Transcript } from "../src/host/transcript.ts";
import { mergeMessages } from "../src/client/state.ts";
import { HISTORY_COUNT } from "../src/shared/history.ts";
import { planRoundNotice } from "../src/client/plan-round.ts";
import { renderPlanRoundPrompt } from "../../pi-plan/src/prompt.ts";
import { PLAN_ROUND_MESSAGE } from "../../pi-plan/src/constants.ts";

test("live and saved plan rounds have a readable notice without changing the native prompt", () => {
	const transcript = new Transcript();
	const plan = { id: "plan-test", revision: 3, objective: 'Check the "calendar"\nlayout', maxRounds: 128,
		steps: [{ content: "Check keyboard navigation", status: "in_progress" }] };
	for (const steps of [plan.steps, []]) {
		const content = renderPlanRoundPrompt({ ...plan, steps }, 4);
		const live = transcript.message({ role: "custom", customType: PLAN_ROUND_MESSAGE, content, display: true });
		const saved = transcript.entry({ type: "custom_message", id: "round", timestamp: new Date(1000).toISOString(),
			customType: PLAN_ROUND_MESSAGE, content, display: true });
		for (const message of [live, saved]) {
			assert.equal(message.blocks[0].text, content);
			assert.deepEqual(planRoundNotice(message), { objective: plan.objective, round: 4, maxRounds: 128 });
		}
	}
});

test("plan display leaves ordinary markup, incomplete previews and malformed envelopes alone", () => {
	const content = renderPlanRoundPrompt({ id: "plan-test", revision: 1, objective: "Calendar", maxRounds: 8, steps: [] }, 2);
	const note = { role: "note", blocks: [{ type: "text", text: content }] };
	for (const role of ["user", "assistant", "tool"]) assert.equal(planRoundNotice({ ...note, role }), undefined);
	for (const text of [
		`Example: ${content}`, `\`\`\`\n${content}\n\`\`\``, `${content}\nAnother note`,
		content.replace("</plan_round>", ""), content.replace('"Calendar"', "not-json"),
		content.replace("2/8", "2/0"), content.replace("2/8", "9/8"),
		content.replace("2/8", "9007199254740992/9007199254740993"),
	]) assert.equal(planRoundNotice({ ...note, blocks: [{ type: "text", text }] }), undefined);
	assert.equal(planRoundNotice({ ...note, blocks: [{ ...note.blocks[0], truncated: true }] }), undefined);
	assert.equal(planRoundNotice({ ...note, blocks: [{ ...note.blocks[0], full: "asset" }] }), undefined);
	assert.equal(planRoundNotice({ ...note, blocks: [...note.blocks, { type: "image", asset: "image" }] }), undefined);
});

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

test("opening the tail does not inspect the entire conversation", () => {
	const entries = Array.from({ length: 10_000 }, (_, order) => ({ id: String(order), type: "message",
		message: { role: "user", content: `Message ${order}`, timestamp: 0 } }));
	const branch = new Proxy(entries, { get(target, key, receiver) {
		if (/^\d+$/.test(String(key)) && Number(key) < entries.length - HISTORY_COUNT - 1)
			assert.fail("The latest page must not walk old entries.");
		return Reflect.get(target, key, receiver);
	} });
	const page = new Transcript().history(branch);
	assert.equal(page.messages.length, HISTORY_COUNT);
	assert.equal(page.before, String(entries.length - HISTORY_COUNT));
	assert.equal(page.after, undefined);
});

test("history pages cross hidden entries without gaps or false continuation links", () => {
	const branch = [{ id: "root", type: "model_change" }];
	for (let i = 0; i < 95; i++) branch.push(
		{ id: `m${i}`, type: "message", message: { role: "user", content: String(i) } },
		{ id: `hidden${i}`, type: "custom_message", display: false, content: "hidden" });
	const transcript = new Transcript(), tail = transcript.history(branch);
	const middle = transcript.history(branch, { before: tail.before });
	const first = transcript.history(branch, { before: middle.before });
	assert.deepEqual([...first.messages, ...middle.messages, ...tail.messages].map(m => m.entryId),
		Array.from({ length: 95 }, (_, i) => `m${i}`));
	assert.equal(first.before, undefined);
	assert.equal(tail.after, undefined);
	assert.deepEqual(transcript.history(branch, { after: first.after }).messages.map(m => m.entryId),
		Array.from({ length: 40 }, (_, i) => `m${i + 15}`));
	assert.equal(transcript.history(branch, { from: "m94" }).after, undefined);
	assert.throws(() => transcript.history(branch, { from: "hidden94" }), /no longer exists/);
});
