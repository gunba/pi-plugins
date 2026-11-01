import assert from "node:assert/strict";
import test from "node:test";
import { queueAttachments, queuePreview } from "../src/host/engine.ts";

test("a waiting message's preview leaves out the attached-file list, whose files are listed apart", () => {
	const path = `/home/jordan/.pi/agent/desk/attachments/${"a".repeat(64)}/${"b".repeat(64)}/attachment.png`;
	const message = `Why isn't the icon inside the circle?\n\nAttached files on the host:\n- "image.png" (144629 bytes): ${JSON.stringify(path)}\n- "notes.txt" (12 bytes): "/etc/passwd"`;
	assert.equal(queuePreview(message), "Why isn't the icon inside the circle?");
	assert.deepEqual(queueAttachments(message), [{ name: "image.png", path }], "only paths in Desk's attachment store are listed");
	assert.equal(queuePreview("x".repeat(400)), `${"x".repeat(300)}…`);
	assert.deepEqual(queueAttachments("No files"), []);
});
