import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { SavedSessionIndex, CatalogChanged } from "../src/host/saved-sessions.ts";

async function complete(catalog, options = {}) {
	let page = await catalog.page(options);
	while (["loading", "queued"].includes(page.progress.state)) {
		await delay(20);
		page = await catalog.page({ ...options, refresh: false, scan: page.progress.id });
	}
	assert.equal(page.progress.state, "ready", page.warning);
	return page;
}

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
		let page = await complete(catalog), revision = page.revision, files = page.sessions.map(item => item.file);
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
		assert.equal((await complete(catalog, { refresh: true })).total, 242);
		await assert.rejects(catalog.page({ offset: 50, revision }), CatalogChanged);
		await rm(join(source, "0.jsonl"));
		assert.equal((await complete(catalog, { refresh: true, query: "café" })).matched, 0);
	} finally { await catalog.close(); }
	const empty = join(root, "another-store"); await mkdir(empty);
	const reopened = new SavedSessionIndex(data, root, root, empty, () => [source]);
	try { assert.equal((await complete(reopened)).total, 241); }
	finally { await reopened.close(); }
});

test("catalog previews do not retain huge message bodies or lose later metadata", async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-catalog-line-"));
	let catalog;
	t.after(async () => { await catalog?.close(); await rm(root, { recursive: true, force: true }); });
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
	catalog = new SavedSessionIndex(root, root, root, root);
	const metadata = (await complete(catalog)).sessions[0];
	assert.equal(metadata.name, "Named after the long message");
	assert.equal(metadata.messageCount, 2);
	assert.equal(metadata.firstMessage, "🙂α".repeat(50000).slice(0, 200));
	assert.equal(metadata.modified, "2020-01-01T00:00:02.000Z");
	assert.ok(JSON.stringify(metadata).length < 1000);
});

test("large libraries return immediately with project scope and cancellable native scans", { timeout: 30_000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "desk-resume-")), source = join(root, "sessions"), data = join(root, "index");
	await mkdir(source); await mkdir(data);
	let catalog;
	t.after(async () => { await catalog?.close(); await rm(root, { recursive: true, force: true }); });
	const one = join(root, "one"), two = join(root, "two");
	await Promise.all(Array.from({ length: 701 }, (_, i) => writeFile(join(source, `${i}.jsonl`), [
		{ type: "session", version: 3, id: `session-${i}`, cwd: i ? two : one, timestamp: "2020-01-01T00:00:00Z" },
		{ type: "session_info", name: i ? `Other ${i}` : "Selected project" },
	].map(entry => JSON.stringify(entry)).join("\n") + "\n")));
	catalog = new SavedSessionIndex(data, one, root, source);
	const first = await catalog.page({ cwd: one });
	assert.equal(first.progress.state, "loading", "the first response does not await a file scan");
	assert.equal(first.total, 0);
	const project = await complete(catalog, { cwd: one, scan: first.progress.id });
	assert.equal(project.matched, 1);
	assert.equal(project.sessions[0].name, "Selected project");
	const all = await catalog.page();
	const shared = await catalog.page({ reader: "second" });
	catalog.cancel(all.progress.id);
	assert.equal((await catalog.page({ scan: shared.progress.id, reader: "second" })).progress.state, "loading",
		"closing one picker does not stop another picker's scan");
	catalog.cancel(shared.progress.id, "second");
	assert.equal((await catalog.page({ scan: all.progress.id })).progress.state, "cancelled");
	assert.equal((await complete(catalog, { refresh: true })).total, 701);
	assert.equal((await catalog.page({ cwd: one, scan: first.progress.id })).total, 1);
	await writeFile(join(source, "0.jsonl"), JSON.stringify({
		type: "session", version: 3, id: "session-0", cwd: two, timestamp: "2020-01-01T00:00:00Z",
	}) + "\n");
	assert.equal((await complete(catalog, { cwd: one, refresh: true })).total, 0,
		"native scope membership replaces a preview whose project changed");
});
