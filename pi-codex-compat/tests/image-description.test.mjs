import assert from "node:assert/strict";
import test from "node:test";

import { describeImageForTextModel } from "../extensions/image-description.ts";

const PNG_DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";

test("text-only visual inspection chooses an image-capable model and returns text", async () => {
	const current = {
		provider: "openai-codex",
		id: "gpt-5.3-codex-spark",
		api: "openai-codex-responses",
		input: ["text"],
	};
	const vision = {
		provider: "openai-codex",
		id: "gpt-5.4-mini",
		api: "openai-codex-responses",
		input: ["text", "image"],
	};
	let request;
	const ctx = {
		model: current,
		modelRegistry: {
			getAll() {
				return [current, { ...vision, provider: "openai" }, vision];
			},
			async getApiKeyAndHeaders(model) {
				assert.equal(model, vision);
				return { ok: true, apiKey: "oauth-token", headers: { "x-test": "yes" } };
			},
		},
	};
	const result = await describeImageForTextModel(
		{ type: "image", data: PNG_DATA, mimeType: "image/png" },
		"screen.png",
		undefined,
		ctx,
		{
			async completeImageDescription(model, context, options) {
				request = { model, context, options };
				return {
					role: "assistant",
					content: [{ type: "text", text: "  A blue dialog with an OK button.  " }],
					stopReason: "stop",
				};
			},
		},
	);

	assert.equal(request.model, vision);
	assert.equal(request.context.messages[0].content[1].type, "image");
	assert.equal(request.options.apiKey, "oauth-token");
	assert.deepEqual(result, {
		description: "A blue dialog with an OK button.",
		model: "openai-codex/gpt-5.4-mini",
	});
});

test("text-only visual inspection fails clearly when no vision model is configured", async () => {
	const current = {
		provider: "openai-codex",
		id: "gpt-5.3-codex-spark",
		api: "openai-codex-responses",
		input: ["text"],
	};
	await assert.rejects(
		describeImageForTextModel(
			{ type: "image", data: PNG_DATA, mimeType: "image/png" },
			"screen.png",
			undefined,
			{
				model: current,
				modelRegistry: { getAll: () => [current] },
			},
		),
		/no authenticated image-capable model is configured/,
	);
});
