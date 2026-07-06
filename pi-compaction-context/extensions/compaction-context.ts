type ContextFile = {
	path: string;
	content: string;
};

type BuildSystemPromptOptions = {
	contextFiles?: ContextFile[];
	customPrompt?: string;
	appendSystemPrompt?: string;
};

type BeforeAgentStartEvent = {
	systemPrompt: string;
	systemPromptOptions?: BuildSystemPromptOptions;
};

type BeforeProviderRequestEvent = {
	payload: unknown;
};

type ExtensionContext = {
	cwd: string;
	sessionManager?: {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
	getSystemPrompt?: () => string;
	ui?: {
		notify?: (message: string, level?: "info" | "warning" | "error") => void;
	};
};

type PiLike = {
	on(
		event: "before_agent_start",
		handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => void,
	): void;
	on(
		event: "before_provider_request",
		handler: (
			event: BeforeProviderRequestEvent,
			ctx: ExtensionContext,
		) => unknown,
	): void;
	registerCommand?: (
		name: string,
		command: {
			description: string;
			handler: (args: string, ctx: ExtensionContext) => void;
		},
	) => void;
	sendMessage?: (
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options?: { triggerTurn?: boolean },
	) => void;
};

type ContextSnapshot = {
	contextFiles: ContextFile[];
	customPrompt?: string;
	appendSystemPrompt?: string;
	capturedAt: number;
	source: "before_agent_start" | "system_prompt";
};

type PatchStats = {
	requestsSeen: number;
	requestsPatched: number;
	lastPatchedAt?: number;
	lastContextBytes?: number;
	lastContextFiles?: string[];
};

const CUSTOM_TYPE = "pi-compaction-context-status";
const INJECTION_OPEN = '<pi_compaction_context version="1">';
const INJECTION_CLOSE = "</pi_compaction_context>";
const INJECTION_MARKER = "<pi_compaction_context";

const PRIMARY_COMPACTION_MARKERS = [
	"The messages above are a conversation to summarize.",
	"The messages above are NEW conversation messages to incorporate",
	"This is the PREFIX of a turn that was too large to keep.",
	"Create a structured context checkpoint summary",
];

const FALLBACK_COMPACTION_MARKERS = [
	"You are a context summarization assistant.",
	"ONLY output the structured summary.",
];

const MAX_TOTAL_CONTEXT_CHARS = 32_000;
const MAX_FILE_CONTEXT_CHARS = 12_000;
const MAX_PROMPT_CONTEXT_CHARS = 8_000;
const TRUNCATION_SUFFIX = "\n[content truncated for compaction context]";

const snapshotsBySession: Record<string, ContextSnapshot> = Object.create(
	null,
) as Record<string, ContextSnapshot>;
const stats: PatchStats = { requestsSeen: 0, requestsPatched: 0 };
let enabled = true;

function sessionKey(ctx: ExtensionContext): string {
	return (
		ctx.sessionManager?.getSessionId?.() ||
		ctx.sessionManager?.getSessionFile?.() ||
		ctx.cwd ||
		"unknown"
	);
}

function cleanContextFile(file: unknown): ContextFile | undefined {
	if (!file || typeof file !== "object") return undefined;
	const record = file as Record<string, unknown>;
	const path = typeof record.path === "string" ? record.path : undefined;
	const content =
		typeof record.content === "string" ? record.content : undefined;
	if (!path || content === undefined) return undefined;
	return { path, content };
}

function captureSnapshot(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
): void {
	const options = event.systemPromptOptions;
	const contextFiles: ContextFile[] = [];
	for (const file of options?.contextFiles ?? []) {
		const cleaned = cleanContextFile(file);
		if (cleaned) contextFiles.push(cleaned);
	}

	snapshotsBySession[sessionKey(ctx)] = {
		contextFiles,
		customPrompt: options?.customPrompt,
		appendSystemPrompt: options?.appendSystemPrompt,
		capturedAt: Date.now(),
		source: "before_agent_start",
	};
}

function decodeXmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function parseContextFilesFromSystemPrompt(
	systemPrompt: string,
): ContextFile[] {
	const files: ContextFile[] = [];
	const pattern =
		/<project_instructions\s+path="([^"]*)">\n?([\s\S]*?)\n?<\/project_instructions>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(systemPrompt)) !== null) {
		files.push({
			path: decodeXmlAttribute(match[1] ?? ""),
			content: match[2] ?? "",
		});
	}
	return files;
}

function snapshotFromSystemPrompt(
	ctx: ExtensionContext,
): ContextSnapshot | undefined {
	const systemPrompt = ctx.getSystemPrompt?.();
	if (!systemPrompt) return undefined;
	const contextFiles = parseContextFilesFromSystemPrompt(systemPrompt);
	if (contextFiles.length === 0) return undefined;
	return {
		contextFiles,
		capturedAt: Date.now(),
		source: "system_prompt",
	};
}

function currentSnapshot(ctx: ExtensionContext): ContextSnapshot | undefined {
	const cached = snapshotsBySession[sessionKey(ctx)];
	if (cached && snapshotHasContent(cached)) return cached;
	return snapshotFromSystemPrompt(ctx) ?? cached;
}

function snapshotHasContent(snapshot: ContextSnapshot): boolean {
	return (
		snapshot.contextFiles.length > 0 ||
		Boolean(snapshot.customPrompt?.trim()) ||
		Boolean(snapshot.appendSystemPrompt?.trim())
	);
}

function truncateForBudget(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`;
}

function appendBudgeted(
	sections: string[],
	section: string,
	remaining: { chars: number },
): void {
	if (remaining.chars <= 0) return;
	const text = truncateForBudget(section, remaining.chars);
	sections.push(text);
	remaining.chars -= text.length;
}

function buildInjection(snapshot: ContextSnapshot): string | undefined {
	const sections: string[] = [];
	const remaining = { chars: MAX_TOTAL_CONTEXT_CHARS };

	const intro = [
		INJECTION_OPEN,
		"These are active Pi context instructions for the compaction checkpoint writer.",
		"Apply them while producing the summary. Preserve task-specific user preferences and constraints from the conversation, and reference standing project rules by path when useful.",
	].join("\n");
	appendBudgeted(sections, intro, remaining);

	for (const file of snapshot.contextFiles) {
		const body = truncateForBudget(file.content, MAX_FILE_CONTEXT_CHARS);
		appendBudgeted(
			sections,
			`<project_instructions path="${escapeXmlAttribute(file.path)}">\n${body}\n</project_instructions>`,
			remaining,
		);
	}

	if (snapshot.customPrompt?.trim()) {
		appendBudgeted(
			sections,
			`<custom_system_prompt>\n${truncateForBudget(snapshot.customPrompt.trim(), MAX_PROMPT_CONTEXT_CHARS)}\n</custom_system_prompt>`,
			remaining,
		);
	}

	if (snapshot.appendSystemPrompt?.trim()) {
		appendBudgeted(
			sections,
			`<appended_system_prompt>\n${truncateForBudget(snapshot.appendSystemPrompt.trim(), MAX_PROMPT_CONTEXT_CHARS)}\n</appended_system_prompt>`,
			remaining,
		);
	}

	if (sections.length <= 1) return undefined;
	sections.push(INJECTION_CLOSE);
	return `\n\n${sections.join("\n\n")}`;
}

function stringContains(text: string, marker: string): boolean {
	return text.split(marker).length > 1;
}

function arrayContains<T>(items: T[], item: T): boolean {
	for (const current of items) {
		if (current === item) return true;
	}
	return false;
}

function arrayCopy<T>(items: T[]): T[] {
	const copy: T[] = [];
	for (const item of items) copy.push(item);
	return copy;
}

function hasAnyMarker(text: string, markers: string[]): boolean {
	return markers.some((marker) => stringContains(text, marker));
}

function replaceFirstString(
	value: unknown,
	predicate: (text: string) => boolean,
	replace: (text: string) => string,
	seen: object[] = [],
): { value: unknown; changed: boolean } {
	if (typeof value === "string") {
		return predicate(value)
			? { value: replace(value), changed: true }
			: { value, changed: false };
	}
	if (!value || typeof value !== "object") return { value, changed: false };
	if (arrayContains(seen, value)) return { value, changed: false };
	seen.push(value);

	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const result = replaceFirstString(value[index], predicate, replace, seen);
			if (result.changed) {
				const copy = arrayCopy(value);
				copy[index] = result.value;
				return { value: copy, changed: true };
			}
		}
		return { value, changed: false };
	}

	const record = value as Record<string, unknown>;
	const priorityKeys = [
		"text",
		"content",
		"input",
		"messages",
		"instructions",
		"system",
	];
	const keys = priorityKeys
		.filter((key) => key in record)
		.concat(
			Object.keys(record).filter((key) => !arrayContains(priorityKeys, key)),
		);
	for (const key of keys) {
		const result = replaceFirstString(record[key], predicate, replace, seen);
		if (result.changed) {
			return { value: { ...record, [key]: result.value }, changed: true };
		}
	}
	return { value, changed: false };
}

function contentTexts(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		out.push(value);
		return out;
	}
	if (!value || typeof value !== "object") return out;
	if (Array.isArray(value)) {
		for (const item of value) contentTexts(item, out);
		return out;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.text === "string") out.push(record.text);
	if (typeof record.content === "string") out.push(record.content);
	if (record.content && typeof record.content === "object")
		contentTexts(record.content, out);
	return out;
}

function systemLikeTexts(payload: unknown): string[] {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return [];
	const record = payload as Record<string, unknown>;
	const out: string[] = [];

	for (const key of ["instructions", "system", "system_instruction"]) {
		contentTexts(record[key], out);
	}

	for (const key of ["messages", "input"]) {
		const items: unknown[] = Array.isArray(record[key])
			? (record[key] as unknown[])
			: [];
		for (const item of items) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const itemRecord = item as Record<string, unknown>;
			if (itemRecord.role === "system")
				contentTexts(itemRecord.content ?? itemRecord.text, out);
		}
	}

	return out;
}

function isPiCompactionRequest(payload: unknown): boolean {
	return systemLikeTexts(payload).some((text) =>
		hasAnyMarker(text, FALLBACK_COMPACTION_MARKERS),
	);
}

function patchPayload(
	payload: unknown,
	injection: string,
): { payload: unknown; changed: boolean } {
	if (!isPiCompactionRequest(payload)) {
		return { payload, changed: false };
	}

	const primary = replaceFirstString(
		payload,
		(text) =>
			!stringContains(text, INJECTION_MARKER) &&
			hasAnyMarker(text, PRIMARY_COMPACTION_MARKERS),
		(text) => `${text}${injection}`,
	);
	if (primary.changed) return { payload: primary.value, changed: true };

	const fallback = replaceFirstString(
		payload,
		(text) =>
			!stringContains(text, INJECTION_MARKER) &&
			hasAnyMarker(text, FALLBACK_COMPACTION_MARKERS),
		(text) => `${text}${injection}`,
	);
	return { payload: fallback.value, changed: fallback.changed };
}

function sha16(value: string): string {
	let first = 0x811c9dc5;
	let second = 0x45d9f3b;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		first ^= code;
		first +=
			(first << 1) + (first << 4) + (first << 7) + (first << 8) + (first << 24);
		second ^= code + index;
		second = (second + ((second << 5) - second)) | 0;
	}
	const left = (first >>> 0).toString(16);
	const right = (second >>> 0).toString(16);
	return `00000000${left}`.slice(-8) + `00000000${right}`.slice(-8);
}

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			index += 1;
		} else bytes += 3;
	}
	return bytes;
}

function renderStatus(ctx: ExtensionContext): string {
	const snapshot = currentSnapshot(ctx);
	const files = snapshot?.contextFiles ?? [];
	const fileLines =
		files.length > 0
			? files
					.map(
						(file) =>
							`- ${file.path} (${file.content.length.toLocaleString()} chars)`,
					)
					.join("\n")
			: "- none captured yet";
	return [
		"# Compaction context",
		"",
		`Status: ${enabled ? "on" : "off"}`,
		`Patched requests: ${stats.requestsPatched}/${stats.requestsSeen}`,
		`Last patched: ${stats.lastPatchedAt ? new Date(stats.lastPatchedAt).toLocaleString() : "never"}`,
		`Snapshot source: ${snapshot?.source ?? "none"}`,
		`Snapshot hash: ${snapshot ? sha16(JSON.stringify(snapshot.contextFiles)) : "none"}`,
		"",
		"## Active Markdown context",
		fileLines,
	].join("\n");
}

function showStatus(pi: PiLike, ctx: ExtensionContext): void {
	const content = renderStatus(ctx);
	pi.sendMessage?.(
		{
			customType: CUSTOM_TYPE,
			content,
			display: true,
			details: { enabled, stats, snapshot: currentSnapshot(ctx) },
		},
		{ triggerTurn: false },
	);
}

export default function compactionContext(pi: PiLike): void {
	pi.on("before_agent_start", (event, ctx) => {
		captureSnapshot(event, ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		stats.requestsSeen += 1;
		if (!enabled) return undefined;

		const snapshot = currentSnapshot(ctx);
		if (!snapshot) return undefined;

		const injection = buildInjection(snapshot);
		if (!injection) return undefined;

		const patched = patchPayload(event.payload, injection);
		if (!patched.changed) return undefined;

		stats.requestsPatched += 1;
		stats.lastPatchedAt = Date.now();
		stats.lastContextBytes = utf8ByteLength(injection);
		stats.lastContextFiles = snapshot.contextFiles.map((file) => file.path);
		return patched.payload;
	});

	pi.registerCommand?.("compaction-context", {
		description:
			"Show or toggle Markdown context injection for compaction requests",
		handler: (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "on") {
				enabled = true;
				ctx.ui?.notify?.("Compaction context enabled", "info");
				return;
			}
			if (command === "off") {
				enabled = false;
				ctx.ui?.notify?.("Compaction context disabled", "info");
				return;
			}
			showStatus(pi, ctx);
		},
	});
}
