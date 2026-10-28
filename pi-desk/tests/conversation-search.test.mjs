import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchStore } from "../src/host/search-store.ts";
import { SearchScanner } from "../src/host/search-scanner.ts";
import { SEARCH_EMBEDDING_DIMENSIONS } from "../src/host/search-embedder.ts";

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
