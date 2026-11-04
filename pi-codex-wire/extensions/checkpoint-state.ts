import type { ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { object } from "./diagnostics.ts";

export const CHECKPOINT = "codexWireCheckpoint";
export const SESSION_WINDOW_ENTRY = "codex-wire-session-window";

/**
 * Where a model other than Codex can read this context from: the messages the latest checkpoint kept, and those after
 * it. A compaction keeping from here leaves the encrypted checkpoint out, since Pi gives an older compaction inside a
 * kept range no messages. null when nothing after the checkpoint is readable.
 */
export function readableContextStart(entries: readonly ProjectedSessionEntry[]): string | null {
	let last = entries.length - 1;
	while (last >= 0 && !(entries[last]!.messages.length && entryCheckpoint(entries[last]!.sourceEntry) !== undefined)) last--;
	const source = entries[last]?.sourceEntry;
	if (!source) return null;
	return source.type === "compaction" ? source.firstKeptEntryId : entries[last + 1]?.sourceEntry.id ?? null;
}

export function entryCheckpoint(entry: SessionEntry): unknown {
	if (entry.type === "compaction" || entry.type === "branch_summary") return object(entry.details)[CHECKPOINT];
	if (entry.type === "custom_message" && entry.customType === "pi-subagents/fork-summary-v1") {
		return object(object(entry.details).sourceDetails)[CHECKPOINT];
	}
	return undefined;
}
