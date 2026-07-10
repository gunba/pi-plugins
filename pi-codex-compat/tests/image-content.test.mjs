import assert from "node:assert/strict";
import test from "node:test";

import {
	createImageContent,
	normalizeLegacyImageBlock,
	normalizeLegacyImageMessages,
	normalizeProviderImageMessages,
} from "../extensions/image-content.ts";

const PNG_DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
const BMP_DATA =
	"Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAADEDgAAxA4AAAAAAAAAAAAAAP8AAP8AAAAA/wAA/wAAAA==";

test("createImageContent returns Pi's native image block", () => {
	assert.deepEqual(createImageContent(PNG_DATA, "image/png"), {
		type: "image",
		data: PNG_DATA,
		mimeType: "image/png",
	});
});

test("native image blocks retain their identity", () => {
	const native = createImageContent(PNG_DATA, "image/png");
	assert.equal(normalizeLegacyImageBlock(native), native);
});

test("legacy Anthropic-shaped image blocks become native Pi image blocks", () => {
	assert.deepEqual(
		normalizeLegacyImageBlock({
			type: "image",
			source: { type: "base64", mediaType: "image/png", data: PNG_DATA },
		}),
		createImageContent(PNG_DATA, "image/png"),
	);
});

test("legacy images with no MIME type are recovered from their signature", () => {
	assert.deepEqual(
		normalizeLegacyImageBlock({
			type: "image",
			source: { type: "base64", data: PNG_DATA },
		}),
		createImageContent(PNG_DATA, "image/png"),
	);
});

test("legacy Anthropic media_type spelling is accepted", () => {
	assert.deepEqual(
		normalizeLegacyImageBlock({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: PNG_DATA },
		}),
		createImageContent(PNG_DATA, "image/png"),
	);
});

test("unrecoverable image blocks are replaced before reaching a provider", () => {
	assert.deepEqual(normalizeLegacyImageBlock({ type: "image", data: "unknown" }), {
		type: "text",
		text: "[Invalid image content omitted: missing data or supported MIME type]",
	});
});

test("message normalization changes only messages containing legacy images", () => {
	const untouched = { role: "user", content: [{ type: "text", text: "hello" }] };
	const legacy = {
		role: "toolResult",
		content: [
			{ type: "text", text: "Viewed image" },
			{
				type: "image",
				source: { type: "base64", mediaType: "image/png", data: PNG_DATA },
			},
		],
	};
	const messages = [untouched, legacy];
	const normalized = normalizeLegacyImageMessages(messages);

	assert.notEqual(normalized, messages);
	assert.equal(normalized[0], untouched);
	assert.deepEqual(
		normalized[1].content[1],
		createImageContent(PNG_DATA, "image/png"),
	);
	assert.equal(normalizeLegacyImageMessages([untouched])[0], untouched);
});

test("provider normalization converts historical BMP image blocks", async () => {
	const legacyBmp = {
		role: "toolResult",
		content: [
			{
				type: "image",
				source: { type: "base64", mediaType: "image/bmp", data: BMP_DATA },
			},
		],
	};
	const normalized = await normalizeProviderImageMessages(
		[legacyBmp],
		async (data, mimeType) => {
			assert.equal(data, BMP_DATA);
			assert.equal(mimeType, "image/bmp");
			return { data: PNG_DATA, mimeType: "image/png" };
		},
	);

	assert.deepEqual(
		normalized[0].content[0],
		createImageContent(PNG_DATA, "image/png"),
	);
});

test("provider normalization omits historical BMP when conversion fails", async () => {
	const bmp = {
		role: "toolResult",
		content: [createImageContent(BMP_DATA, "image/bmp")],
	};
	const normalized = await normalizeProviderImageMessages([bmp], async () => null);

	assert.deepEqual(normalized[0].content[0], {
		type: "text",
		text: "[Image content omitted: could not convert image/bmp]",
	});
});
