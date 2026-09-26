import type { Usage } from "@earendil-works/pi-ai";

type RecordedUsage = Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> };
type Entry = {
	type?: string;
	customType?: string;
	data?: { childId?: string; messageId?: string; usage?: RecordedUsage };
	message?: { role?: string; usage?: RecordedUsage };
	usage?: RecordedUsage;
};

export interface SessionStats {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
}

/** Recorded charges, not subscription allowance. Replayed child receipts count once. */
export function reduceSessionUsage(entries: readonly unknown[]): {
	usage?: Usage;
	contextTokens: number;
	cacheHitRate?: number;
} {
	let total: Usage | undefined;
	let contextTokens = 0;
	let cacheHitRate: number | undefined;
	const childCharges = new Set<string>();
	for (const value of entries) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Entry;
		let usage: RecordedUsage | undefined;
		let assistant = false;
		if (entry.type === "custom" && entry.customType === "pi-subagents/usage-v1") {
			const { childId, messageId } = entry.data ?? {};
			if (typeof childId !== "string" || typeof messageId !== "string") continue;
			const key = JSON.stringify([childId, messageId]);
			if (childCharges.has(key)) continue;
			childCharges.add(key);
			usage = entry.data?.usage;
		} else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		} else if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) {
			usage = entry.message.usage;
			assistant = entry.message.role === "assistant";
		}
		if (!usage) continue;
		total ??= {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			total[key] += usage[key] ?? 0;
			total.cost[key] += usage.cost?.[key] ?? 0;
		}
		const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		const tokens = usage.totalTokens ?? promptTokens + (usage.output ?? 0);
		total.totalTokens += tokens;
		total.cost.total += usage.cost?.total ?? 0;
		for (const key of ["reasoning", "cacheWrite1h"] as const) {
			if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]!;
		}
		if (assistant) {
			contextTokens = Math.max(contextTokens, tokens);
			cacheHitRate = promptTokens ? (usage.cacheRead ?? 0) / promptTokens * 100 : undefined;
		}
	}
	return { usage: total, contextTokens, cacheHitRate };
}

export function computeSessionStats(entries: readonly unknown[]): SessionStats {
	const { usage } = reduceSessionUsage(entries);
	return {
		totalInput: usage?.input ?? 0,
		totalOutput: usage?.output ?? 0,
		totalCacheRead: usage?.cacheRead ?? 0,
		totalCacheWrite: usage?.cacheWrite ?? 0,
		totalCost: usage?.cost.total ?? 0,
		costInput: usage?.cost.input ?? 0,
		costOutput: usage?.cost.output ?? 0,
		costCacheRead: usage?.cost.cacheRead ?? 0,
		costCacheWrite: usage?.cost.cacheWrite ?? 0,
	};
}
