import { statSync } from "node:fs";
import {
	SessionManager,
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

function isCustomOnlyTurn(
	branch: readonly SessionEntry[],
	previousAssistant: number,
	currentAssistant: number,
): boolean {
	let customMessageSeen = false;
	for (let index = previousAssistant + 1; index < currentAssistant; index++) {
		const entry = branch[index];
		if (!entry) continue;
		if (entry.type === "custom_message") {
			customMessageSeen = true;
			continue;
		}
		// Session metadata does not make an extension-triggered acknowledgement a
		// new delegated result. Any real conversation or tool activity does.
		if (entry.type === "message") return false;
	}
	return customMessageSeen;
}

/**
 * Select the delegated result from the active session branch.
 *
 * Extension custom messages can arrive after a task has already answered and
 * trigger a second, tool-free acknowledgement. That lifecycle turn must not
 * replace the task answer. A user/parent message or any tool activity starts a
 * real new turn and its later answer remains eligible to replace the old one.
 */
export function publishedAssistantText(
	branch: readonly SessionEntry[],
	fallback = "",
): string {
	const candidates: Array<{ index: number; text: string }> = [];
	for (let index = 0; index < branch.length; index++) {
		const text = publishableAssistantText(branch[index] as SessionEntry);
		if (text) candidates.push({ index, text });
	}
	if (candidates.length === 0) return fallback;

	let selected = candidates.length - 1;
	while (selected > 0) {
		const previous = candidates[selected - 1];
		const current = candidates[selected];
		if (
			!previous ||
			!current ||
			!isCustomOnlyTurn(branch, previous.index, current.index)
		)
			break;
		selected--;
	}
	const primary = candidates[selected]?.text;
	if (!primary) return fallback;
	const followUps = candidates.slice(selected + 1).map(({ text }) => text);
	if (followUps.length === 0) return primary;
	return [
		primary,
		...followUps.map(
			(text) => `## Extension-triggered follow-up\n\n${text}`,
		),
	].join("\n\n---\n\n");
}

type CachedTranscript = {
	mtimeMs: number;
	size: number;
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
		const line = raw.replaceAll("\t", "  ").trimEnd();
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
	if (ordered.length < blocks.filter((block) => block.length > 0).length)
		lines.unshift("… earlier session entries hidden …", "");
	return lines;
}

export function readSessionTranscript(
	file: string | undefined,
	maxChars = 32_000,
	maxEntries = 120,
): SessionTranscript {
	if (!file) return { lines: [] };
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
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
		return cached.transcript;

	try {
		const manager = SessionManager.open(file);
		const blocks = manager.getBranch().map(entryLines);
		const transcript = {
			file,
			lines: boundedTail(blocks, maxChars, maxEntries),
		} satisfies SessionTranscript;
		cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, transcript });
		return transcript;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (cached) return { ...cached.transcript, error: message };
		return { file, lines: [], error: message };
	}
}
