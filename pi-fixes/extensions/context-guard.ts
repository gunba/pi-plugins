import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { estimateTokens, formatSize } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AgentMessage = Parameters<typeof estimateTokens>[0];
type AnyMessage = AgentMessage & Record<string, any>;

type Settings = {
	enabled: boolean;
	maxMessageTokens: number;
	sanitizeLatestUserMessage: boolean;
	showNotifications: boolean;
};

type StripRecord = {
	fingerprint: string;
	label: string;
	originalTokens: number;
	originalBytes: number;
	limitTokens: number;
	savedFile?: string;
	saveError?: string;
};

const NAME = "pi-context-guard";
const BASE_DIR = process.env.PI_CONTEXT_GUARD_DIR || join(homedir(), ".pi", "agent", "context-guard");
const SETTINGS_FILE = process.env.PI_CONTEXT_GUARD_SETTINGS || join(BASE_DIR, "settings.json");
const OUTPUT_DIR = process.env.PI_CONTEXT_GUARD_OUTPUT_DIR || join(BASE_DIR, "stripped");
const DEFAULT_SETTINGS: Settings = {
	enabled: true,
	maxMessageTokens: 50_000,
	sanitizeLatestUserMessage: false,
	showNotifications: true,
};
const MAX_NOTIFIED_FINGERPRINTS = 256;
const EFFECTIVENESS_KEY = Symbol.for("pi.fixes.effectiveness");

function recordFix(fixId: string, count = 1): void {
	try {
		const tracker = (globalThis as Record<symbol, unknown>)[EFFECTIVENESS_KEY] as { record?: (id: string, n?: number) => void } | undefined;
		tracker?.record?.(fixId, count);
	} catch {
		// Effectiveness tracking is best-effort and must never disrupt the fix.
	}
}

let settingsLoadError: string | undefined;
let settings = withEnv(loadSettings());
let stripCount = 0;
let lastStrip: StripRecord | undefined;
const notifiedOrder: string[] = [];
const notified = new Set<string>();
const savedFiles = new Map<string, string>();

function bool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enable", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disable", "disabled"].includes(normalized)) return false;
	return fallback;
}

function positiveInt(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalize(raw: Partial<Settings>): Settings {
	return {
		enabled: bool(raw.enabled, DEFAULT_SETTINGS.enabled),
		maxMessageTokens: positiveInt(raw.maxMessageTokens, DEFAULT_SETTINGS.maxMessageTokens),
		sanitizeLatestUserMessage: bool(raw.sanitizeLatestUserMessage, DEFAULT_SETTINGS.sanitizeLatestUserMessage),
		showNotifications: bool(raw.showNotifications, DEFAULT_SETTINGS.showNotifications),
	};
}

function loadSettings(): Settings {
	try {
		settingsLoadError = undefined;
		return normalize(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<Settings>);
	} catch (error) {
		if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") return { ...DEFAULT_SETTINGS };
		settingsLoadError = `could not read ${SETTINGS_FILE}: ${error instanceof Error ? error.message : String(error)}`;
		return { ...DEFAULT_SETTINGS, enabled: false };
	}
}

function withEnv(base: Settings): Settings {
	return {
		...base,
		enabled: bool(process.env.PI_CONTEXT_GUARD_ENABLED ?? process.env.PI_CONTEXT_GUARD, base.enabled),
		maxMessageTokens: positiveInt(process.env.PI_CONTEXT_GUARD_MAX_MESSAGE_TOKENS, base.maxMessageTokens),
		sanitizeLatestUserMessage: bool(process.env.PI_CONTEXT_GUARD_USER_MESSAGES, base.sanitizeLatestUserMessage),
		showNotifications: bool(process.env.PI_CONTEXT_GUARD_NOTIFY, base.showNotifications),
	};
}

function writeFileAtomic(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tempFile, content, "utf8");
		renameSync(tempFile, file);
	} catch (error) {
		rmSync(tempFile, { force: true });
		throw error;
	}
}

function saveSettings(): void {
	writeFileAtomic(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

function parseTokens(text: string): number | undefined {
	const match = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
	if (!match) return undefined;
	const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	const tokens = Math.floor(Number(match[1]) * multiplier);
	return tokens > 0 ? tokens : undefined;
}

function tokenText(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
	if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k tokens`;
	return `${tokens} tokens`;
}

function safeEstimate(message: AgentMessage): number {
	try {
		return estimateTokens(message);
	} catch {
		return Math.ceil(Buffer.byteLength(JSON.stringify(message), "utf8") / 4);
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			if (part?.type === "thinking" && typeof part.thinking === "string") return part.thinking;
			if (part?.type === "toolCall") return `Tool call: ${part.name ?? "unknown"}\nArguments:\n${JSON.stringify(part.arguments ?? {}, null, 2)}`;
			return "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function contentBytes(content: unknown): number {
	return Buffer.byteLength(contentText(content), "utf8");
}

function originalText(message: AnyMessage): string {
	if (message.role === "bashExecution") return `Command:\n${message.command ?? ""}\n\nOutput:\n${message.output ?? ""}`;
	if (message.role === "branchSummary" || message.role === "compactionSummary") return String(message.summary ?? "");
	const text = contentText(message.content);
	return text.length > 0 ? text : JSON.stringify(message, null, 2);
}

function messageBytes(message: AnyMessage): number {
	if (message.role === "bashExecution") return Buffer.byteLength(`${message.command ?? ""}${message.output ?? ""}`, "utf8");
	if (message.role === "branchSummary" || message.role === "compactionSummary") return Buffer.byteLength(String(message.summary ?? ""), "utf8");
	return contentBytes(message.content);
}

function latestUserIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as AnyMessage).role === "user") return i;
	}
	return -1;
}

function canStrip(message: AgentMessage, index: number, latestUser: number): boolean {
	return (message as AnyMessage).role !== "user" || settings.sanitizeLatestUserMessage || index !== latestUser;
}

function label(message: AnyMessage, index: number): string {
	if (message.role === "toolResult") return `message ${index + 1} tool result${message.toolName ? ` from ${message.toolName}` : ""}`;
	if (message.role === "custom") return `message ${index + 1} custom message${message.customType ? ` ${message.customType}` : ""}`;
	if (message.role === "bashExecution") return `message ${index + 1} bash output`;
	return `message ${index + 1} ${message.role ?? "unknown"}`;
}

function stripRecord(message: AgentMessage, index: number, originalTokens: number): StripRecord {
	const anyMessage = message as AnyMessage;
	return {
		fingerprint: `${index}:${anyMessage.role ?? "unknown"}:${anyMessage.toolCallId ?? anyMessage.toolName ?? anyMessage.customType ?? ""}:${originalTokens}`,
		label: label(anyMessage, index),
		originalTokens,
		originalBytes: messageBytes(anyMessage),
		limitTokens: settings.maxMessageTokens,
	};
}

function safeFileStem(record: StripRecord): string {
	const slug = record.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "context";
	const hash = createHash("sha256").update(record.fingerprint).digest("hex").slice(0, 12);
	return `${slug}-${hash}`;
}

function metadataFor(message: AnyMessage, record: StripRecord): Record<string, unknown> {
	return {
		extension: NAME,
		label: record.label,
		role: message.role,
		toolName: message.toolName,
		toolCallId: message.toolCallId,
		customType: message.customType,
		isError: message.isError,
		stopReason: message.stopReason,
		timestamp: message.timestamp,
		originalTokens: record.originalTokens,
		originalBytes: record.originalBytes,
		limitTokens: record.limitTokens,
		fingerprint: record.fingerprint,
		savedAt: new Date().toISOString(),
	};
}

function markdownFor(message: AgentMessage, record: StripRecord): string {
	const anyMessage = message as AnyMessage;
	return [
		"# Stripped Pi context",
		"",
		"This file contains context that pi-context-guard removed from a model request because the single message was too large.",
		"",
		"## Metadata",
		"",
		"```json",
		JSON.stringify(metadataFor(anyMessage, record), null, 2),
		"```",
		"",
		"## Original text",
		"",
		originalText(anyMessage),
		"",
	].join("\n");
}

function saveOriginal(message: AgentMessage, record: StripRecord): StripRecord {
	const existing = savedFiles.get(record.fingerprint);
	if (existing) return { ...record, savedFile: existing };
	const file = join(OUTPUT_DIR, `${safeFileStem(record)}.md`);
	try {
		writeFileAtomic(file, markdownFor(message, record));
		savedFiles.set(record.fingerprint, file);
		return { ...record, savedFile: file };
	} catch (error) {
		return { ...record, saveError: error instanceof Error ? error.message : String(error) };
	}
}

function strippedText(record: StripRecord): string {
	const location = record.savedFile
		? ` Original content was saved to ${record.savedFile}. Use read/grep or another narrow inspection tool if the data is still needed.`
		: ` Original content could not be saved to disk: ${record.saveError ?? "unknown error"}.`;
	return `[${NAME}] ${record.label} was stripped before the model request because it exceeded the per-message guardrail of ${tokenText(record.limitTokens)}. ` +
		`Original size was approximately ${tokenText(record.originalTokens)} (${formatSize(record.originalBytes)} text).` +
		location;
}

function withGuardDetails(details: unknown, record: StripRecord, originalIsError?: boolean): unknown {
	const contextGuard = { extension: NAME, ...record, strippedAt: new Date().toISOString(), originalIsError };
	return details && typeof details === "object" && !Array.isArray(details) ? { ...(details as Record<string, unknown>), contextGuard } : { contextGuard };
}

function strippedMessage(message: AgentMessage, record: StripRecord): AgentMessage {
	const anyMessage = message as AnyMessage;
	const content = [{ type: "text" as const, text: strippedText(record) }];
	if (anyMessage.role === "toolResult") return { ...anyMessage, content, details: withGuardDetails(anyMessage.details, record, anyMessage.isError === true), isError: true } as AgentMessage;
	if (anyMessage.role === "assistant") return { ...anyMessage, content: [...content, ...(Array.isArray(anyMessage.content) ? anyMessage.content.filter((part) => part?.type === "toolCall") : [])] } as AgentMessage;
	if (anyMessage.role === "custom") return { ...anyMessage, content: content[0].text, details: withGuardDetails(anyMessage.details, record) } as AgentMessage;
	if (anyMessage.role === "bashExecution") return { ...anyMessage, output: content[0].text, truncated: true, fullOutputPath: record.savedFile } as AgentMessage;
	if (anyMessage.role === "branchSummary" || anyMessage.role === "compactionSummary") return { ...anyMessage, summary: content[0].text } as AgentMessage;
	return { ...anyMessage, content } as AgentMessage;
}

function stripOversizedMessages(messages: AgentMessage[]): { messages: AgentMessage[]; records: StripRecord[] } | undefined {
	const latestUser = latestUserIndex(messages);
	let next = messages;
	const records: StripRecord[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (!canStrip(messages[i], i, latestUser)) continue;
		const tokens = safeEstimate(messages[i]);
		if (tokens <= settings.maxMessageTokens) continue;
		const record = saveOriginal(messages[i], stripRecord(messages[i], i, tokens));
		if (next === messages) next = messages.slice();
		next[i] = strippedMessage(messages[i], record);
		records.push(record);
	}
	return records.length > 0 ? { messages: next, records } : undefined;
}

function remember(record: StripRecord): boolean {
	if (notified.has(record.fingerprint)) return false;
	notified.add(record.fingerprint);
	notifiedOrder.push(record.fingerprint);
	while (notifiedOrder.length > MAX_NOTIFIED_FINGERPRINTS) notified.delete(notifiedOrder.shift() ?? "");
	return true;
}

function report(records: StripRecord[], ctx: ExtensionContext): void {
	const fresh = records.filter(remember);
	if (fresh.length === 0) return;
	stripCount += fresh.length;
	// A fresh oversized item was just stripped before it could reach the model:
	// this is the moment the fix prevents its failure case.
	recordFix("context-guard-strip", fresh.length);
	lastStrip = fresh[fresh.length - 1];
	if (!ctx.hasUI || !settings.showNotifications) return;
	const largest = fresh.reduce((best, item) => (item.originalTokens > best.originalTokens ? item : best), fresh[0]);
	const location = largest.savedFile ? ` Saved to ${largest.savedFile}.` : "";
	ctx.ui.notify(`${NAME} stripped ${fresh.length} oversized context item${fresh.length === 1 ? "" : "s"}; largest was ${largest.label} at ${tokenText(largest.originalTokens)}.${location}`, "warning");
}

function status(): string {
	return [
		`${NAME}: ${settings.enabled ? "on" : "off"}`,
		`settings: ${SETTINGS_FILE}`,
		`stripped files: ${OUTPUT_DIR}`,
		`per-message limit: ${tokenText(settings.maxMessageTokens)}`,
		`latest user prompt: ${settings.sanitizeLatestUserMessage ? "guarded" : "protected"}`,
		`notifications: ${settings.showNotifications ? "on" : "off"}`,
		`stripped this runtime: ${stripCount}`,
		lastStrip ? `last: ${lastStrip.label} (${tokenText(lastStrip.originalTokens)})${lastStrip.savedFile ? ` -> ${lastStrip.savedFile}` : ""}` : "last: none",
		settingsLoadError ? `warning: ${settingsLoadError}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function setSettings(patch: Partial<Settings>): void {
	settings = { ...settings, ...patch };
	saveSettings();
}

export default function contextGuard(pi: ExtensionAPI) {
	// One hook, one invariant: every provider request is built from this context.
	// This catches automatic tool-call continuations before a huge result can hit the model.
	pi.on("context", (event, ctx) => {
		if (!settings.enabled) return;
		const stripped = stripOversizedMessages(event.messages);
		if (!stripped) return;
		report(stripped.records, ctx);
		return { messages: stripped.messages };
	});

	pi.registerCommand("context-guard", {
		description: "Show or configure oversized-message stripping before provider requests",
		handler: async (args, ctx) => {
			const input = args.trim().toLowerCase();
			if (!input || input === "status") return ctx.ui.notify(status(), "info");
			if (["on", "enable", "enabled"].includes(input)) {
				setSettings({ enabled: true });
				return ctx.ui.notify(`${NAME} enabled`, "info");
			}
			if (["off", "disable", "disabled"].includes(input)) {
				setSettings({ enabled: false });
				return ctx.ui.notify(`${NAME} disabled`, "info");
			}

			const max = input.match(/^(?:max|message|max-message)\s+(.+)$/);
			if (max) {
				const value = parseTokens(max[1]);
				if (!value) return ctx.ui.notify("Usage: /context-guard max 50k", "warning");
				setSettings({ maxMessageTokens: value });
				return ctx.ui.notify(`${NAME} per-message limit set to ${tokenText(value)}`, "info");
			}

			const user = input.match(/^user\s+(on|off|enable|disable)$/);
			if (user) {
				const enabled = ["on", "enable"].includes(user[1]);
				setSettings({ sanitizeLatestUserMessage: enabled });
				return ctx.ui.notify(`${NAME} latest-user guarding ${enabled ? "enabled" : "disabled"}`, "info");
			}

			const notify = input.match(/^notif(?:y|ications)?\s+(on|off|enable|disable)$/);
			if (notify) {
				const enabled = ["on", "enable"].includes(notify[1]);
				setSettings({ showNotifications: enabled });
				return ctx.ui.notify(`${NAME} notifications ${enabled ? "enabled" : "disabled"}`, "info");
			}

			return ctx.ui.notify(`${status()}\n\nCommands: /context-guard status | on | off | max 50k | user on|off | notify on|off`, "info");
		},
	});
}
