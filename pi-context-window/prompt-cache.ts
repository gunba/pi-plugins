/**
 * The one place that knows whether a conversation's prompt cache is warm: the model catalog's cache lifetime and
 * when the conversation last used the cache. Desk's cache timer and compaction before expiry, and extensions that
 * act on cache state, all read it here. Models that declare no lifetime (Codex) have unknown state.
 */
type Entry = {
	type: string; timestamp?: string; kind?: string; provider?: string;
	message?: { role?: string; provider?: string; timestamp?: number; usage?: { cacheRead: number; cacheWrite: number } };
};
type Model = { provider: string; promptCache?: { short?: number; long?: number } };

export function promptCacheState(model: Model | undefined, branch: readonly Entry[]): { usedAt: number; ttlMs: number } | undefined {
	const seconds = model?.promptCache?.[process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"];
	if (!model || !seconds) return;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction") return;
		const used = entry.type === "usage" && entry.kind === "cache_warm" ? { provider: entry.provider, at: Date.parse(entry.timestamp ?? "") }
			: entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage
				&& entry.message.usage.cacheRead + entry.message.usage.cacheWrite > 0 ? { provider: entry.message.provider, at: entry.message.timestamp ?? NaN } : undefined;
		if (used) return used.provider === model.provider && Number.isFinite(used.at) ? { usedAt: used.at, ttlMs: seconds * 1000 } : undefined;
	}
}

/** True only when the cache is known to have expired; unknown state is never treated as cold. */
export function cacheExpired(model: Model | undefined, branch: readonly Entry[], now = Date.now()): boolean {
	const state = promptCacheState(model, branch);
	return !!state && state.usedAt + state.ttlMs <= now;
}
