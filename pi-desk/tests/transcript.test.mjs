import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptFeed } from "../src/host/transcript-feed.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FEEDBACK_ENTRY } from "../src/shared/feedback.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionMemory from "../../pi-session-memory/extensions/session-memory.ts";
import { PRESENTATION_DISCOVER } from "../../pi-ui/index.ts";

test("a transcript host preserves and restores compacted user bodies without changing model context", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-desk-history-"));
	try {
		for (const released of [false, true]) {
			const manager = SessionManager.create(directory, directory);
			const original = "Earlier request with its original content.";
			const id = manager.appendMessage({ role: "user", content: [{ type: "text", text: original }], timestamp: 1 });
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer" }], timestamp: 2 });
			const kept = manager.appendMessage({ role: "user", content: "Current request", timestamp: 3 });
			manager.appendCompaction("Native summary", kept, 100);
			const archive = readFileSync(manager.getSessionFile());
			const context = structuredClone(manager.buildSessionContext());
			let hosted = !released;
			const hooks = {};
			sessionMemory({
				on: (name, fn) => { hooks[name] = fn; }, registerCommand() {},
				events: { emit: (name, probe) => {
					if (name === PRESENTATION_DISCOVER && hosted) probe.presentation = { version: 2, capabilities: ["transcripts"] };
				} },
			});
			const ctx = { sessionManager: manager, ui: { notify() {} } };
			if (released) { hooks.session_start({}, ctx); assert.deepEqual(manager.getEntry(id).message.content, []); }
			hosted = true;
			hooks.session_start({}, ctx);
			hooks.session_compact({}, ctx);
			const history = new Transcript().history(manager.getBranch());
			assert.deepEqual(history.messages.find(message => message.entryId === id).blocks, [{ type: "text", text: original, truncated: false }]);
			assert.deepEqual(manager.buildSessionContext(), context);
			assert.deepEqual(readFileSync(manager.getSessionFile()), archive);
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("archived UI notices remain in native records but do not reappear in chat", () => {
	const manager = SessionManager.inMemory("/tmp");
	const feedback = { id: "error", text: "The provider failed", level: "error", timestamp: 123, generation: "first-worker" };
	manager.appendMessage({ role: "user", content: "Hello", timestamp: 100 });
	manager.appendCustomEntry(FEEDBACK_ENTRY, feedback);
	manager.appendMessage({ role: "user", content: "Try again", timestamp: 200 });
	const history = new Transcript().history(manager.getBranch());
	assert.deepEqual(history.messages.map(message => message.role), ["user", "note", "user"]);
	assert.deepEqual(history.messages[1].feedback, feedback);
	assert.deepEqual(transcriptRows(history.messages).map(row => row.message.role), ["user", "user"]);
	assert.deepEqual(manager.buildSessionContext().messages.map(message => message.role), ["user", "user"]);
});
import { Transcript } from "../src/host/transcript.ts";
import { mergeMessages } from "../src/client/state.ts";
import { transcriptRows } from "../src/client/transcript-rows.ts";
import { HISTORY_COUNT } from "../src/shared/history.ts";
import { planRoundNotice } from "../src/client/plan-round.ts";
import { renderPlanRoundPrompt } from "../../pi-plan/src/prompt.ts";
import { PLAN_ROUND_MESSAGE } from "../../pi-plan/src/constants.ts";

test("a file tool call and its result form one display row without a separate source-file block", () => {
	const transcript = new Transcript();
	const call = transcript.message({ role: "assistant", content: [{ type: "toolCall", id: "read-skill", name: "read",
		arguments: { path: "SKILL.md" } }] }, "call", undefined, 0, process.cwd());
	const result = transcript.message({ role: "toolResult", toolName: "read", toolCallId: "read-skill",
		content: [{ type: "text", text: "Skill content" }], details: { sourcePath: "SKILL.md", firstLine: 1 } }, "result", undefined, 1, process.cwd());
	assert.equal(call.blocks.length, 1);
	assert.equal(call.blocks[0].file.name, "SKILL.md");
	const rows = transcriptRows([call, result]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].message, call);
	assert.equal(rows[0].results["read-skill"], result);
	assert.equal(result.id, "entry:result");
});

test("trace spacing crosses mixed assistant rows without joining other speakers or prose", () => {
	const transcript = new Transcript();
	const message = (id, role, content) => transcript.message({ role, content }, id);
	const thought = { type: "thinking", thinking: "Inspect the next step." };
	const mixed = message("mixed", "assistant", [{ type: "text", text: "Here is the approach." }, thought,
		{ type: "toolCall", id: "write", name: "write", arguments: { path: "source.ts" } }]);
	const continuation = message("next", "assistant", [thought]);
	const human = message("human", "user", "Continue");
	const answer = message("answer", "assistant", [{ type: "text", text: "Done" }]);
	const rows = transcriptRows([mixed, continuation, human, answer, continuation]);
	assert.equal(rows[0].traceContinues, true);
	assert.equal(rows[1].traceContinues, undefined);
	assert.equal(rows[3].traceContinues, undefined);
	assert.equal(rows[0].message, mixed);
});

test("adjacent thinking messages share a display group without merging native identities", () => {
	const transcript = new Transcript();
	const thought = (id, texts) => transcript.message({ role: "assistant", content: texts.map(thinking => ({ type: "thinking", thinking })) }, id);
	const first = thought("first", ["One", "Two"]), second = thought("second", ["Three"]);
	const speech = transcript.message({ role: "assistant", content: [{ type: "text", text: "Answer" }] }, "speech");
	const third = thought("third", ["Four"]);
	const rows = transcriptRows([first, second, speech, third]);
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[0].thinking.map(message => message.id), ["entry:first", "entry:second"]);
	assert.equal(rows[0].thinking.reduce((count, message) => count + message.blocks.length, 0), 3);
	assert.equal(first.blocks.length, 2);
	assert.equal(second.blocks.length, 1);
	assert.equal(rows[1].thinking, undefined);
	assert.deepEqual(rows[2].thinking, [third]);
});

test("historical scheduled deliveries display their payload and times without changing native context", () => {
	const transcript = new Transcript(), manager = SessionManager.inMemory("/tmp");
	const content = "Automated delivery instructions\n\n<scheduled-message>\nReview the result.\n</scheduled-message>";
	const details = { id: "timer", createdAt: 1000, dueAt: 601000, message: "Review the result.", delivery: "steer" };
	manager.appendCustomMessageEntry("pi-scheduler-scheduled-message", content, true, details);
	const saved = transcript.history(manager.getBranch()).messages[0];
	const live = transcript.message({ role: "custom", customType: "pi-scheduler-scheduled-message", content, details });
	assert.deepEqual(saved.notice, { kind: "schedule", title: "Scheduled message", queuedAt: 1000, dueAt: 601000 });
	assert.deepEqual(saved.notice, live.notice);
	assert.deepEqual(saved.blocks, [{ type: "text", text: details.message, truncated: false }]);
	assert.equal(manager.buildSessionContext().messages[0].content, content);
	assert.equal(transcript.message({ role: "user", content, details }).notice, undefined);
});

test("saved and live party notices retain their type and sender without duplicating the native heading", () => {
	const transcript = new Transcript();
	const content = "Direct message · Reviewer (peer-id)\n\nJoined review-room. Send the evidence when ready.";
	const saved = transcript.entry({ type: "custom_message", id: "notice", customType: "pi-party/message",
		content, display: true, details: { sender: "peer-id" }, timestamp: new Date(1000).toISOString() });
	const live = transcript.message({ role: "custom", customType: "pi-party/message", content, display: true, details: { sender: "peer-id" } });
	assert.deepEqual(saved.notice, { kind: "party", title: "Direct message · Reviewer" });
	assert.deepEqual(live.notice, saved.notice);
	assert.equal(saved.blocks[0].text, "Joined review-room. Send the evidence when ready.");
	assert.equal(transcript.message({ role: "user", content }).notice, undefined);
	const process = transcript.entry({ type: "custom_message", id: "process", customType: "pi-work/wake-v1", display: true,
		content: "Managed process 123 exited with code 0.\n*literal stdout*\nUse write_stdin session_id=123 once.", timestamp: new Date(2000).toISOString() });
	assert.equal(process.notice.kind, "process");
	assert.equal(process.notice.title, "Managed process 123 exited with code 0.");
	assert.equal(process.blocks[0].text, "*literal stdout*\nUse write_stdin session_id=123 once.");
});

test("nested skill reads retain bounded labels without projecting their arguments", () => {
	const transcript = new Transcript();
	const projected = transcript.message({ role: "toolResult", toolName: "codemode", toolCallId: "skills", content: [],
		nestedCalls: { complete: false, calls: [
			{ name: "read", status: "ok", arguments: { path: "/private/skills/browse/SKILL.md", token: "SECRET" } },
			{ name: "read", status: "error", arguments: { path: "C:\\Users\\Example\\skills\\imagegen\\SKILL.md" } },
			{ name: "inspect_files", status: "ok", arguments: { requests: [{ path: "skills/review/SKILL.md" }, { path: "other.md" }] } },
			{ name: "read", status: "unfinished", argumentsBytes: 9999 },
			{ name: "write", status: "ok", arguments: { path: "skills/new/SKILL.md" } },
			{ name: "read", status: "ok", arguments: { path: "skills/new/NOT_SKILL.md" } },
		] } });
	assert.deepEqual(projected.nested.calls.map(call => call.skills), [["browse"], ["imagegen"], ["review"], undefined, undefined, undefined]);
	assert.equal(projected.nested.complete, false);
	assert.equal(projected.nested.calls[1].status, "error");
	assert.doesNotMatch(JSON.stringify(projected), /SECRET|private|Users/);
});

test("nested tool calls stay on their calling result instead of orphaning transcript rows", () => {
	const transcript = new Transcript();
	const feed = new TranscriptFeed(transcript, () => [], () => "generation", () => {}, () => "/tmp");
	try {
		feed.event({ type: "tool_execution_start", toolName: "read", toolCallId: "outer/1", parentToolCallId: "outer", args: { path: "fixture" } });
		feed.event({ type: "tool_execution_end", toolName: "read", toolCallId: "outer/1", parentToolCallId: "outer", isError: false,
			result: { content: [{ type: "text", text: "fixture" }] } });
		assert.deepEqual(feed.history().messages, []);
		const message = transcript.message({ role: "toolResult", toolName: "codemode", toolCallId: "outer", content: [],
			nestedCalls: { complete: false, calls: [{ id: "outer/1", name: "read", status: "ok", durationMs: 12,
				arguments: { token: "private" }, error: "unprojected" }] } });
		assert.deepEqual(message.nested, { complete: false, calls: [{ name: "read", status: "ok", seconds: .012 }] });
	} finally { feed.close(); }
});

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
