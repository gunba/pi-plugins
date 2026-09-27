import type { ChatMessage, HistoryPage } from "../shared/protocol.ts";
import type { WorkspaceEvent as HostEvent, WorkspaceState as HostState } from "./workspace.ts";
import { MESSAGE_TEXT_CHARACTERS, THINKING_CHARACTERS } from "../shared/history.ts";

export interface CachedMessage extends ChatMessage { replaces?: string }
export interface ClientState { host?: HostState; messages: Record<string, CachedMessage[]>; focused?: string[] }
export const transcriptKey = (session: string, source?: string) => source ? `${session}/${source}` : session;
const weights = new WeakMap<ChatMessage, number>();
export function messageWeight(message: ChatMessage): number {
	let weight = weights.get(message);
	if (weight === undefined) { weight = JSON.stringify(message).length; weights.set(message, weight); }
	return weight;
}
export function recentMessages(values: CachedMessage[], count = 80, characters = 480_000): CachedMessage[] {
	let start = values.length, size = 0;
	while (start > 0 && values.length - start < count) {
		const weight = messageWeight(values[start - 1]!);
		if (start < values.length && size + weight > characters) break;
		size += weight; start--;
	}
	return values.slice(start);
}
export function trimCaches(messages: ClientState["messages"], focused: string[] = []): void {
	let count = Object.keys(messages).length;
	let size = Object.values(messages).reduce((sum, values) => sum + values.reduce((sum, value) => sum + messageWeight(value), 0), 0);
	for (const key of Object.keys(messages)) {
		if (count <= 16 && size <= 2_000_000) break;
		if (focused.includes(key)) continue;
		size -= messages[key]!.reduce((sum, value) => sum + messageWeight(value), 0);
		delete messages[key]; count--;
	}
}
export function cacheTranscript(messages: ClientState["messages"], key: string, values: CachedMessage[]): void {
	delete messages[key]; messages[key] = recentMessages(values);
}
export function mergeMessages(current: CachedMessage[], updates: CachedMessage[]): CachedMessage[] {
	const result = new Map(current.map(message => [message.id, message]));
	for (const message of updates) {
		if (message.replaces) result.delete(message.replaces);
		const previous = result.get(message.id);
		if (!previous || message.revision >= previous.revision) result.set(message.id,
			previous?.replaces && !message.replaces ? { ...message, replaces: previous.replaces } : message);
	}
	return [...result.values()].sort((a, b) => a.order - b.order);
}
export function reconcileHistory(current: CachedMessage[], page: HistoryPage): CachedMessage[] {
	return mergeMessages(current.filter(message => !message.id.startsWith("live:")
		|| message.revision > page.revision || page.messages.some(value => value.id === message.id)), page.messages);
}
export function reduceEvents(state: ClientState, events: HostEvent[]): ClientState {
	let host = state.host;
	const messages = { ...state.messages };
	for (const event of events) {
		if (event.type === "state" || event.type === "session") {
			const next = event.type === "state" ? event.state : host ? {
				...host, sessions: [...host.sessions.filter(item => item.key !== event.session.key), event.session],
			} : undefined;
			for (const old of host?.sessions ?? []) {
				const replacement = next?.sessions.find(item => item.key === old.key);
				if (!replacement || replacement.ui?.generation !== old.ui?.generation || replacement.snapshot?.id !== old.snapshot?.id)
					for (const key of Object.keys(messages)) if (key === old.key || key.startsWith(`${old.key}/`)) delete messages[key];
			}
			host = next;
		} else if (event.type === "worker") {
			const source = event.message.type === "transcript" ? event.message.source : undefined;
			const message = event.message.type === "transcript" ? event.message.event : event.message;
			const generation = host?.sessions.find(item => item.key === event.key)?.ui?.generation;
			if ((message.type === "chat" || message.type === "delta" || message.type === "block") && message.generation !== generation) continue;
			const key = transcriptKey(event.key, source);
			if (message.type === "chat") cacheTranscript(messages, key,
				mergeMessages(messages[key] ?? [], [{ ...message.message, replaces: message.replaces }]));
			if (message.type === "delta" || message.type === "block") cacheTranscript(messages, key, (messages[key] ?? []).map(item => {
				if (item.id !== message.id || item.revision >= message.revision || message.index >= 128) return item;
				const blocks = [...item.blocks], old = blocks[message.index];
				const used = blocks.reduce((sum, block, index) => index === message.index ? sum
					: sum + (block && "text" in block ? block.text.length : block?.type === "toolCall" ? block.arguments.length : 0), 0);
				const thinking = blocks.reduce((sum, block, index) => sum + (index !== message.index && block?.type === "thinking" ? block.text.length : 0), 0);
				const limit = Math.max(0, Math.min(MESSAGE_TEXT_CHARACTERS - used,
					message.type === "delta" && message.kind === "thinking" ? THINKING_CHARACTERS - thinking : Infinity));
				if (message.type === "block") blocks[message.index] = message.block.type === "toolCall"
					? { ...message.block, arguments: message.block.arguments.slice(0, limit), truncated: message.block.truncated || message.block.arguments.length > limit }
					: message.block;
				else {
					const text = `${old && (old.type === "text" || old.type === "thinking") ? old.text : ""}${message.text}`;
					blocks[message.index] = { type: message.kind, text: text.slice(0, limit),
						truncated: message.truncated || old && "truncated" in old && old.truncated || text.length > limit };
				}
				return { ...item, blocks, revision: message.revision };
			}));
		}
	}
	trimCaches(messages, state.focused);
	return { ...state, host, messages };
}
