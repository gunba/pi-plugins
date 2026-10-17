import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { Attachments } from "../src/host/attachments.ts";

function png() {
	const chunk = (type, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, "latin1");
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])) >>> 0); return Buffer.concat([head, body, crc]); };
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(16 * 49, 9))), chunk("IEND", Buffer.alloc(0))]);
}
const upload = (attachments, bytes, sha256) => {
	const { id } = attachments.command({ kind: "upload_begin", name: "screenshot.png", size: bytes.length });
	attachments.command({ kind: "upload_chunk", id, offset: 0, base64: bytes.toString("base64") });
	return attachments.command({ kind: "upload_finish", id, ...(sha256 ? { sha256 } : {}) });
};

test("uploads are checked end to end, and damaged images are refused before they can reach a model", t => {
	// A damaged screenshot made every later request in a conversation fail with "Could not process image".
	const dir = mkdtempSync(join(tmpdir(), "attachments-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const attachments = new Attachments(dir, "session");
	const good = png(), sha = createHash("sha256").update(good).digest("hex");
	assert.equal(upload(attachments, good, sha).mimeType, "image/png");
	const damaged = Buffer.from(good); damaged[60] ^= 0xff;
	assert.throws(() => upload(attachments, damaged), /This image is damaged \(PNG chunk IDAT at byte \d+ is corrupt\)/);
	assert.throws(() => upload(attachments, good, "0".repeat(64)), /arrived different from the file/);
});
