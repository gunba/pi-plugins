import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_ACTIVE = 32;
export const ACTIVE_LIMIT_ENTRY = "pi-subagents/active-limit-v1";

/** Accepts positive safe integers or decimal digit strings; rejects coercions such as booleans and exponents. */
export function parseActiveLimit(value: unknown): number {
	const limit = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
		throw new Error("Agent limit must be a positive whole number.");
	return limit;
}

/** Conversation-wide metadata survives branch navigation and does not enter the model's messages. */
export function savedActiveLimit(entries: readonly SessionEntry[]): number {
	let limit = DEFAULT_MAX_ACTIVE;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ACTIVE_LIMIT_ENTRY) continue;
		try { limit = parseActiveLimit((entry.data as { maxActive?: unknown } | null)?.maxActive); }
		catch { /* A malformed entry cannot prevent the conversation from opening. */ }
	}
	return limit;
}
