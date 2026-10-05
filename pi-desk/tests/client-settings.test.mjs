import assert from "node:assert/strict";
import test from "node:test";
import { dismissNotice, noticeIdentity, readDismissals } from "../src/client/notice-dismissals.ts";
import { openingMessage, sessionTitle } from "../src/shared/session-title.ts";
import { providerIdentity } from "../src/host/provider-identity.ts";
import { conversationFeedback, readFeedback, saveFeedback } from "../src/client/chat-feedback.ts";
import { deskStatus, dismissDeskStatus, reportDeskError, subscribeDeskStatus } from "../src/client/desk-status.ts";

test("Desk storage errors use one transient status and do not become conversation feedback", () => {
	const browser = { id: "browser", text: "InvalidStateError: database connection is closing", level: "error", timestamp: 100, generation: "browser" };
	const native = { ...browser, id: "native", text: "Tool failed", generation: "worker" };
	const storage = { getItem: () => JSON.stringify({ one: [browser, native] }) };
	assert.deepEqual(readFeedback(storage).one, [native]);
	assert.deepEqual(conversationFeedback([], [browser, native], "one", []).map(message => message.feedback.id), ["native"]);
	let notifications = 0;
	const unsubscribe = subscribeDeskStatus(() => notifications++);
	try {
		reportDeskError(browser.text);
		const status = deskStatus();
		assert.equal(status.text, "Local draft storage is temporarily unavailable.");
		assert.ok(status.expires > Date.now());
		reportDeskError(browser.text);
		assert.equal(deskStatus(), status);
		assert.equal(notifications, 1);
		dismissDeskStatus(status.id);
		assert.equal(deskStatus(), undefined);
	} finally { unsubscribe(); }
});

test("account picker distinguishes unavailable and changing selection from default credentials", async () => {
	const { build } = await import("esbuild");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const { createRequire } = await import("node:module");
	const directory = mkdtempSync(join(tmpdir(), "desk-account-picker-"));
	try {
		const outfile = join(directory, "fixture.cjs");
		await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx", contents: `
			import React from "react";
			import { renderToStaticMarkup } from "react-dom/server";
			import { ProviderAccountsPanel } from "./src/client/provider-accounts.tsx";
			export const render = session => renderToStaticMarkup(<ProviderAccountsPanel host={{name:"Fixture",sessions:[]}}
				session={session} connected={true} busy={false} invoke={async()=>{throw Error('No account action');}}/>);
		` }, outfile, bundle: true, platform: "node", format: "cjs", jsx: "automatic", plugins: [{ name: "offline-connection", setup(builder) {
			builder.onResolve({ filter: /connection\.ts$/ }, () => ({ path: "connection", namespace: "fixture" }));
			builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function api() { throw Error('No network'); }", loader: "js" }));
		} }] });
		const { render } = createRequire(import.meta.url)(outfile);
		const queue = { steering: { count: 0 }, followUp: { count: 0 } };
		const absent = render({ key: "fixture", state: "closed" });
		assert.match(absent, /value="" selected="">Account selection unavailable/);
		assert.doesNotMatch(absent, /value="pi" selected=""/);
		const confirmed = render({ key: "fixture", state: "ready", snapshot: { accounts: {}, queue } });
		assert.match(confirmed, /value="pi" selected=""/);
		const changing = render({ key: "fixture", state: "ready", snapshot: { accounts: {}, queue }, controls: [{ kind: "account", state: "running" }] });
		assert.match(changing, /value="" selected="">Changing account…/);
		assert.doesNotMatch(changing, /value="pi" selected=""/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

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
