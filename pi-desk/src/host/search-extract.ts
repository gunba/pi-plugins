import { SEARCH_ORIGIN, SEARCH_PASSAGE_CHARS, type SearchPassage, type SearchRole } from "../shared/conversation-search.ts";
import type { IndexedEntry } from "./search-store.ts";

const REPORTS = new Set(["pi-subagents/notice", "pi-subagents/followup", "pi-party/message"]);
const SEARCH_TOOLS = new Set(["conversation_search", "conversation_read"]);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const bounded = (value: unknown, maximum: number): string | undefined => typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;

export interface NativeSearchHeader { session: string; project: string }
export function nativeSearchHeader(value: unknown): NativeSearchHeader | undefined {
	const row = record(value);
	if (row?.type !== "session" || !bounded(row.id, 200) || typeof row.cwd !== "string" || row.cwd.length > 4096) return;
	if (row.version !== undefined && (!Number.isInteger(row.version) || Number(row.version) < 1 || Number(row.version) > 3)) return;
	return { session: row.id as string, project: row.cwd };
}
/** This recognizes common credentials, not arbitrary personal information. The index still requires a trusted owner-controlled server. */
export function redactSearchText(text: string): string {
	return text
		.replace(/-----BEGIN[^\r\n-]{0,80}PRIVATE KEY-----[\s\S]{0,16384}?-----END[^\r\n-]{0,80}PRIVATE KEY-----/g, "[private key redacted]")
		.replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
		.replace(/\b(?:sk-(?:proj-|ant-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{16,}|github_pat_[a-zA-Z0-9_]{16,}|AIza[a-zA-Z0-9_-]{30,})\b/g, "[credential redacted]")
		.replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)(?:["']?)\s*[:=]\s*)(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1\"[redacted]\"")
		.replace(/(["']operator["']\s*:\s*["'])[a-zA-Z0-9._~+/=-]{20,}(["'])/gi, "$1[redacted]$2")
		.replace(/([?&](?:api_key|key|token|access_token|auth)=)[^&#\s]+/gi, "$1[redacted]")
		.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(/data:(?:image|audio|video|application)\/[^;,\s]{1,100};base64,[a-zA-Z0-9+/=\r\n]+/gi, "[binary data omitted]")
		.replace(/[a-zA-Z0-9+/]{4096,}={0,2}/g, "[binary data omitted]")
		.trim();
}
function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.flatMap(block => {
		const item = record(block);
		return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
	}).join("\n");
}
/** Non-overlapping passages preserve code and offsets. Whitespace-only spans have no searchable evidence. */
export function searchPieces(text: string): { start: number; text: string }[] {
	const result: { start: number; text: string }[] = [];
	for (let start = 0; start < text.length;) {
		let end = Math.min(text.length, start + SEARCH_PASSAGE_CHARS);
		if (end < text.length) {
			const newline = text.lastIndexOf("\n", end - 1), space = text.lastIndexOf(" ", end - 1);
			const boundary = newline > start + SEARCH_PASSAGE_CHARS / 2 ? newline : space;
			if (boundary > start + SEARCH_PASSAGE_CHARS / 2) end = boundary + 1;
			else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
		}
		const piece = text.slice(start, end);
		if (piece.trim()) result.push({ start, text: piece });
		start = end;
	}
	return result;
}
export interface ExtractedSearchEntry { entry: IndexedEntry; title?: string; root?: string; firstUser?: string }
/** Only native conversation text and explicitly recognized agent reports are included; UI-only messages, image blocks and reasoning are not. */
export function extractSearchEntry(value: unknown, ordinal: number, offset: number): ExtractedSearchEntry | undefined {
	const row = record(value);
	if (!row || row.type === "session") return;
	const id = bounded(row.id, 200) ?? `line:${offset}`, parent = bounded(row.parentId, 200);
	const entry: IndexedEntry = { id, ...(parent ? { parent } : {}), ordinal, passages: [] };
	const result: ExtractedSearchEntry = { entry };
	if (row.type === "session_info" && typeof row.name === "string") result.title = redactSearchText(row.name).slice(0, 300);
	if (row.type === "custom" && row.customType === "pi-subagents/descriptor-v1") {
		const descriptor = record(row.data);
		if (descriptor) { result.title = typeof descriptor.label === "string" ? redactSearchText(descriptor.label).slice(0, 300) : undefined; result.root = bounded(descriptor.rootSessionId, 200); }
	}
	let role: SearchRole | undefined, tool: string | undefined, raw = "", timestamp: unknown = row.timestamp;
	if (row.type === "message") {
		const message = record(row.message);
		if (message) {
			timestamp ??= message.timestamp;
			if (message.role === "user" || message.role === "assistant") { role = message.role; raw = textContent(message.content); }
			else if (message.role === "toolResult") {
				tool = bounded(message.toolName, 200);
				if (!tool || !SEARCH_TOOLS.has(tool)) { role = "tool"; raw = textContent(message.content); }
				// Nested codemode calls retain the origin marker even when their outer tool name changes.
				if (raw.includes(SEARCH_ORIGIN)) raw = "";
			} else if (message.role === "custom" && REPORTS.has(String(message.customType))) { role = "agent"; raw = textContent(message.content); }
		}
	} else if (row.type === "custom_message" && REPORTS.has(String(row.customType))) {
		role = "agent"; raw = textContent(row.content);
	} else if ((row.type === "compaction" || row.type === "branch_summary") && typeof row.summary === "string") {
		role = "assistant"; tool = row.type === "compaction" ? "compaction summary" : "branch summary"; raw = row.summary;
	}
	// Context edits change working context, not native-history retention; they are not independent historical statements.
	if (!role || !raw.trim()) return result;
	const text = redactSearchText(raw);
	if (!text) return result;
	const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
	const at = typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 8.64e15 ? parsed : undefined;
	entry.passages = searchPieces(text).map(piece => ({ ...piece, role, ...(tool ? { tool } : {}), ...(at === undefined ? {} : { at }) } satisfies Omit<SearchPassage, "sequence" | "entry" | "parent" | "ordinal">));
	if (role === "user") result.firstUser = text.replace(/\s+/g, " ").slice(0, 160);
	return result;
}
