import assert from "node:assert/strict";
import test from "node:test";
import { arrived } from "../src/client/outgoing.ts";

const user = (order, text) => ({ id: "m" + order, order, revision: 0, role: "user", blocks: [{ type: "text", text }], timestamp: 0 });
const outgoing = (text, ahead, queued) => ({ id: text, session: "s", draft: text, after: 10, queued, ahead, message: user(Number.MAX_SAFE_INTEGER, text) });
const session = { key: "s", state: "ready", snapshot: { queue: { steering: { count: 0, previews: [] }, followUp: { count: 0, previews: [] } } } };

test("messages that reach the agent joined into one are no longer shown as on their way, nor are those sent after them", () => {
	// 23 November 2026, Moodle on the work laptop: two messages sent 22 s apart reached the agent as one at 13:03, but the
	// second stayed at the end of the conversation as on its way. At 13:28 Jordan stopped the agent and sent it again,
	// and the messages he sent then stayed there too.
	const first = outgoing("Otherwise, take a crack at the ticket allocations.", 0, 0), second = outgoing("And also prepare a meeting notes one pager.", 1, 1);
	const joined = [user(11, "Otherwise, take a crack at the ticket allocations.\n\nAnd also prepare a meeting notes one pager.")];
	assert.equal(arrived(first, session, joined), true);
	assert.equal(arrived(second, session, joined), true);
	const next = outgoing("Continue", 2, 0);
	assert.equal(arrived(next, session, joined), false, "not until the conversation shows it");
	assert.equal(arrived(next, session, [...joined, user(12, "Continue")]), true);
	assert.equal(arrived(outgoing("prepare a meeting", 2, 0), session, joined), false, "part of a paragraph is not the message");
});
