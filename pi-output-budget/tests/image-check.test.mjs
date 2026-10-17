import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { imageDamage, imageRejections, withoutUnreadableImages } from "../extensions/image-check.ts";

function png(width = 32, height = 32) {
	const chunk = (type, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, "latin1");
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])) >>> 0); return Buffer.concat([head, body, crc]); };
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
	const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, y * 7)])));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("damaged images are found by their structure", () => {
	const good = png();
	assert.equal(imageDamage(good), undefined);
	// The screenshot that stopped a conversation had foreign bytes inside an IDAT chunk.
	const bad = Buffer.from(good); bad[60] ^= 0xff;
	assert.match(imageDamage(bad), /PNG chunk IDAT at byte \d+ is corrupt/);
	assert.match(imageDamage(good.subarray(0, good.length - 12)), /ends before its IEND/);
	assert.equal(imageDamage(Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])), undefined);
	assert.match(imageDamage(Buffer.from([0xff, 0xd8, 1, 2, 3])), /JPEG/);
});

test("requests leave out damaged images and those in a turn the provider rejected, without touching others", () => {
	const good = png().toString("base64"), bad = Buffer.from(png()); bad[60] ^= 0xff;
	const image = data => ({ type: "image", data, mimeType: "image/png" });
	const messages = [
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "first" }, image(good)] },
		{ role: "assistant", timestamp: 2, stopReason: "stop", content: [] },
		{ role: "user", timestamp: 3, content: [image(bad.toString("base64"))] },
		{ role: "assistant", timestamp: 4, stopReason: "stop", content: [] },
		{ role: "user", timestamp: 5, content: [image(good)] },
		{ role: "assistant", timestamp: 6, stopReason: "error", errorMessage: "400 invalid_request_error: Could not process image", content: [] },
	];
	const rejected = imageRejections(messages.map(message => ({ type: "message", message })));
	assert.deepEqual(rejected, [6]);
	const result = withoutUnreadableImages(messages, rejected);
	assert.equal(result[0], messages[0], "a readable earlier image is kept as is");
	assert.match(result[2].content[0].text, /could not be read and was left out: PNG chunk IDAT/);
	assert.match(result[4].content[0].text, /provider could not process it/);
	assert.equal(withoutUnreadableImages(messages.slice(0, 2), []), undefined, "nothing to change returns undefined");
});
