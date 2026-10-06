import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DotAuth } from "../src/host/dot-auth.ts";

const jwt = (accountId, userId, email) => `fixture.${Buffer.from(JSON.stringify({
	exp: Math.floor(Date.now() / 1000) + 3600,
	"https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: userId },
	"https://api.openai.com/profile": { email },
})).toString("base64url")}.fixture`;
function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "desk-dot-auth-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "dot-auth.json");
	writeFileSync(path, JSON.stringify({ "openai-codex": { type: "oauth", access: "expired-fixture", refresh: "fixture", expires: 0 } }));
	return { directory, path };
}

test("Dot resolves its selected OAuth login without using agent account defaults", async t => {
	const { directory, path } = fixture(t);
	const other = join(directory, "auth.json"), original = JSON.stringify({ "openai-codex": { type: "oauth", access: jwt("agent-account", "agent-user", "agent@example.test"), refresh: "other", expires: 0 } });
	writeFileSync(other, original);
	let creates = 0, resolves = 0;
	const auth = new DotAuth(path, undefined, async options => {
		creates++; assert.equal(options.authPath, path); assert.equal(options.modelsPath, null);
		assert.equal(options.refreshOnCreate, false); assert.equal(options.allowModelNetwork, false);
		return { getAuth: async provider => {
			resolves++; assert.equal(provider, "openai-codex");
			return { auth: { apiKey: jwt("dot-account", "dot-user", "dot@example.test") } };
		} };
	});
	const first = await auth.authorize();
	assert.deepEqual(first.identity, { accountId: "dot-account", userId: "dot-user", accountUserId: "dot-user", email: "dot@example.test" });
	await auth.authorize();
	assert.equal(creates, 1); assert.equal(resolves, 2);
	assert.equal(readFileSync(other, "utf8"), original);
});

test("Dot does not silently follow a saved login into another account", async t => {
	const { path } = fixture(t);
	let token = jwt("dot-account", "dot-user", "dot@example.test");
	const auth = new DotAuth(path, { accountId: "dot-account", userId: "dot-user" }, async () => ({ getAuth: async () => ({ auth: { apiKey: token } }) }));
	await auth.authorize();
	token = jwt("agent-account", "agent-user", "agent@example.test");
	await assert.rejects(auth.authorize(), /saved Dot account changed/);
});
