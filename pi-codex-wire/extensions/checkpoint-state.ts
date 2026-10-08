import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { object } from "./diagnostics.ts";

export const CHECKPOINT = "codexWireCheckpoint";
export const SESSION_WINDOW_ENTRY = "codex-wire-session-window";

export function portableContextUnchanged(branch: readonly SessionEntry[], leaf: string | null): boolean {
	const anchor = branch.findIndex(entry => entry.id === leaf);
	return anchor >= 0 && branch.slice(anchor + 1).every(entry =>
		entry.type === "custom" && entry.customType === SESSION_WINDOW_ENTRY);
}

type PortableSummary = (signal: AbortSignal, maxTokens: number) => Promise<{ summary: string; usage: import("@earendil-works/pi-ai").Usage }>;
const portableKey = Symbol.for("pi.codex-wire.portable-summary.v1");
const shared = globalThis as typeof globalThis & { [portableKey]?: Map<string, PortableSummary> };
const portable = shared[portableKey] ??= new Map<string, PortableSummary>();

export function registerPortableSummary(sessionId: string, summarize: PortableSummary): () => void {
	portable.set(sessionId, summarize);
	return () => { if (portable.get(sessionId) === summarize) portable.delete(sessionId); };
}
export function portableSummaryAvailable(sessionId: string): boolean { return portable.has(sessionId); }
export function summarizePortableContext(sessionId: string, signal: AbortSignal, maxTokens: number): ReturnType<PortableSummary> {
	const summarize = portable.get(sessionId);
	if (!summarize) throw Error("Portable Codex context is unavailable in this worker.");
	return summarize(signal, maxTokens);
}

export function entryCheckpoint(entry: SessionEntry): unknown {
	if (entry.type === "compaction" || entry.type === "branch_summary") return object(entry.details)[CHECKPOINT];
	if (entry.type === "custom_message" && entry.customType === "pi-subagents/fork-summary-v1") {
		return object(object(entry.details).sourceDetails)[CHECKPOINT];
	}
	return undefined;
}
