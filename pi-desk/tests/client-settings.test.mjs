import assert from "node:assert/strict";
import test from "node:test";
import { dismissNotice, noticeIdentity, readDismissals } from "../src/client/notice-dismissals.ts";
import { openingMessage, sessionTitle } from "../src/shared/session-title.ts";
import { providerIdentity } from "../src/host/provider-identity.ts";
import { providerChoices } from "../src/host/provider-prompts.ts";

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
