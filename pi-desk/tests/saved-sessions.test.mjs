import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SavedSessionIndex, CatalogChanged } from "../src/host/saved-sessions.ts";
import { readSessionMetadata } from "../src/host/session-metadata.ts";

test("all saved sessions remain searchable and pageable past the former 200-session cutoff", async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-catalog-")), source = join(root, "sessions"), data = join(root, "index");
	await mkdir(source); await mkdir(data);
	t.after(() => rm(root, { recursive: true, force: true }));
	const write = async index => {
		const timestamp = new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString();
		await writeFile(join(source, `${index}.jsonl`), [
			{ type: "session", version: 3, id: `session-${index}`, cwd: root, timestamp },
			{ type: "session_info", id: "name", parentId: null, timestamp, name: index ? `Sample ${index}` : "Older café" },
		].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	};
	await Promise.all(Array.from({ length: 241 }, (_, index) => write(index)));
	const catalog = new SavedSessionIndex(data, root, root, source);
	try {
		let page = await catalog.page(), revision = page.revision, files = page.sessions.map(item => item.file);
		assert.equal(page.sessions.length, 50);
		while (page.next !== undefined) {
			page = await catalog.page({ offset: page.next, revision });
			files.push(...page.sessions.map(item => item.file));
		}
		assert.equal(new Set(files).size, 241);
		assert.equal((await catalog.page({ query: "CAFÉ" })).sessions[0].name, "Older café");
		await write(241);
		assert.equal((await catalog.page()).total, 241, "warm requests do not rescan");
		catalog.invalidate();
		assert.equal((await catalog.page({ offset: 50, revision })).total, 241, "live writes do not change a pinned catalog page");
		assert.equal((await catalog.page({ refresh: true })).total, 242);
		await assert.rejects(catalog.page({ offset: 50, revision }), CatalogChanged);
		await rm(join(source, "0.jsonl"));
		assert.equal((await catalog.page({ refresh: true, query: "café" })).matched, 0);
	} finally { await catalog.close(); }
	const empty = join(root, "another-store"); await mkdir(empty);
	const reopened = new SavedSessionIndex(data, root, root, empty, () => [source]);
	try { assert.equal((await reopened.page()).total, 241); }
	finally { await reopened.close(); }
});

test("catalog previews do not retain huge message bodies or lose later metadata", async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-catalog-line-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "sample.jsonl"), output = await open(file, "w");
	try {
		await output.write(JSON.stringify({ type: "session", version: 3, id: "sample", cwd: root, timestamp: "2020-01-01T00:00:00Z" }) + "\n");
		await output.write('{"type":"message","message":{"content":"');
		const chunk = Buffer.from("🙂α".repeat(50000));
		for (let index = 0; index < 20; index++) await output.write(chunk);
		await output.write('","timestamp":1577836801000,"role":"user"}}\n');
		await output.write('malformed record\n');
		await output.write(JSON.stringify({ type: "session_info", name: "Named after the long message" }) + "\n");
		await output.write(JSON.stringify({ type: "message", message: { role: "assistant",
			content: [{ text: "answer", type: "text" }], timestamp: 1577836802000 } }) + "\n");
		await output.write('{"type":"message","message":');
	} finally { await output.close(); }
	const metadata = await readSessionMetadata(file, Date.now());
	assert.equal(metadata.name, "Named after the long message");
	assert.equal(metadata.messageCount, 2);
	assert.equal(metadata.firstMessage, "🙂α".repeat(50000).slice(0, 200));
	assert.equal(metadata.modified, "2020-01-01T00:00:02.000Z");
	assert.match(metadata.warning, /2 unreadable records/);
	assert.ok(JSON.stringify(metadata).length < 1000);
});
