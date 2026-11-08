import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { CHANGE_ENTRY, foldBranch } from "./domain.ts";
import { fullText } from "./render.ts";

// Most lines start with their type, ID and parent; reading those three needs no JSON parse of a message's content.
const HEAD = /^\{"type":"[a-z_]+","id":"([^"]+)","parentId":(?:null|"([^"]+)")/;

/**
 * The handbook of the conversation saved in file, as the handbook tool's read action shows it, read without loading
 * the file: a long conversation's history runs to hundreds of megabytes. The branch is the one its last entry is on.
 * Resolves to undefined when the conversation has no handbook.
 */
export async function readHandbookFile(file: string): Promise<string | undefined> {
	const parents = new Map<string, string | null>(), changes = new Map<string, Record<string, unknown>>();
	let leaf: string | undefined, lines = 0;
	const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of reader) {
		// Long reads leave the process free for other work between batches.
		if (++lines % 5000 === 0) await new Promise(resolve => setImmediate(resolve));
		const head = HEAD.exec(line);
		if (head) { parents.set(head[1]!, head[2] ?? null); leaf = head[1]; continue; }
		if (!line.startsWith("{")) continue;
		let entry: Record<string, unknown>;
		try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
		if (typeof entry.id !== "string") continue;
		parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null); leaf = entry.id;
		if (entry.type === "custom" && entry.customType === CHANGE_ENTRY) changes.set(entry.id, entry);
	}
	if (!changes.size) return undefined;
	const branch: Record<string, unknown>[] = [];
	for (let at = leaf; at !== undefined && at !== null; at = parents.get(at) ?? undefined) {
		const change = changes.get(at);
		if (change) branch.push(change);
	}
	return branch.length ? fullText(foldBranch(branch.reverse() as never)) : undefined;
}
