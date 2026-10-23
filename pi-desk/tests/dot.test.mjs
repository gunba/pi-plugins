import assert from "node:assert/strict";
import test from "node:test";
import { dotEntry } from "../src/host/dot-wire.ts";

test("disconnected Dot offers its connection controls in the conversation", async () => {
	const { build } = await import("esbuild");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const { createRequire } = await import("node:module");
	const directory = mkdtempSync(join(tmpdir(), "desk-dot-connection-"));
	try {
		const outfile = join(directory, "fixture.cjs");
		await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx", contents: `
			import React from "react";
			import { renderToStaticMarkup } from "react-dom/server";
			import { DotConversation } from "./src/client/dot-conversation.tsx";
			const dot = { id: "pc", online: true, loaded: true, ready: false, busy: false, status: "Not connected", error: "",
				computers: [{id:"pc", name:"Fixture computer", connected:true}],
				view: {state:"unavailable", name:"Dot", error:"Session with given id not found.", messages:[], inputs:[]},
				messages:[], optimistic:[], files:[], filesReady:true, draft:"" };
			export const html = renderToStaticMarkup(<DotConversation dot={dot} openNavigation={() => {}}/>);
		` }, outfile, bundle: true, platform: "node", format: "cjs", jsx: "automatic",
			plugins: [{ name: "offline-connection", setup(builder) {
				builder.onResolve({ filter: /connection\.ts$/ }, () => ({ path: "connection", namespace: "fixture" }));
				builder.onResolve({ filter: /surfaces\.tsx$/ }, () => ({ path: "surfaces", namespace: "fixture" }));
				builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "surfaces"
					? "export function Modal({children}) { return children; }"
					: "export class ApiError extends Error {} export function api() { throw Error('No network'); }", loader: "js" }));
			} }] });
		const { html } = createRequire(import.meta.url)(outfile);
		assert.match(html, /aria-label="Dot connection computer"/);
		assert.match(html, />Connect Dot</);
		assert.match(html, /No ChatGPT window is needed/);
		assert.match(html, /uses Pi(?:'|&#x27;)s ChatGPT login/);
		assert.doesNotMatch(html, /Chrome’s ChatGPT sign-in|opens a background tab/);
		assert.doesNotMatch(html, /Session with given id not found/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

const items = [
	{ id: "one", role: "user", self: true, senderName: "Owner", createdAt: "2026-10-03T00:00:00Z", text: "Hello" },
	{ id: "two", role: "user", senderAeonId: "dot", senderName: "Dot", createdAt: "2026-10-03T00:00:01Z", text: "Ready." },
];
test("Dot authors use native identity when both transport roles are user", () => {
	const room = { id: "room", dot: "dot", name: "Dot", members: [{ id: "owner" }, { id: "bot", dot: "dot" }] };
	const messages = items.map(item => dotEntry({ id: item.id, role: item.role, account_user_id: item.self ? "owner" : "bot",
		created_at: item.createdAt, content: { text: item.text } }, room, { accountUserId: "owner" }).message);
	assert.deepEqual(messages.map(message => [message.author, message.text]), [["owner", "Hello"], ["dot", "Ready."]]);
});
test("cancelling an unconfirmed Dot send fences late admission across restart", async () => {
	const { DotConnection } = await import("../src/host/dot.ts");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { randomUUID } = await import("node:crypto");
	const directory = mkdtempSync(join(tmpdir(), "pi-dot-admission-")), id = randomUUID();
	const dot = new DotConnection(directory);
	try {
		assert.equal(await dot.input(id), undefined);
		const cancelled = dot.cancelInput(id, "fixture-dot", "fixture message", []);
		assert.equal(cancelled.state, "not-sent");
		assert.deepEqual(dot.send(id, "fixture-dot", "fixture message", []), cancelled);
		const restored = new DotConnection(directory);
		assert.deepEqual(restored.send(id, "fixture-dot", "fixture message", []), cancelled);
		assert.throws(() => restored.send(id, "fixture-dot", "different message", []), /different input/);
		await restored.close();
	} finally { await dot.close(); rmSync(directory, { recursive: true, force: true }); }
});
