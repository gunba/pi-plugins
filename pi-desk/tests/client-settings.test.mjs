import assert from "node:assert/strict";
import test from "node:test";
import { dismissNotice, noticeIdentity, readDismissals } from "../src/client/notice-dismissals.ts";
import { openingMessage, sessionTitle } from "../src/shared/session-title.ts";
import { providerIdentity } from "../src/host/provider-identity.ts";
import { providerChoices } from "../src/host/provider-prompts.ts";
import { conversationFeedback, readFeedback, saveFeedback } from "../src/client/chat-feedback.ts";

test("errors stay at their point in chat, deduplicate saved notices and stay dismissed after reopening", () => {
	const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
	const feedback = { id: "error", text: "Failed operation", level: "error", timestamp: 200, generation: "original-worker" };
	const messages = [100, 300].map((timestamp, order) => ({ id: `message:${order}`, role: "user", timestamp, order,
		revision: 0, blocks: [{ type: "text", text: "Message" }] }));
	const inline = conversationFeedback(messages, [feedback], "one", []);
	assert.deepEqual(inline.map(message => message.timestamp), [100, 200, 300]);
	assert.deepEqual(conversationFeedback(inline, [feedback], "one", []), inline);
	const native = { ...inline[1], id: "entry:error", entryId: "error", order: inline[1].order };
	assert.deepEqual(conversationFeedback([...inline, native], [feedback], "one", []).filter(message => message.feedback), [native]);
	saveFeedback(storage, { one: [feedback] });
	assert.deepEqual(readFeedback(storage).one, [feedback]);
	const hidden = dismissNotice(storage, noticeIdentity("one", feedback.generation, feedback.id));
	assert.deepEqual(conversationFeedback(inline, readFeedback(storage).one, "one", hidden), messages);
	assert.equal(conversationFeedback(inline, [feedback], "two", hidden).length, 3);
	assert.equal(conversationFeedback(messages.slice(1), [feedback], "one", [], { before: "earlier" }).length, 1);
});

test("dismissed notifications survive reopening, without hiding another session's errors", () => {
	const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
	const first = noticeIdentity("one", "generation", "error");
	dismissNotice(storage, first);
	assert.deepEqual(readDismissals(storage), [first]);
	assert.ok(!readDismissals(storage).includes(noticeIdentity("two", "generation", "error")));
	for (let index = 0; index < 600; index++) dismissNotice(storage, String(index));
	assert.equal(readDismissals(storage).length, 512);
});
test("resuming unnamed history uses its opening user text without changing its native name", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", content: "Not the name" } },
		{ type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "  Build\n a calendar " }] } },
		{ type: "message", message: { role: "user", content: "Another message" } },
	];
	assert.equal(sessionTitle(undefined, openingMessage(entries)), "Build a calendar");
	assert.equal(sessionTitle("Calendar project", openingMessage(entries)), "Calendar project");
	assert.equal(sessionTitle(undefined, openingMessage([])), "New conversation");
});
test("model account labels expose identity, not OAuth credentials", () => {
	const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
	const access = jwt({ "https://api.openai.com/profile": { email: "person@example.test" },
		"https://api.openai.com/auth": { chatgpt_account_id: "workspace-1", chatgpt_plan_type: "pro" } });
	assert.equal(providerIdentity({ type: "oauth", access, refresh: "SECRET" }), "person@example.test · pro · Account workspace-1");
	assert.equal(providerIdentity({ type: "api_key", key: "SECRET" }), undefined);
	assert.equal(providerIdentity({ type: "oauth", access: "opaque", refresh: "SECRET" }), undefined);
	assert.equal(providerIdentity({ type: "oauth", accountId: "workspace-2" }), "Account workspace-2");
});
test("remote OAuth choices use human labels and return Pi's original option IDs", () => {
	const choices = providerChoices({ message: "Sign in", options: [
		{ id: "browser", label: "Browser sign-in" }, { id: "device-code", label: "Device code" },
	] });
	assert.equal(choices.form.options[0].title, "Device code");
	assert.match(choices.form.context, /computer running Pi/);
	assert.equal(choices.resolve("Device code"), "device-code");
	assert.equal(choices.resolve("Browser sign-in"), "browser");
	assert.equal(choices.resolve("unknown"), undefined);
});
