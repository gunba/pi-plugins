import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchStore } from "../src/host/search-store.ts";
import { SearchScanner } from "../src/host/search-scanner.ts";
import { SEARCH_EMBEDDING_DIMENSIONS } from "../src/host/search-embedder.ts";
import { ConversationSearch } from "../src/host/conversation-search.ts";
import { searchPassage } from "../src/shared/conversation-search.ts";

const hash = text => createHash("sha256").update(text).digest("hex");

test("recovery copies cannot become retention authorities under a broad custom session root", async () => {
	const directory = mkdtempSync(join(tmpdir(), "desk-search-recovery-")), copies = join(directory, "desk", "teleport", "copies");
	mkdirSync(copies, { recursive: true });
	const cachedFile = join(copies, "cached.jsonl"), nativeFile = join(directory, "native.jsonl");
	const history = id => [
		{ type: "session", version: 3, id, cwd: directory },
		{ type: "message", id: "entry", message: { role: "user", content: `History from ${id}.` } },
	].map(row => JSON.stringify(row) + "\n").join("");
	writeFileSync(cachedFile, history("cached-copy")); writeFileSync(nativeFile, history("original"));
	const store = new SearchStore(join(directory, "index.sqlite"));
	const options = { roots: [directory], secondaryRoot: join(directory, "children"), files: [cachedFile], exclude: [] };
	const scanner = new SearchScanner(store, options, () => {});
	try {
		await scanner.scan();
		assert.deepEqual(store.localSources().map(source => source.session).sort(), ["cached-copy", "original"]);
		scanner.configure({ ...options, ignoreRoots: [copies] });
		await scanner.scan();
		assert.deepEqual(store.localSources().map(source => source.session), ["original"]);
		assert.deepEqual(store.pending({ local: true }).map(row => row.text), ["History from original."]);
		assert.equal(readFileSync(cachedFile, "utf8"), history("cached-copy"));
		await scanner.scan();
		assert.deepEqual(store.localSources().map(source => source.session), ["original"]);
	} finally { await scanner.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("late embeddings cannot attach to replacement text or resurrect a deleted source", () => {
	const directory = mkdtempSync(join(tmpdir(), "desk-search-vector-")), store = new SearchStore(join(directory, "index.sqlite"));
	const scope = { local: true }, vector = new Float32Array(SEARCH_EMBEDDING_DIMENSIONS); vector[0] = 1;
	const add = (id, text) => {
		const file = { file: join(directory, `${id}.jsonl`), id, stamp: "fixture", offset: 0, ordinal: 0, anchor: "", seen: "scan" };
		const source = store.registerFile(file, { id, session: id, title: id, project: directory, kind: "primary", updated: 1 }, false);
		store.append({ ...file, offset: 100, ordinal: 2 }, source.generation,
			[{ id: "entry", ordinal: 1, passages: [{ start: 0, role: "assistant", text }] }], { complete: true });
	};
	try {
		add("old", "The old source text.");
		const old = store.pending(scope)[0];
		store.removeFiles(["old"]);
		add("replacement", "Different replacement text.");
		const replacement = store.pending(scope)[0];

		store.putVectors([{ id: old.id, hash: hash(old.text), vector }]);
		assert.equal(store.coverage(scope, "indexing").embedded_passages, 0);
		assert.deepEqual(store.pending(scope).map(item => item.text), ["Different replacement text."]);

		store.putVectors([{ id: replacement.id, hash: hash(replacement.text), vector }]);
		assert.equal(store.coverage(scope, "ready").embedded_passages, 1);
		assert.deepEqual(store.pending(scope), []);

		store.removeFiles(["replacement"]);
		store.putVectors([{ id: replacement.id, hash: hash(replacement.text), vector }]);
		assert.equal(store.coverage(scope, "ready").passages, 0);
		assert.equal(store.coverage(scope, "ready").embedded_passages, 0);
	} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("tool output with NUL characters exports passages another computer accepts", async () => {
	const directory = mkdtempSync(join(tmpdir(), "desk-search-nul-")), file = join(directory, "native.jsonl");
	// UTF-16 text read as bytes, and binary output that starts with NUL: SQLite text reads back only up to the first NUL.
	writeFileSync(file, [
		{ type: "session", version: 3, id: "binary", cwd: directory },
		{ type: "message", id: "utf16", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "c\0o\0m\0p\0a\0n\0y\0" }] } },
		{ type: "message", id: "binary", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "\0\0\0/Game/Data" }] } },
		{ type: "message", id: "padding", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "\0\0\0\0" }] } },
	].map(row => JSON.stringify(row) + "\n").join(""));
	const store = new SearchStore(join(directory, "index.sqlite"));
	const scanner = new SearchScanner(store, { roots: [directory], secondaryRoot: join(directory, "children"), files: [file], exclude: [] }, () => {});
	try {
		await scanner.scan();
		const [source] = store.localSources();
		const passages = store.export(source.id, source.generation, 0, source.cursor, 256, 512 * 1024);
		assert.deepEqual(passages.map(passage => [passage.entry, passage.text]), [["utf16", "c o m p a n y "], ["binary", "   /Game/Data"]]);
		for (const passage of passages) assert.deepEqual(searchPassage(passage), passage);
	} finally { await scanner.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("passages left blank by older indexes are accepted", () => {
	const passage = { sequence: 1, entry: "entry", ordinal: 0, start: 0, role: "tool", tool: "read", text: "" };
	assert.deepEqual(searchPassage(passage), passage);
});

test("a search packet that fails validation does not close the connection to its computer", async () => {
	const directory = mkdtempSync(join(tmpdir(), "desk-search-packet-"));
	const search = new ConversationSearch({ directory, scanner: () => ({ roots: [], secondaryRoot: join(directory, "children"), files: [], exclude: [] }),
		settings: () => ({ hold: true, send: false }), self: () => "self" });
	search.bind({ scope: "scope", computers: () => [], send: async () => {}, flush: () => {} });
	try {
		// Rejecting closes the connection, and agent messages, settings and copies with it.
		assert.equal(await search.receive("peer", { type: "search-data", id: "fetch", source: "source", generation: "generation", after: 0, cursor: 1,
			passages: [{ sequence: 1, entry: "entry", ordinal: 0, start: 0, role: "narrator", text: "text" }] }, async () => {}), undefined);
	} finally { await search.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a computer's burst of search offers after its inventory does not close the connection", async () => {
	// 2783 conversations arrive as 87 offers in under a second; past 64 queued packets the server rejected them.
	const directory = mkdtempSync(join(tmpdir(), "desk-search-offers-"));
	const search = new ConversationSearch({ directory, scanner: () => ({ roots: [], secondaryRoot: join(directory, "children"), files: [], exclude: [] }),
		settings: () => ({ hold: true, send: false }), self: () => "self" });
	search.bind({ scope: "scope", computers: () => [], send: async () => {}, flush: () => {} });
	try {
		const offers = Array.from({ length: 100 }, (_, batch) => search.receive("peer", { type: "search-offer", epoch: "epoch",
			sources: Array.from({ length: 32 }, (_, index) => ({ id: `source-${batch}-${index}`, version: 1, generation: "generation", cursor: 1,
				complete: true, session: "session", file: "file", title: "", project: "", kind: "primary", updated: 1 })) }, async () => {}));
		const settled = await Promise.allSettled(offers);
		assert.deepEqual(settled.filter(result => result.status === "rejected").map(result => String(result.reason)), []);
	} finally { await search.close(); rmSync(directory, { recursive: true, force: true }); }
});
