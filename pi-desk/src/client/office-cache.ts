/**
 * Office files Work has drawn, kept as copies of their drawings (office-frame/frame.ts, snapshot) so a file is drawn
 * once, not each time Work shows it. A copy is found by the file's computer, path and version and Desk's version, so a
 * changed file or a new way of drawing it is drawn again. Copies are kept in memory for this page and in this browser's
 * IndexedDB, up to STORED characters, the least recently shown going first; a file's older versions go when a newer
 * one is kept. Without IndexedDB, as in tests, only memory keeps them.
 */
// A slide deck's pictures are kept in its drawing as base64 text: a 20 MB deck's drawing is about 28 million characters.
const STORED = 200_000_000, IN_MEMORY = 80_000_000, LARGEST = 64_000_000;
const memory = new Map<string, string>();
let database: Promise<IDBDatabase | undefined> | undefined;

interface Entry { key: string; file: string; size: number; used: number }

function open(): Promise<IDBDatabase | undefined> {
	database ??= new Promise(resolve => {
		if (typeof indexedDB === "undefined") { resolve(undefined); return; }
		const request = indexedDB.open("pi-desk-office", 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore("drawings");
			request.result.createObjectStore("entries", { keyPath: "key" });
		};
		request.onsuccess = () => {
			const connection = request.result;
			connection.onversionchange = () => { connection.close(); database = undefined; };
			resolve(connection);
		};
		request.onerror = () => resolve(undefined);
	});
	return database;
}
const done = (request: IDBRequest | IDBTransaction) => new Promise<void>((resolve, reject) => {
	if (request instanceof IDBTransaction) { request.oncomplete = () => resolve(); request.onerror = request.onabort = () => reject(request.error); }
	else { request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }
});

function remember(key: string, html: string): void {
	memory.delete(key); memory.set(key, html);
	let size = 0;
	for (const [old, kept] of [...memory].reverse()) if ((size += kept.length) > IN_MEMORY) memory.delete(old);
}

/** The key of a file's drawing: which computer, which file, which version of it, drawn by which Desk. */
export function drawingKey(computer: string, path: string, version: string, desk: string): { key: string; file: string } {
	const file = JSON.stringify([computer, path]);
	return { key: JSON.stringify([computer, path, version, desk]), file };
}

/** A kept drawing, or undefined; one read from storage is kept in memory too. */
export async function keptDrawing(key: string): Promise<string | undefined> {
	const held = memory.get(key);
	if (held !== undefined) { remember(key, held); return held; }
	try {
		const connection = await open();
		if (!connection) return undefined;
		const transaction = connection.transaction(["drawings", "entries"], "readwrite");
		const read = transaction.objectStore("drawings").get(key), entry = transaction.objectStore("entries").get(key);
		await Promise.all([done(read), done(entry)]);
		const html = read.result as string | undefined;
		if (typeof html !== "string") return undefined;
		const found = entry.result as Entry | undefined;
		if (found) transaction.objectStore("entries").put({ ...found, used: Date.now() } satisfies Entry);
		await done(transaction);
		remember(key, html);
		return html;
	} catch { return undefined; }
}

/** Keeps a file's drawing, in place of its older versions'. */
export async function keepDrawing(key: string, file: string, html: string): Promise<void> {
	if (html.length > LARGEST) return;
	remember(key, html);
	try {
		const connection = await open();
		if (!connection) return;
		const transaction = connection.transaction(["drawings", "entries"], "readwrite");
		const drawings = transaction.objectStore("drawings"), entries = transaction.objectStore("entries");
		const all = entries.getAll();
		await done(all);
		const others = (all.result as Entry[]).filter(entry => entry.key !== key);
		const gone = new Set(others.filter(entry => entry.file === file).map(entry => entry.key));
		let size = html.length;
		for (const entry of others.filter(entry => !gone.has(entry.key)).sort((a, b) => b.used - a.used))
			if ((size += entry.size) > STORED) gone.add(entry.key);
		for (const old of gone) { drawings.delete(old); entries.delete(old); memory.delete(old); }
		drawings.put(html, key);
		entries.put({ key, file, size: html.length, used: Date.now() } satisfies Entry);
		await done(transaction);
	} catch { /* The drawing is kept in memory only. */ }
}
