import assert from "node:assert/strict";
import test from "node:test";
import { capAnthropicImages, OMITTED_IMAGE_NOTE, withoutImages } from "../extensions/image-budget.ts";

test("a Claude request over 32 MB has its oldest images removed from the saved conversation once", async () => {
	// Work PC, 15 October: 57 images, 67 MB of base64; Anthropic refused every request and the SDK reported
	// only "Connection error."
	const entries = Array.from({ length: 57 }, (_, index) => ({ sourceEntry: { id: `entry-${index}` }, messages: [{ role: "toolResult", toolName: "view_image",
		content: [{ type: "text", text: `Viewed image ${index}` }, { type: "image", mimeType: "image/png", data: `${index}:`.padEnd(1_174_000, "x") }] }] }));
	const edits = [];
	const manager = { buildSessionProjection: () => ({ entries }), appendContextEdit: (id, replacement) => edits.push({ id, replacement }) };
	let handler;
	capAnthropicImages({ on: (name, fn) => { if (name === "before_provider_request") handler = fn; } });
	const payload = images => ({ model: "claude-opus-5-5", messages: images.map(entry => ({ role: "user", content: [{ type: "tool_result",
		content: [{ type: "text", text: "Viewed" }, { type: "image", source: { type: "base64", media_type: "image/png", data: entry.messages[0].content[1].data } }] }] })) });
	const ctx = { model: { api: "anthropic-messages" }, sessionManager: manager };

	assert.equal(await handler({ payload: payload(entries.slice(0, 10)) }, ctx), undefined, "a request under the limit is untouched");
	assert.equal(edits.length, 0);

	const sent = await handler({ payload: payload(entries) }, ctx);
	assert.ok(Buffer.byteLength(JSON.stringify(sent)) < 32 * 1024 * 1024, "this request now fits");
	assert.ok(edits.length > 30 && edits.every(edit => edit.replacement.content[1].text === OMITTED_IMAGE_NOTE), "the oldest images are edited out");
	assert.equal(edits[0].id, "entry-0");
	assert.ok(!edits.some(edit => edit.id === "entry-56"), "the newest image is kept");
	assert.equal(edits[0].replacement.content[0].text, "Viewed image 0", "the rest of each message stays");
	assert.equal(await handler({ payload: payload(entries) }, { ...ctx, model: { api: "openai-codex-responses" } }), undefined, "other providers are untouched");
});

test("a request with images trimmed matches what Pi sends from the edited conversation next", async () => {
	// CF AI Presentation (Work PC, 16–30 October): each trim cost two full cache rebuilds, not one, because the
	// trimmed request kept tool results as blocks that Pi sends as one string once their images are gone.
	const { stream } = await import("@earendil-works/pi-ai/api/anthropic-messages");
	const model = { id: "claude-opus-5-5", name: "Claude", api: "anthropic-messages", provider: "anthropic", baseUrl: "http://127.0.0.1:9",
		reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 };
	const payload = async messages => {
		let sent;
		for await (const event of stream(model, { systemPrompt: "Rules", messages }, { apiKey: "test", maxRetries: 0, onPayload: value => { sent = structuredClone(value); } }))
			if (event.type === "error" || event.type === "done") break;
		return JSON.parse(JSON.stringify(sent.messages, (key, value) => key === "cache_control" ? undefined : value));
	};
	const image = name => ({ type: "image", mimeType: "image/png", data: Buffer.from(name).toString("base64") });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const call = id => ({ role: "assistant", content: [{ type: "toolCall", id, name: "view_image", arguments: {} }], api: "anthropic-messages",
		provider: "anthropic", model: "claude-opus-5-5", usage, stopReason: "toolUse", timestamp: 1 });
	const result = (id, content) => ({ role: "toolResult", toolCallId: id, toolName: "view_image", content, isError: false, timestamp: 1 });
	const conversation = contents => [{ role: "user", content: "Look", timestamp: 1 },
		...contents.flatMap((content, index) => [call(`t${index}`), result(`t${index}`, content)]), { role: "user", content: "And now?", timestamp: 1 }];
	const original = [[image("only")], [{ type: "text", text: "Rendered" }, image("with-text")], [image("first"), image("kept")]];
	const omitted = new Set(["only", "with-text", "first"].map(name => Buffer.from(name).toString("base64")));
	const edited = original.map(content => content.map(part => part.type === "image" && omitted.has(part.data) ? { type: "text", text: OMITTED_IMAGE_NOTE } : part));

	assert.deepEqual(withoutImages(await payload(conversation(original)), omitted), await payload(conversation(edited)));
});
