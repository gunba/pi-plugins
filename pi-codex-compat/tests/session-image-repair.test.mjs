import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	planSessionImageRepair,
	repairSessionImageFile,
} from "../extensions/session-image-repair.ts";

const PNG_DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";

function legacyImage() {
	return {
		type: "image",
		source: { type: "base64", mediaType: "image/png", data: PNG_DATA },
	};
}

function sessionText() {
	return [
		JSON.stringify({ type: "session", version: 3, id: "test", cwd: "C:/work" }),
		JSON.stringify({
			type: "message",
			id: "one",
			parentId: null,
			message: { role: "toolResult", content: [legacyImage()] },
		}),
		JSON.stringify({
			type: "custom_message",
			id: "two",
			parentId: "one",
			content: [legacyImage()],
		}),
	].join("\n") + "\n";
}

const unexpectedConversion = async () => {
	throw new Error("PNG normalization must not invoke the converter");
};

test("repair planning normalizes message and custom-message image blocks", async () => {
	const original = sessionText();
	const plan = await planSessionImageRepair(original, unexpectedConversion);

	assert.equal(plan.changedEntries, 2);
	assert.equal(plan.changedBlocks, 2);
	const repaired = plan.repairedText.trimEnd().split("\n").map(JSON.parse);
	assert.deepEqual(repaired[1].message.content[0], {
		type: "image",
		data: PNG_DATA,
		mimeType: "image/png",
	});
	assert.deepEqual(repaired[2].content[0], repaired[1].message.content[0]);
	assert.equal(plan.repairedText.endsWith("\n"), true);
});

test("file repair requires approval and preserves an exact backup", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-image-repair-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionPath = join(directory, "session.jsonl");
	const original = sessionText();
	await writeFile(sessionPath, original, "utf8");

	const cancelled = await repairSessionImageFile(
		sessionPath,
		unexpectedConversion,
		async () => false,
	);
	assert.equal(cancelled.applied, false);
	assert.equal(await readFile(sessionPath, "utf8"), original);
	assert.deepEqual(await readdir(directory), ["session.jsonl"]);

	const applied = await repairSessionImageFile(
		sessionPath,
		unexpectedConversion,
		async () => true,
	);
	assert.equal(applied.applied, true);
	assert.equal(applied.changedEntries, 2);
	assert.equal(await readFile(applied.backupPath, "utf8"), original);
	assert.notEqual(await readFile(sessionPath, "utf8"), original);
});

test("malformed JSON aborts before a backup or rewrite", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-image-repair-invalid-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionPath = join(directory, "session.jsonl");
	const original = '{"type":"session"}\nnot-json\n';
	await writeFile(sessionPath, original, "utf8");

	await assert.rejects(
		repairSessionImageFile(sessionPath, unexpectedConversion, async () => true),
		/Invalid session JSON on line 2/,
	);
	assert.equal(await readFile(sessionPath, "utf8"), original);
	assert.deepEqual(await readdir(directory), ["session.jsonl"]);
});
