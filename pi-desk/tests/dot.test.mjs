import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { dotMessages } from "../src/host/dot.ts";
import { DOT_NATIVE } from "../src/host/dot-native.ts";

const items = [
	{ id: "one", role: "user", self: true, senderName: "Owner", createdAt: "2026-10-03T00:00:00Z", text: "Hello" },
	{ id: "two", role: "user", senderAeonId: "dot", senderName: "Dot", createdAt: "2026-10-03T00:00:01Z", text: "Ready." },
];
test("Dot authors use native identity when both transport roles are user", () => {
	assert.deepEqual(dotMessages(items, "dot").map(message => [message.author, message.text]), [["owner", "Hello"], ["dot", "Ready."]]);
});
test("Dot reads native messaging state without replaying the challenged request client", () => {
	let requests = 0;
	const room = { id: "room", aeon_id: "dot", name: "Dot" };
	const cached = { messages: [...items, { ...items[0], id: "provisional", deliveryState: "pending" }], cursors: { before: "cursor" } };
	const props = { room, services: {
		conversations: { get: id => { assert.equal(id, "room"); return cached; } },
		composer: { state: { getSnapshot: () => ({ uploads: [], drafts: new Map() }) } },
	} };
	const node = { hasAttribute: () => true, __reactFiberTest: { memoizedProps: props } };
	const window = { __piDeskDot: { request: { safeGet: () => { requests++; throw Error("cloudflare_challenge"); } } } };
	runInNewContext(DOT_NATIVE, { window, document: { querySelectorAll: selector => selector === "[data-message-id]" ? [node] : [] }, location: { pathname: "/dots/thread" } });
	const state = window.__piDeskDotNative.snapshot();
	assert.equal(state.dot, "dot"); assert.equal(state.before, "cursor"); assert.equal(requests, 0);
	assert.equal(dotMessages(state.messages, state.dot).length, 2);
});

test("native picker paths preserve the attachment basename and lost handoffs remain durable", async () => {
	const { DotConnection } = await import("../src/host/dot.ts");
	const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join, basename } = await import("node:path");
	const { randomUUID } = await import("node:crypto");
	const directory = mkdtempSync(join(tmpdir(), "pi-dot-file-"));
	const dot = new DotConnection(directory, directory), id = randomUUID();
	try {
		dot.files.create(id, "fixture-dot", "report.csv", "text/csv", 3);
		dot.files.append(id, 0, Buffer.from("a,b").toString("base64"));
		assert.equal(basename(dot.files.path(id)), "report.csv");
		dot.snapshot = { state: "ready", id: "fixture-dot", messages: [], inputs: [] };
		let calls = 0;
		dot.surface = { id: "fixture-surface", chooseFiles: async paths => {
			calls++; assert.equal(paths[0], dot.files.path(id)); assert.equal(dot.files.get(id).state, "uploading");
			throw Error("Fixture lost acknowledgement");
		}, close: async () => {} };
		await assert.rejects(dot.surfaceFiles("fixture-surface", [id]), /lost acknowledgement/);
		assert.equal(dot.files.get(id).state, "unknown");
		await assert.rejects(dot.surfaceFiles("fixture-surface", [id]), /needs review/); assert.equal(calls, 1);
		await dot.closeSurface(); assert.equal(existsSync(dot.files.path(id)), true);
		const restored = new DotConnection(directory, directory);
		assert.equal(restored.files.get(id).state, "unknown"); await restored.close();
	} finally { await dot.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("cancelling an unconfirmed Dot send fences late admission across restart", async () => {
	const { DotConnection } = await import("../src/host/dot.ts");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { randomUUID } = await import("node:crypto");
	const directory = mkdtempSync(join(tmpdir(), "pi-dot-admission-")), id = randomUUID();
	const dot = new DotConnection(directory, directory);
	try {
		assert.equal(dot.input(id), undefined);
		const cancelled = dot.cancelInput(id, "fixture-dot", "fixture message", []);
		assert.equal(cancelled.state, "not-sent");
		assert.deepEqual(dot.send(id, "fixture-dot", "fixture message", []), cancelled);
		const restored = new DotConnection(directory, directory);
		assert.deepEqual(restored.send(id, "fixture-dot", "fixture message", []), cancelled);
		assert.throws(() => restored.send(id, "fixture-dot", "different message", []), /different input/);
		await restored.close();
	} finally { await dot.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Dot scripts do not run after their renderer leaves ChatGPT", async () => {
	const { DotBrowser } = await import("../src/host/dot-browser.ts");
	const browser = new DotBrowser("/unused"), context = { location: { origin: "https://example.test" }, window: {} };
	browser.call = async (method, params) => {
		assert.equal(method, "Runtime.evaluate");
		try { return { result: { value: await runInNewContext(params.expression, context) } }; }
		catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
	};
	await assert.rejects(browser.evaluate("window.changed = true"), /left ChatGPT/);
	assert.equal(context.window.changed, undefined);
	context.location.origin = "https://chatgpt.com";
	assert.equal(await browser.evaluate("window.changed = true"), true);
});

test("native downloads capture both programmatic and visible blob links", async () => {
	const { DOT_DOWNLOADS } = await import("../src/host/dot-downloads.ts");
	const { randomUUID } = await import("node:crypto");
	const handlers = new Map(); let nativeClicks = 0, urls = 0;
	class Anchor { href = ""; download = ""; hasAttribute(name) { return name === "download"; } click() { nativeClicks++; } }
	const context = { window: {}, URL: { createObjectURL: () => `blob:fixture/${++urls}`, revokeObjectURL() {} },
		HTMLAnchorElement: Anchor, document: { addEventListener: (name, handler) => handlers.set(name, handler) },
		Blob, WeakRef, Map, Date, crypto: { randomUUID }, Uint8Array, btoa };
	runInNewContext(DOT_DOWNLOADS, context);
	const api = context.window.__piDeskDotDownloads;
	const anchor = new Anchor(); anchor.href = context.URL.createObjectURL(new Blob(["fixture bytes"], { type: "text/plain" })); anchor.download = "report.txt";
	anchor.click(); assert.equal(nativeClicks, 0);
	let file = api.list()[0]; assert.equal(file.name, "report.txt");
	assert.equal(Buffer.from((await api.chunk(file.id, 0)).data, "base64").toString(), "fixture bytes"); api.remove(file.id);
	let prevented = false;
	assert.equal(typeof handlers.get("click"), "function");
	handlers.get("click")({ composedPath: () => [anchor], preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
	assert.equal(prevented, true); assert.equal(api.list().length, 1);
});

test("closing Dot leaves a repurposed browser tab open", async () => {
	const { DotBrowser } = await import("../src/host/dot-browser.ts");
	for (const [url, owned] of [["https://example.test/", false], ["https://chatgpt.com/c/other", false], ["https://chatgpt.com/dots/fixture", true]]) {
		const browser = new DotBrowser("/unused"), calls = []; let disconnected = false;
		browser.target = "fixture-target"; browser.socket = { readyState: 1, close() { disconnected = true; } };
		browser.call = async method => { calls.push(method); return { targetInfo: { url } }; };
		await browser.close(); assert.equal(calls.includes("Target.closeTarget"), owned); assert.equal(disconnected, true);
	}
});

test("native pointer and printable key events preserve desktop input semantics", async () => {
	const { DotSurface } = await import("../src/host/dot-surface.ts");
	const { randomUUID } = await import("node:crypto");
	const calls = [], browser = { validateDot: async () => {}, call: async (method, params) => { calls.push({ method, params }); } };
	const surface = new DotSurface(browser, false, "fixture-dot", "computer");
	surface.frame.image = "fixture";
	await surface.input(randomUUID(), 1024, 800, { kind: "key", key: "A", code: "KeyA", modifiers: 8 });
	assert.equal(calls[0].params.type, "keyDown"); assert.equal(calls[0].params.text, "A"); assert.equal(calls[1].params.type, "keyUp");
	await surface.input(randomUUID(), 1024, 800, { kind: "pointer", phase: "down", x: 20, y: 20, button: "left", count: 2, modifiers: 0 });
	await surface.input(randomUUID(), 1024, 800, { kind: "pointer", phase: "up", x: 20, y: 20, button: "left", count: 2, modifiers: 0 });
	assert.equal(calls[2].params.clickCount, 2); assert.equal(calls[3].params.clickCount, 2);
});
