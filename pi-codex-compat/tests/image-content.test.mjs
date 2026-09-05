import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_PROVIDER_IMAGE_CONVERSIONS,
	createImageContent,
	normalizeLegacyImageBlock,
	normalizeLegacyImageMessages,
	normalizeProviderImageMessages,
	prepareNativeImageContent,
} from "../extensions/image-content.ts";
import { MAX_LOCAL_IMAGE_BYTES } from "../extensions/image-limits.ts";

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

test("native decoding retains strict base64 validation across content-cache hits", async () => {
	const convert = async () => { throw new Error("PNG should not require conversion"); };
	for (let i = 0; i < 2; i++) {
		const result = await prepareNativeImageContent({ data: `${PNG_DATA}`, mimeType: "image/png" }, convert);
		assert.equal(result.data, PNG_DATA);
	}
	for (const data of [`!${PNG_DATA}`, `${PNG_DATA}=`, PNG_DATA.replace(/=/g, "") + "-"]) {
		await assert.rejects(prepareNativeImageContent({ data }, convert), /invalid image data/);
	}
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
	assert.deepEqual(
		normalizeLegacyImageBlock({ type: "image", data: "unknown" }),
		{
			type: "text",
			text: "[Invalid image content omitted: missing data or supported MIME type]",
		},
	);
});

test("oversized resumed and converted image data is rejected before decoding", async () => {
	const oversizedBase64 = "A".repeat(
		Math.ceil(((MAX_LOCAL_IMAGE_BYTES + 1) * 4) / 3),
	);
	assert.deepEqual(
		normalizeLegacyImageBlock({
			type: "image",
			data: oversizedBase64,
			mimeType: "image/png",
		}),
		{
			type: "text",
			text: "[Invalid image content omitted: unsupported or invalid image data]",
		},
	);
	await assert.rejects(
		prepareNativeImageContent(
			{ data: BMP_DATA, mimeType: "image/bmp" },
			async () => ({ data: oversizedBase64, mimeType: "image/png" }),
		),
		new RegExp(`larger than ${MAX_LOCAL_IMAGE_BYTES} bytes`),
	);
});

test("message normalization changes only messages containing legacy images", () => {
	const untouched = {
		role: "user",
		content: [{ type: "text", text: "hello" }],
	};
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

test("provider normalization byte-validates supported native resumed images", async () => {
	const invalid = {
		role: "toolResult",
		content: [createImageContent("bm90LWEtcG5n", "image/png")],
	};
	const normalized = await normalizeProviderImageMessages(
		[invalid],
		async () => null,
	);

	assert.deepEqual(normalized[0].content[0], {
		type: "text",
		text: "[Invalid image content omitted: unsupported or invalid image data]",
	});
});

test("provider normalization preserves valid native identities for prompt-cache stability", async () => {
	const image = createImageContent(PNG_DATA, "image/png");
	const message = { role: "user", content: [image] };
	const messages = [message];
	const normalized = await normalizeProviderImageMessages(
		messages,
		async () => null,
	);

	assert.equal(normalized, messages);
	assert.equal(normalized[0], message);
	assert.equal(normalized[0].content[0], image);
});

test("provider normalization omits historical BMP when conversion fails", async () => {
	const bmp = {
		role: "toolResult",
		content: [createImageContent(BMP_DATA, "image/bmp")],
	};
	const normalized = await normalizeProviderImageMessages(
		[bmp],
		async () => null,
	);

	assert.deepEqual(normalized[0].content[0], {
		type: "text",
		text: "[Image content omitted: could not convert image/bmp to a supported image format]",
	});
});

test("historical image conversion has bounded concurrency", async () => {
	let active = 0;
	let peak = 0;
	const message = {
		role: "toolResult",
		content: Array.from({ length: 50 }, () =>
			createImageContent(BMP_DATA, "image/bmp"),
		),
	};
	const normalized = await normalizeProviderImageMessages(
		[message],
		async () => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setImmediate(resolve));
			active -= 1;
			return { data: PNG_DATA, mimeType: "image/png" };
		},
	);
	assert.equal(peak, MAX_PROVIDER_IMAGE_CONVERSIONS);
	assert.equal(normalized[0].content.length, 50);
	assert.equal(
		normalized[0].content.every((block) => block.mimeType === "image/png"),
		true,
	);
});
