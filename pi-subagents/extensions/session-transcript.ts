import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import {
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type SessionTranscript = {
	file?: string;
	lines: string[];
	error?: string;
};

type ContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	mimeType?: string;
};

type SessionMessage = {
	role?: string;
	content?: string | ContentBlock[];
	toolName?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	stopReason?: string;
	errorMessage?: string;
	customType?: string;
	summary?: string;
};

function assistantText(message: SessionMessage): string {
	if (message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function publishableAssistantText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const message = entry.message as SessionMessage;
	if (
		message.stopReason === "error" ||
		message.stopReason === "aborted" ||
		message.errorMessage
	)
		return "";
	return assistantText(message);
}

/** Select the last non-empty successful assistant message on the active branch. */
export function publishedAssistantText(
	branch: readonly SessionEntry[],
	fallback = "",
): string {
	for (let index = branch.length - 1; index >= 0; index--) {
		const text = publishableAssistantText(branch[index] as SessionEntry);
		if (text) return text;
	}
	return fallback;
}

type TranscriptNode = { parentId: string | null; lines: string[] };
type CachedTranscript = {
	mtimeMs: number;
	size: number;
	dev: number;
	ino: number;
	maxChars: number;
	maxEntries: number;
	partial: boolean;
	leaf: string | null;
	chars: number;
	nodes: Map<string, TranscriptNode>;
	transcript: SessionTranscript;
};

const cache = new Map<string, CachedTranscript>();

function splitLines(value: string): string[] {
	return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function contentLines(content: string | ContentBlock[] | undefined): string[] {
	if (typeof content === "string") return splitLines(content);
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			lines.push(...splitLines(block.text));
			continue;
		}
		if (block.type === "thinking" && block.thinking) {
			lines.push("[thinking]", ...splitLines(block.thinking));
			continue;
		}
		if (block.type === "toolCall") {
			const args =
				block.arguments === undefined
					? ""
					: ` ${JSON.stringify(block.arguments)}`;
			lines.push(`[tool call] ${block.name ?? "unknown"}${args}`);
			continue;
		}
		if (block.type === "image")
			lines.push(`[image${block.mimeType ? ` ${block.mimeType}` : ""}]`);
	}
	return lines;
}

function cleanLines(lines: string[]): string[] {
	const out: string[] = [];
	let previousBlank = false;
	for (const raw of lines) {
		const line = stripVTControlCharacters(raw).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "").replaceAll("\t", "  ").trimEnd();
		const blank = line.length === 0;
		if (blank && previousBlank) continue;
		out.push(line);
		previousBlank = blank;
	}
	while (out[0] === "") out.shift();
	while (out.at(-1) === "") out.pop();
	return out;
}

function assistantEntryLines(message: SessionMessage): string[] {
	let status = "assistant";
	if (message.errorMessage)
		status = `assistant ERROR (${message.stopReason ?? "error"}): ${message.errorMessage}`;
	else if (message.stopReason && message.stopReason !== "stop")
		status = `assistant (${message.stopReason})`;
	return [status, ...contentLines(message.content)];
}

function toolResultEntryLines(message: SessionMessage): string[] {
	const error = message.isError ? " ERROR" : "";
	return [
		`tool result · ${message.toolName ?? "unknown"}${error}`,
		...contentLines(message.content),
	];
}

function bashEntryLines(message: SessionMessage): string[] {
	const status = message.cancelled
		? "cancelled"
		: `exit ${message.exitCode ?? "?"}`;
	return [
		`bash · ${status}`,
		message.command ? `$ ${message.command}` : "",
		...splitLines(message.output ?? ""),
	];
}

const MESSAGE_RENDERERS: Record<string, (message: SessionMessage) => string[]> =
	{
		assistant: assistantEntryLines,
		user: (message) => ["user", ...contentLines(message.content)],
		toolResult: toolResultEntryLines,
		bashExecution: bashEntryLines,
		custom: (message) => [
			`extension · ${message.customType ?? "custom"}`,
			...contentLines(message.content),
		],
		compactionSummary: (message) => [
			"compaction summary",
			message.summary ?? "",
		],
		branchSummary: (message) => ["branch summary", message.summary ?? ""],
	};

function messageEntryLines(message: SessionMessage): string[] {
	const role = message.role ?? "message";
	return (
		MESSAGE_RENDERERS[role]?.(message) ?? [
			role,
			...contentLines(message.content),
		]
	);
}

function entryLines(entry: SessionEntry): string[] {
	if (entry.type === "message")
		return messageEntryLines(entry.message as SessionMessage);
	if (entry.type === "custom_message")
		return [
			`extension · ${entry.customType}`,
			...contentLines(entry.content as string | ContentBlock[]),
		];
	if (entry.type === "thinking_level_change")
		return [`thinking level → ${entry.thinkingLevel}`];
	if (entry.type === "model_change")
		return [`model → ${entry.provider}/${entry.modelId}`];
	if (entry.type === "compaction") return ["compaction", entry.summary];
	if (entry.type === "branch_summary") return ["branch summary", entry.summary];
	if (entry.type === "session_info")
		return entry.name ? [`session name → ${entry.name}`] : [];
	if (entry.type === "label")
		return entry.label ? [`label → ${entry.label}`] : [];
	if (entry.type === "custom") return [`extension state · ${entry.customType}`];
	return [];
}

function boundedTail(
	blocks: string[][],
	maxChars: number,
	maxEntries: number,
	hiddenBefore = false,
): string[] {
	const selected: string[][] = [];
	let chars = 0;
	for (
		let index = blocks.length - 1;
		index >= 0 && selected.length < maxEntries;
		index--
	) {
		const block = cleanLines(blocks[index] ?? []);
		if (block.length === 0) continue;
		const size = block.reduce((total, line) => total + line.length + 1, 0);
		if (selected.length > 0 && chars + size > maxChars) break;
		selected.push(block);
		chars += size;
	}
	const ordered: string[][] = [];
	for (let index = selected.length - 1; index >= 0; index--)
		ordered.push(selected[index] ?? []);
	const lines = ordered.flatMap((block, index) =>
		index === ordered.length - 1 ? block : [...block, ""],
	);
	if (hiddenBefore || ordered.length < blocks.filter((block) => block.length > 0).length)
		lines.unshift("… earlier session entries hidden …", "");
	const text = lines.join("\n");
	if (text.length <= maxChars) return lines;
	if (maxChars <= 2) return maxChars > 0 ? ["…"] : [];
	let tail = text.slice(-(maxChars - 2));
	if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
	return ["…", ...splitLines(tail)];
}

function readBytes(file: string, offset: number, length: number): Buffer {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		return buffer.subarray(0, readSync(fd, buffer, 0, length, offset));
	} finally { closeSync(fd); }
}

function rememberEntry(state: CachedTranscript, entry: SessionEntry): void {
	if (state.nodes.has(entry.id)) return;
	const lines = boundedTail([entryLines(entry)], state.maxChars, 1);
	state.nodes.set(entry.id, { parentId: entry.parentId, lines });
	state.chars += lines.join("\n").length;
	state.leaf = entry.id;
	while (state.nodes.size > 512 || state.chars > 4 * state.maxChars) {
		const id = state.nodes.keys().next().value!;
		state.chars -= state.nodes.get(id)!.lines.join("\n").length;
		state.nodes.delete(id);
	}
}

function loadTranscript(file: string, maxChars: number, maxEntries: number): CachedTranscript {
	// SessionManager.open may repair files. Preview through Pi's pure parser.
	const parsed = parseSessionEntries(readFileSync(file, "utf8"));
	if (parsed[0]?.type !== "session") throw new Error("Invalid session transcript header");
	migrateSessionEntries(parsed);
	const entries = new Map<string, SessionEntry>();
	for (const entry of parsed) if (entry.type !== "session") entries.set(entry.id, entry);
	const tail: SessionEntry[] = [];
	const seen = new Set<string>();
	let id: string | null = Array.from(entries.keys()).at(-1) ?? null;
	while (id && tail.length < 512) {
		if (seen.has(id)) throw new Error("Cyclic session transcript");
		seen.add(id);
		const entry = entries.get(id);
		if (!entry) break;
		tail.push(entry);
		id = entry.parentId;
	}
	const state: CachedTranscript = { mtimeMs: 0, size: 0, dev: 0, ino: 0, maxChars, maxEntries,
		partial: false, leaf: null, chars: 0, nodes: new Map(), transcript: { file, lines: [] } };
	for (const entry of tail.reverse()) rememberEntry(state, entry);
	return state;
}

export function readSessionTranscript(
	file: string | undefined,
	maxChars = 32_000,
	maxEntries = 120,
): SessionTranscript {
	if (!file) return { lines: [] };
	maxChars = Math.max(0, Math.min(32_000, Math.floor(maxChars)));
	maxEntries = Math.max(0, Math.min(120, Math.floor(maxEntries)));
	if (!maxChars || !maxEntries) return { file, lines: [] };
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(file);
	} catch (error) {
		return {
			file,
			lines: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const cached = cache.get(file);
	const sameFile = cached && cached.dev === stat.dev && cached.ino === stat.ino
		&& cached.maxChars === maxChars && cached.maxEntries === maxEntries;
	if (sameFile && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		cache.delete(file); cache.set(file, cached);
		return cached.transcript;
	}

	try {
		let state: CachedTranscript;
		if (sameFile && !cached.partial && stat.size > cached.size && stat.size - cached.size <= 16 * 1024 * 1024) {
			state = cached;
			try {
				const bytes = readBytes(file, cached.size, stat.size - cached.size);
				if (bytes.length !== stat.size - cached.size || bytes.at(-1) !== 10) throw new Error("Incomplete append");
				for (const line of bytes.toString("utf8").split("\n")) {
					if (!line.trim()) continue;
					const entry = JSON.parse(line) as SessionEntry;
					if (!entry || typeof entry.id !== "string" || !(entry.parentId === null || typeof entry.parentId === "string")
						|| entry.id === entry.parentId) throw new Error("Invalid transcript entry");
					if (entry.parentId && entry.parentId !== state.leaf && !state.nodes.has(entry.parentId))
						throw new Error("Branch ancestor is outside the cached tail");
					rememberEntry(state, entry);
				}
			} catch { state = loadTranscript(file, maxChars, maxEntries); }
		} else state = loadTranscript(file, maxChars, maxEntries);
		const blocks: string[][] = [];
		const seen = new Set<string>();
		let id = state.leaf;
		while (id && state.nodes.has(id)) {
			if (seen.has(id)) throw new Error("Cyclic session transcript");
			seen.add(id);
			const node = state.nodes.get(id)!;
			blocks.push(node.lines);
			id = node.parentId;
		}
		state.transcript = { file, lines: boundedTail(blocks.reverse(), maxChars, maxEntries, !!id) };
		Object.assign(state, { mtimeMs: stat.mtimeMs, size: stat.size, dev: stat.dev, ino: stat.ino,
			partial: stat.size > 0 && readBytes(file, stat.size - 1, 1)[0] !== 10 });
		cache.delete(file); cache.set(file, state);
		if (cache.size > 16) cache.delete(cache.keys().next().value!);
		return state.transcript;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (cached) return { ...cached.transcript, error: message };
		return { file, lines: [], error: message };
	}
}
