import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "../src/host/transcript.ts";
import { TranscriptFeed } from "../src/host/transcript-feed.ts";
import { recoverReference, ExpiredReference } from "../src/host/references.ts";

const native = (id, message) => ({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message });
const feed = (transcript, branch, cwd) => new TranscriptFeed(transcript, () => branch, () => "generation", () => {}, () => cwd);

test("evicted output is restored from its native message even when that message exceeds the cache", async () => {
	const transcript = new Transcript();
	const entry = native("large", { role: "assistant", content: [0, 1, 2, 3].map(value =>
		({ type: "text", text: String(value).repeat(16 * 1024 * 1024) })) });
	const source = feed(transcript, [entry], tmpdir());
	const id = transcript.entry(entry).blocks[0].full;
	assert.throws(() => transcript.getAsset(id), ExpiredReference);
	assert.throws(() => source.restore("entry:unrelated"), /no longer/);
	const asset = await recoverReference(() => transcript.getAsset(id), () => transcript.recover(id, () => source.restore("entry:large")));
	assert.equal(Buffer.from(asset.base64, "base64").subarray(0, 4).toString(), "0000");
	assert.ok(transcript.assetBytes <= 64 * 1024 * 1024);
});

test("evicted file grants recover without weakening the version check during a transfer", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "desk-reference-"));
	try {
		await writeFile(join(cwd, "sample.txt"), "Original file\n");
		const transcript = new Transcript();
		const entry = native("file", { role: "assistant", content: [{ type: "text", text: "[Sample](sample.txt)" }] });
		const source = feed(transcript, [entry], cwd);
		const reference = transcript.entry(entry, 0, cwd).links[0].file;
		const info = await transcript.files.command({ kind: "file", id: reference.id, operation: "info" });
		const evict = () => { for (let index = 0; index < 2049; index++) transcript.files.observePath(`other-${index}`, cwd); };
		const command = { kind: "file", id: reference.id, operation: "chunk", offset: 0, version: info.version };
		const read = () => recoverReference(() => transcript.files.command(command),
			() => transcript.recover(reference.id, () => source.restore("entry:file")));
		evict();
		assert.equal(Buffer.from((await read()).base64, "base64").toString(), "Original file\n");
		await appendFile(join(cwd, "sample.txt"), "Changed\n");
		evict();
		await assert.rejects(read, /File changed/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});
