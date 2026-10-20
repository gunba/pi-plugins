/**
 * A conversation's change as only what changed. Every change used to resend the conversation's whole entry (about 100 KB,
 * mostly tool definitions and views that had not changed) to every browser: most of the relay's traffic while agents work.
 *
 * A change is a path and its new value; a path that is gone is deleted; a list of items with ids (views, controls,
 * questions) sends its new order and only the items that changed. Anything else is replaced whole.
 */
export type SessionChange =
	| { path: string[]; value: unknown }
	| { path: string[]; deleted: true }
	| { path: string[]; ids: string[]; items: Record<string, unknown> };

const DEPTH = 4;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keyed = (value: unknown): value is { id: string }[] => Array.isArray(value)
	&& value.every(item => plain(item) && typeof item.id === "string") && new Set(value.map(item => (item as { id: string }).id)).size === value.length;

/** What changed from `before` to `after`; empty when nothing did. */
export function sessionChanges(before: unknown, after: unknown, path: string[] = []): SessionChange[] {
	if (before === after || JSON.stringify(before) === JSON.stringify(after)) return [];
	if (path.length < DEPTH && plain(before) && plain(after)) {
		const changes: SessionChange[] = [];
		for (const key of Object.keys(before)) if (!(key in after) && before[key] !== undefined) changes.push({ path: [...path, key], deleted: true });
		for (const key of Object.keys(after)) {
			if (after[key] === undefined) { if (before[key] !== undefined) changes.push({ path: [...path, key], deleted: true }); continue; }
			changes.push(...sessionChanges(before[key], after[key], [...path, key]));
		}
		return changes;
	}
	if (path.length < DEPTH && keyed(before) && keyed(after)) {
		const old = new Map(before.map(item => [item.id, JSON.stringify(item)]));
		const items: Record<string, unknown> = {};
		for (const item of after) if (old.get(item.id) !== JSON.stringify(item)) items[item.id] = item;
		return [{ path, ids: after.map(item => item.id), items }];
	}
	return [{ path, value: after }];
}

/** `before` with the changes applied; parts that did not change are shared, not copied. */
export function applySessionChanges<T>(before: T, changes: readonly SessionChange[]): T {
	let result: unknown = before;
	for (const change of changes) result = applyOne(result, change, 0);
	return result as T;
}
function applyOne(value: unknown, change: SessionChange, depth: number): unknown {
	if (depth === change.path.length) {
		if ("value" in change) return change.value;
		if ("ids" in change) {
			const old = new Map(keyed(value) ? value.map(item => [item.id, item]) : []);
			return change.ids.map(id => {
				const item = Object.hasOwn(change.items, id) ? change.items[id] : old.get(id);
				if (item === undefined) throw new Error("A conversation change refers to an item this browser never received.");
				return item;
			});
		}
		return undefined;
	}
	const key = change.path[depth]!, base = plain(value) ? value : {};
	if ("deleted" in change && depth === change.path.length - 1) { const { [key]: _gone, ...rest } = base; return rest; }
	return { ...base, [key]: applyOne(base[key], change, depth + 1) };
}
