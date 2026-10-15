import assert from "node:assert/strict";
import test from "node:test";
import { capAnthropicImages, OMITTED_IMAGE_NOTE } from "../extensions/image-budget.ts";

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
