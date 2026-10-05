import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

test("attachment reads reopen a closing database without replaying a transaction", async () => {
	const directory = mkdtempSync(join(tmpdir(), "desk-draft-db-")), previous = globalThis.indexedDB;
	let opens = 0, transactions = 0;
	const connections = [];
	globalThis.indexedDB = { open() {
		opens++;
		const connection = { closed: false, close() { this.closed = true; }, transaction() {
			if (this.closed) throw new DOMException("The database connection is closing.", "InvalidStateError");
			transactions++;
			const transaction = { objectStore: () => ({ openCursor: () => ({}) }) };
			setImmediate(() => transaction.oncomplete()); return transaction;
		} };
		connections.push(connection);
		const request = { result: connection };
		queueMicrotask(() => request.onsuccess()); return request;
	} };
	try {
		const outfile = join(directory, "fixture.cjs");
		await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx",
			contents: 'export { draftAttachments } from "./src/client/attachments.tsx";' }, outfile, bundle: true,
			platform: "node", format: "cjs", jsx: "automatic" });
		const { draftAttachments } = createRequire(import.meta.url)(outfile);
		assert.equal((await draftAttachments()).size, 0);
		connections[0].close();
		assert.equal((await draftAttachments()).size, 0);
		assert.equal(opens, 2);
		assert.equal(transactions, 2, "a failed transaction start has no admitted transaction to replay");
	} finally { globalThis.indexedDB = previous; rmSync(directory, { recursive: true, force: true }); }
});
