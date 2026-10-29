/**
 * A conversation's change as only what changed. Every change used to resend the conversation's whole entry (about 100 KB,
 * mostly tool definitions and views that had not changed) to every browser: most of the relay's traffic while agents work.
 *
 * A change is a path and its new value; a path that is gone is deleted; a list of items with ids (views, controls,
 * questions) sends its new order and only the items that changed. Anything else is replaced whole.
 *
 * Compact changes, for browsers that announce "session-patch-2", leave out a list's order when it is unchanged (a
 * conversation with 160 agents resent 7 KB of view ids with every change) and send an item that changed as its own
 * changes (`patches`) instead of whole.
 */
export type SessionChange =
	| { path: string[]; value: unknown }
	| { path: string[]; deleted: true }
	| { path: string[]; ids?: string[]; items: Record<string, unknown>; patches?: Record<string, SessionChange[]> };

const DEPTH = 4, COMPACT_DEPTH = 8;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keyed = (value: unknown): value is { id: string }[] => Array.isArray(value)
	&& value.every(item => plain(item) && typeof item.id === "string") && new Set(value.map(item => (item as { id: string }).id)).size === value.length;

/** What changed from `before` to `after`; empty when nothing did. */
export function sessionChanges(before: unknown, after: unknown, path: string[] = [], compact = false, depth = 0): SessionChange[] {
	if (before === after || JSON.stringify(before) === JSON.stringify(after)) return [];
	const limit = compact ? COMPACT_DEPTH : DEPTH;
	if (depth < limit && plain(before) && plain(after)) {
		const changes: SessionChange[] = [];
		for (const key of Object.keys(before)) if (!(key in after) && before[key] !== undefined) changes.push({ path: [...path, key], deleted: true });
		for (const key of Object.keys(after)) {
			if (after[key] === undefined) { if (before[key] !== undefined) changes.push({ path: [...path, key], deleted: true }); continue; }
			changes.push(...sessionChanges(before[key], after[key], [...path, key], compact, depth + 1));
		}
		return changes;
	}
	if (depth < limit && keyed(before) && keyed(after)) {
		const old = new Map(before.map(item => [item.id, item]));
		const items: Record<string, unknown> = {}, patches: Record<string, SessionChange[]> = {};
		for (const item of after) {
			const previous = old.get(item.id);
			if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(item)) continue;
			if (compact && previous !== undefined) patches[item.id] = sessionChanges(previous, item, [], true, depth + 1);
			else items[item.id] = item;
		}
		const ids = after.map(item => item.id);
		if (!compact) return [{ path, ids, items }];
		const reordered = ids.length !== before.length || ids.some((id, index) => id !== before[index]!.id);
		return [{ path, ...(reordered ? { ids } : {}), items, ...(Object.keys(patches).length ? { patches } : {}) }];
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
		if ("items" in change) {
			const list = keyed(value) ? value : [], old = new Map(list.map(item => [item.id, item]));
			return (change.ids ?? list.map(item => item.id)).map(id => {
				if (Object.hasOwn(change.items, id)) return change.items[id];
				const item = old.get(id);
				if (item === undefined) throw new Error("A conversation change refers to an item this browser never received.");
				return change.patches && Object.hasOwn(change.patches, id) ? applySessionChanges(item, change.patches[id]!) : item;
			});
		}
		return undefined;
	}
	const key = change.path[depth]!, base = plain(value) ? value : {};
	if ("deleted" in change && depth === change.path.length - 1) { const { [key]: _gone, ...rest } = base; return rest; }
	return { ...base, [key]: applyOne(base[key], change, depth + 1) };
}

/** A workspace state: its conversations, keyed, and anything else. */
type StateLike = { sessions: { key: string }[] };
/**
 * A whole-state event as changes, for compact browsers: the rest of the state as changes, the conversations' order
 * when it changed, new conversations whole and the others as their changes. Every state event used to resend every
 * conversation (635 KB with 12 of them) whenever anything else in the state changed.
 */
export interface StateChanges { host: SessionChange[]; keys?: string[]; added: Record<string, unknown>; changed: Record<string, SessionChange[]> }
export function stateChanges<T extends StateLike>(before: T, after: T, sessions: ReadonlyMap<string, unknown>): StateChanges {
	const { sessions: oldList, ...oldHost } = before, { sessions: newList, ...newHost } = after;
	const keys = newList.map(session => session.key), added: Record<string, unknown> = {}, changed: Record<string, SessionChange[]> = {};
	for (const session of newList) {
		const previous = sessions.get(session.key);
		if (previous === undefined) { added[session.key] = session; continue; }
		const changes = sessionChanges(previous, session, [], true);
		if (changes.length) changed[session.key] = changes;
	}
	const reordered = keys.length !== oldList.length || keys.some((key, index) => key !== oldList[index]!.key);
	return { host: sessionChanges(oldHost, newHost, [], true), ...(reordered ? { keys } : {}), added, changed };
}
export function applyStateChanges<T extends StateLike>(before: T, changes: StateChanges, sessions: ReadonlyMap<string, unknown>): T {
	const { sessions: oldList, ...oldHost } = before;
	const host = applySessionChanges(oldHost, changes.host);
	const list = (changes.keys ?? oldList.map(session => session.key)).map(key => {
		if (Object.hasOwn(changes.added, key)) return changes.added[key];
		const previous = sessions.get(key);
		if (previous === undefined) throw new Error("A workspace change refers to a conversation this browser never received.");
		return Object.hasOwn(changes.changed, key) ? applySessionChanges(previous, changes.changed[key]!) : previous;
	});
	return { ...host, sessions: list } as unknown as T;
}
