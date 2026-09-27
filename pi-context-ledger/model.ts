export const LEDGER_ENTRY = "pi-context-ledger";
export type LedgerLeaf = { label: string; tokens: number };
export type LedgerGroup = { label: string; tokens: number; note: string; items: LedgerLeaf[] };
export type Ledger = { total: number; contextWindow: number; windowPercent: number | null; groups: LedgerGroup[] };

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
