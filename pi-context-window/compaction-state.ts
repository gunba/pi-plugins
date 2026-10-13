import { calculateContextTokens, estimateTokens, type SessionEntry, type SessionProjection } from "@earendil-works/pi-coding-agent";

// Kept free of pi-ai so Desk can read it.
export const COMPACTION_FAILURE_ENTRY = "pi-context-window/compaction-failure";
export const RETRY_AFTER_MINUTES = 15;

export interface Failure { message: string; key: string; at: number; until?: number; reported: boolean }
const stateKey = Symbol.for("pi.compaction-failures.v1");
const shared = globalThis as typeof globalThis & { [stateKey]?: Map<string, Failure> };
// Codex Wire, this extension and Desk load this module separately; they share one record per session.
export const failures = shared[stateKey] ??= new Map();

type ModelLike = { provider: string; id: string; contextWindow: number } | undefined;
type Budget = { reserveTokens: number; keepRecentTokens: number };

/** Everything a repeated compaction depends on. Changing any of it is worth another attempt. */
export function compactionKey(model: ModelLike, settings: Budget, thinking: string | undefined): string {
	return JSON.stringify([model?.provider, model?.id, model?.contextWindow, settings.reserveTokens, settings.keepRecentTokens, thinking]);
}

export function compactionHeld(sessionId: string, key: string, now = Date.now()): boolean {
	const failure = failures.get(sessionId);
	return !!failure && failure.key === key && (failure.until === undefined || now < failure.until);
}

/** Why a compaction started at or after `since` failed: an extension that refuses one can only cancel it. */
export function compactionFailure(sessionId: string, since: number): string | undefined {
	const failure = failures.get(sessionId);
	return failure && failure.at >= since ? failure.message : undefined;
}

/**
 * Context tokens from the last usage the provider reported, plus estimates for later messages. Pi discards that
 * usage when any context edit follows it, even one that only omits a failed reply after it, and estimates every
 * message from its characters instead. That misses encrypted reasoning: it gave 615,034 for a 920,000-token
 * conversation and 527,503 for 996,000, too low to compact. Here only an edit to an entry at or before the usage,
 * or a compaction after it, discards it. Undefined when no reported usage applies.
 */
export function measuredContextTokens(projection: SessionProjection, branch: readonly SessionEntry[]): number | undefined {
	let index = 0, usage: { entryId: string; message: number; tokens: number } | undefined;
	for (const { sourceEntry, messages } of projection.entries) {
		messages.forEach((message, offset) => {
			if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;
			const tokens = calculateContextTokens(message.usage);
			if (tokens > 0) usage = { entryId: sourceEntry.id, message: index + offset, tokens };
		});
		index += messages.length;
	}
	if (!usage) return undefined;
	const order = new Map(branch.map((entry, position) => [entry.id, position]));
	const at = order.get(usage.entryId);
	if (at === undefined) return undefined;
	for (const entry of branch.slice(at + 1)) {
		if (entry.type === "compaction") return undefined;
		if (entry.type === "context_edit" && (order.get(entry.targetId) ?? Infinity) <= at) return undefined;
	}
	return projection.messages.slice(usage.message + 1)
		.reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)), usage.tokens);
}
