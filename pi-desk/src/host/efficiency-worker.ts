import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { addText, buildReport, emptyFile, type FileState } from "./efficiency.ts";
import { atomicJson } from "../../manage/store.ts";

/** Reads new session data into the efficiency cache and posts the report. Runs off the host's main thread. */
const { directories, cachePath } = (workerData ?? JSON.parse(process.env.EFFICIENCY_INPUT ?? "{}")) as { directories: string[]; cachePath: string };
const VERSION = 2;

/** Cache lifetimes from the model catalog, as Desk's cache timer reads them (pi-context-window/prompt-cache.ts). */
function lifetimes(): Map<string, number> {
	// Conversations run with long retention unless the login environment says otherwise (worker-registry.ts).
	const ttl = new Map<string, number>(), retention = (process.env.PI_CACHE_RETENTION ?? "long") === "long" ? "long" : "short";
	try {
		const data = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "providers", "data");
		for (const file of readdirSync(data).filter(name => name.endsWith(".json"))) {
			const apis = JSON.parse(readFileSync(join(data, file), "utf8")) as Record<string, Record<string, { id?: string; provider?: string; promptCache?: Record<string, number> }>>;
			for (const models of Object.values(apis)) for (const model of Object.values(models)) {
				const seconds = model.promptCache?.[retention];
				if (model.provider && model.id && seconds) ttl.set(`${model.provider}/${model.id}`, seconds * 1000);
			}
		}
	} catch { /* Without the catalog no break is attributed to expiry. */ }
	return ttl;
}
function sessionFiles(folder: string, found: string[] = []): string[] {
	let entries;
	try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return found; }
	for (const entry of entries) {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) sessionFiles(path, found);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
	}
	return found;
}

const ttl = lifetimes(), ttlMs = (model: string) => ttl.get(model);
let cache: { version: number; files: Record<string, FileState> } = { version: VERSION, files: {} };
try { const saved = JSON.parse(readFileSync(cachePath, "utf8")); if (saved.version === VERSION) cache = saved; } catch { /* First run. */ }
const WINDOW = 16 << 20;
for (const path of [...new Set(directories.flatMap(folder => sessionFiles(folder)))]) {
	let size: number;
	try { size = statSync(path).size; } catch { continue; }
	let state = cache.files[path];
	// A file that shrank was rewritten; read it again from the start.
	if (!state || size < state.offset) state = cache.files[path] = emptyFile();
	if (size === state.offset) continue;
	const handle = openSync(path, "r");
	try {
		// Only whole lines are consumed, so a line still being written is read next time.
		while (state.offset < size) {
			let length = Math.min(WINDOW, size - state.offset), buffer = Buffer.alloc(length), end = -1;
			for (;;) {
				readSync(handle, buffer, 0, length, state.offset);
				end = buffer.lastIndexOf(10, length - 1);
				if (end >= 0 || state.offset + length >= size) break;
				length = Math.min(length * 2, size - state.offset); buffer = Buffer.alloc(length);
			}
			if (end < 0) break;
			addText(state, buffer.toString("utf8", 0, end + 1), ttlMs);
			state.offset += end + 1;
		}
		state.size = size;
	} finally { closeSync(handle); }
}
mkdirSync(dirname(cachePath), { recursive: true });
atomicJson(cachePath, cache, { compact: true });
const report = buildReport(Object.values(cache.files));
if (parentPort) parentPort.postMessage(report); else console.log(JSON.stringify(report, null, 1));
