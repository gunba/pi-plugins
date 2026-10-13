export const LEDGER_ENTRY = "pi-context-ledger";
export type LedgerLeaf = { label: string; tokens: number };
export type LedgerGroup = { label: string; tokens: number; note: string; items: LedgerLeaf[] };
/** measured: total is what the provider reported for the first request, and the parts are scaled to it. */
export type Ledger = { total: number; contextWindow: number; windowPercent: number | null; groups: LedgerGroup[]; measured?: boolean };
/** The first request's size as the provider counted it (input, cache reads and cache writes). */
export const LEDGER_MEASURED_ENTRY = "pi-context-ledger-measured";

/**
 * The estimate counts characters, which undercounts JSON tool definitions in particular. Scale every part
 * so the total is the measured one; the shares stay estimates.
 */
export function measuredLedger(ledger: Ledger, measured: number): Ledger {
	if (!(measured > 0) || !(ledger.total > 0)) return ledger;
	const factor = measured / ledger.total;
	const scale = (tokens: number) => Math.round(tokens * factor);
	return { ...ledger, total: measured, measured: true,
		windowPercent: ledger.contextWindow > 0 ? (measured / ledger.contextWindow) * 100 : ledger.windowPercent,
		groups: ledger.groups.map(group => ({ ...group, tokens: scale(group.tokens), items: group.items.map(item => ({ ...item, tokens: scale(item.tokens) })) })) };
}

/** Persisted entry data crosses the same untrusted boundary as other transcript content. */
export function readLedger(value: unknown): Ledger | undefined {
	const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
	const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	let characters = 0;
	const label = (value: unknown) => typeof value === "string" && value.length <= 4096 && (characters += value.length) <= 64_000;
	if (!record(value) || !number(value.total) || !number(value.contextWindow) ||
		!(value.windowPercent === null || number(value.windowPercent)) ||
		!Array.isArray(value.groups) || value.groups.length > 64) return;
	let items = 0;
	for (const group of value.groups) {
		if (!record(group) || !label(group.label) || !number(group.tokens) || !label(group.note) ||
			!Array.isArray(group.items) || (items += group.items.length) > 4096) return;
		if (!group.items.every(item => record(item) && label(item.label) && number(item.tokens))) return;
	}
	const ledger = value as Ledger;
	return { total: ledger.total, contextWindow: ledger.contextWindow, windowPercent: ledger.windowPercent,
		groups: ledger.groups.map(group => ({ label: group.label, tokens: group.tokens, note: group.note,
			items: group.items.map(item => ({ label: item.label, tokens: item.tokens })) })) };
}
