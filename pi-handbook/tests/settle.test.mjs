import assert from "node:assert/strict";
import test from "node:test";
import { applyChange, emptyState } from "../src/domain.ts";
import { entryLine, ranked } from "../src/render.ts";
import { commitOps, planReply } from "../src/tidy.ts";

const noon = (day) => new Date(2026, 10, day, 12).getTime();
const change = (state, at, actor, ops) => applyChange(state, { v: 1, at, actor, ops });
const learning = (text) => ({ kind: "learning", text, sources: [] });
const lines = (state) => ranked(state).map(entryLine);

test("a learning the tidy-up rewords is no longer flagged, and one that was waiting is admitted", () => {
	// 12 November, Gunba WoW Addons: the pass reworded flagged l2 and waiting l8, l12 and l14. l2 stayed flagged and out
	// of the prompt, and the three stayed waiting, so the view still listed all four for the user.
	const state = emptyState();
	change(state, noon(9), "tidy", [{ op: "add", id: "l2", entry: learning("The full build takes about 45 minutes."), status: "active" }]);
	change(state, noon(11), "agent", [
		{ op: "add", id: "l8", entry: learning("Since 1.39.24 the full build takes about 1 h 36 min."), status: "pending" },
		{ op: "flag", id: "l2", reason: "The full build takes about 1 h 36 min, not 45." },
	]);
	// A flagged learning stays in the prompt with the agent's reason; a waiting one is not in it yet.
	assert.deepEqual(lines(state), ["- l2: The full build takes about 45 minutes. (Flagged as wrong or out of date: The full build takes about 1 h 36 min, not 45.)"]);

	change(state, noon(12), "tidy", [
		{ op: "edit", id: "l2", text: "The full build took about 45 minutes before 1.39.24." },
		{ op: "edit", id: "l8", text: "At 1.39.24 the full build took about 1 h 36 min." },
	]);
	assert.deepEqual(lines(state), ["- l8: At 1.39.24 the full build took about 1 h 36 min.", "- l2: The full build took about 45 minutes before 1.39.24."]);
	assert.equal(state.entries.get("l2").flag, undefined);
	assert.equal(state.entries.get("l8").status, "active");
});

test("a pass settles every flag and waiting learning its reply leaves out", () => {
	// Until 12 November a flag waited for the user: of five ever made, none was answered and three stayed open.
	const state = emptyState();
	change(state, noon(9), "tidy", [
		{ op: "add", id: "l1", entry: learning("The release script is build.sh"), status: "active" },
		{ op: "add", id: "i1", entry: { kind: "instruction", text: "", quote: "Report in plain sentences.", sources: [] }, status: "active" },
		{ op: "add", id: "i2", entry: { kind: "instruction", text: "", quote: "Use three variants.", sources: [] }, status: "active" },
	]);
	change(state, noon(9), "user", [{ op: "pin", id: "i1", pinned: true }]);
	// An older tidy-up left the user a flag with the replacement it proposed.
	change(state, noon(10), "tidy", [{ op: "flag", id: "i2", reason: "The user asked for one case only.",
		proposal: { kind: "instruction", text: "", quote: "One case only.", sources: ["m"] } }]);
	change(state, noon(11), "agent", [
		{ op: "flag", id: "l1", reason: "It moved to tools/release.sh" },
		{ op: "flag", id: "i1", reason: "Jordan now wants tables." },
		{ op: "add", id: "l2", entry: learning("Builds need 24 GB."), status: "pending" },
	]);
	const asked = noon(12);
	// Noted while the request was out, so the model was not shown it.
	change(state, asked + 1, "agent", [{ op: "add", id: "l3", entry: learning("Routes are baked."), status: "pending" }]);

	const plan = planReply(state, { messages: [], more: false, chars: 0 }, {}, "/", asked);
	change(state, asked + 2, "tidy", commitOps(state, plan.ops, "tidy"));

	const entry = (id) => { const { kind, status, text, quote, flag, replacedBy } = state.entries.get(id); return { kind, status, text, quote, flag, replacedBy }; };
	assert.deepEqual(entry("l1"), { kind: "learning", status: "active", quote: undefined, flag: undefined, replacedBy: undefined,
		text: "The release script is build.sh. Correction of 11 Nov 2026: It moved to tools/release.sh." });
	assert.deepEqual(entry("l2"), { kind: "learning", status: "active", text: "Builds need 24 GB.", quote: undefined, flag: undefined, replacedBy: undefined });
	assert.deepEqual(entry("l3"), { kind: "learning", status: "pending", text: "Routes are baked.", quote: undefined, flag: undefined, replacedBy: undefined });
	// The user pinned it: the flag goes and the words stay.
	assert.deepEqual(entry("i1"), { kind: "instruction", status: "active", text: "", quote: "Report in plain sentences.", flag: undefined, replacedBy: undefined });
	assert.deepEqual(entry("i2"), { kind: "instruction", status: "replaced", text: "", quote: "Use three variants.", flag: undefined, replacedBy: "i3" });
	assert.deepEqual(entry("i3"), { kind: "instruction", status: "active", text: "", quote: "One case only.", flag: undefined, replacedBy: undefined });
});
