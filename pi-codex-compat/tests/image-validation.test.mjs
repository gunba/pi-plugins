import assert from "node:assert/strict";
import test from "node:test";
import { createImageContent, prepareNativeImageContent } from "../extensions/image-content.ts";
import { MAX_LOCAL_IMAGE_BYTES } from "../extensions/image-limits.ts";

const PNG_DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
const BMP_DATA =
	"Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAADEDgAAxA4AAAAAAAAAAAAAAP8AAP8AAAAA/wAA/wAAAA==";

test("PNG validation rejects damaged image data even with intact signature and IEND", async () => {
	const damaged = Buffer.from(PNG_DATA, "base64");
	damaged[50] ^= 1;
	await assert.rejects(
		prepareNativeImageContent({ data: damaged.toString("base64"), mimeType: "image/png" }, async () => null),
		/invalid image data/,
	);
});

test("createImageContent returns Pi's native image block", () => {
	assert.deepEqual(createImageContent(PNG_DATA, "image/png"), {
		type: "image", data: PNG_DATA, mimeType: "image/png",
	});
});

test("native decoding retains strict base64 validation", async () => {
	const convert = async () => { throw new Error("PNG should not require conversion"); };
	const result = await prepareNativeImageContent({ data: PNG_DATA, mimeType: "image/png" }, convert);
	assert.equal(result.data, PNG_DATA);
	for (const data of [`!${PNG_DATA}`, `${PNG_DATA}=`, PNG_DATA.replace(/=/g, "") + "-"]) {
		await assert.rejects(prepareNativeImageContent({ data }, convert), /invalid image data/);
	}
});

test("oversized input and converted images are rejected before decoding", async () => {
	const oversized = "A".repeat(Math.ceil(((MAX_LOCAL_IMAGE_BYTES + 1) * 4) / 3));
	await assert.rejects(prepareNativeImageContent({ data: oversized }, async () => null), /larger than/);
	await assert.rejects(
		prepareNativeImageContent({ data: BMP_DATA, mimeType: "image/bmp" },
			async () => ({ data: oversized, mimeType: "image/png" })),
		new RegExp(`larger than ${MAX_LOCAL_IMAGE_BYTES} bytes`),
	);
});

test("BMP conversion remains at the image ingestion boundary", async () => {
	const image = await prepareNativeImageContent({ data: BMP_DATA, mimeType: "image/bmp" }, async (data, mimeType) => {
		assert.equal(data, BMP_DATA);
		assert.equal(mimeType, "image/bmp");
		return { data: PNG_DATA, mimeType: "image/png" };
	});
	assert.deepEqual(image, createImageContent(PNG_DATA, "image/png"));
	await assert.rejects(prepareNativeImageContent({ data: BMP_DATA }, async () => null), /could not convert/);
});
