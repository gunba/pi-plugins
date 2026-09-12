import { diffLines } from "diff";

export interface Snapshot {
	key: string;
	tree: string;
	start: number;
	end: number;
}

/** File-only snapshots stay file-only. Scoped snapshots never become full-page baselines. */
export function snapshotFrom(text: string, scope = ""): Snapshot | undefined {
	const match = /^### Snapshot\r?\n```(?:yaml)?\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/m.exec(text);
	const url = /^- Page URL: (.+)$/m.exec(text)?.[1];
	if (!match || !url) return;
	const tab = /^- (\d+): \(current\)/m.exec(text)?.[1] ?? "single";
	const start = match.index + match[0].indexOf("\n") + 1;
	return { key: `${tab}\n${url}\n${scope}`, tree: match[1]!, start, end: match.index + match[0].length };
}

export function compactDiff(previous: string, current: string): string | undefined {
	if (previous === current) return "No accessibility changes.";
	const changes = diffLines(previous, current, { timeout: 40, maxEditLength: 1000 });
	if (!changes) return;
	let before = 1, after = 1;
	const output: string[] = [];
	for (const change of changes) {
		const count = change.count ?? 0;
		if (!change.added && !change.removed) { before += count; after += count; continue; }
		output.push(`@@ old line ${before}; new line ${after} @@`);
		const lines = change.value.replace(/\n$/, "").split("\n");
		output.push(...lines.map(line => `${change.added ? "+" : "-"}${line}`));
		if (change.added) after += count;
		else before += count;
	}
	return output.join("\n");
}

interface Baseline { tree: string; artifact: string; sequence: number }
export class SnapshotCache {
	private values = new Map<string, Baseline>();
	clear() { this.values.clear(); }
	get(key: string) { return this.values.get(key); }
	set(key: string, value: Baseline) {
		if (value.tree.length > 512_000) return;
		if ((this.values.get(key)?.sequence ?? -1) > value.sequence) return;
		this.values.delete(key);
		this.values.set(key, value);
		while (this.values.size > 8 || [...this.values.values()].reduce((total, entry) => total + entry.tree.length, 0) > 1_048_576) {
			this.values.delete(this.values.keys().next().value!);
		}
	}
}

export function browserMethod(tool: string, input: Record<string, unknown>): string | undefined {
	const name = tool === "mcp" && typeof input.tool === "string" ? input.tool : tool;
	if (tool === "mcp" && input.server !== undefined && input.server !== "playwright") return;
	// The gateway accepts either the prefixed name or a server-scoped native name.
	if (name.startsWith("playwright_browser_")) return name.slice("playwright_".length);
	if (tool === "mcp" && input.server === "playwright" && name.startsWith("browser_")) return name;
}
