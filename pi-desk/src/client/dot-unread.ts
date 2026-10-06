import type { DotMessage } from "../shared/dot.ts";

interface Position { created: string; ids: string[] }
export interface DotReadState { version: 1; through: Position | null }
export const dotReadKey = (computer: string | undefined, connection: string) => `pi-desk:dot-read:${computer ?? "local"}:${connection}`;
function latest(messages: readonly DotMessage[]): Position | null {
	let last: Position | null = null;
	for (const message of messages) if (message.author === "dot") {
		if (!last || message.created > last.created) last = { created: message.created, ids: [message.id] };
		else if (message.created === last.created && !last.ids.includes(message.id)) last.ids.push(message.id);
	}
	if (last) last.ids.sort();
	return last;
}
export function readDotReadState(saved: string | null, messages: readonly DotMessage[]): DotReadState {
	try {
		const value = JSON.parse(saved ?? "null");
		if (value?.version === 1 && (value.through === null || typeof value.through?.created === "string" && Array.isArray(value.through?.ids)
			&& value.through.ids.length > 0 && value.through.ids.every((id: unknown) => typeof id === "string" && id.length > 0)))
			return { version: 1, through: value.through ? { created: value.through.created, ids: [...new Set<string>(value.through.ids)].sort() } : null };
	} catch {}
	// First observation establishes a baseline; old history is not a new-message alert.
	return { version: 1, through: latest(messages) };
}
export function unreadDotMessages(state: DotReadState, messages: readonly DotMessage[]): DotMessage[] {
	return messages.filter(message => message.author === "dot" && (!state.through || message.created > state.through.created
		|| message.created === state.through.created && !state.through.ids.includes(message.id)));
}
function advance(state: DotReadState, last: Position | null): DotReadState {
	if (!last || state.through && last.created < state.through.created) return state;
	if (!state.through || last.created > state.through.created) return { version: 1, through: last };
	const added = last.ids.filter(id => !state.through!.ids.includes(id));
	return added.length ? { version: 1, through: { created: last.created, ids: [...state.through.ids, ...added].sort() } } : state;
}
export function markDotRead(state: DotReadState, messages: readonly DotMessage[]): DotReadState {
	return advance(state, latest(messages));
}
export function mergeDotReadStates(state: DotReadState, incoming: DotReadState): DotReadState {
	return advance(state, incoming.through);
}
