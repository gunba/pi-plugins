import type { ChatBlock, ChatMessage } from "../shared/protocol.ts";
export type VisibleWorkItem = { id: string; at: number; message: string; title?: string; activity?: boolean;
	block: Extract<ChatBlock, { type: "shown" | "diff" | "document" }> };

/** Stable parts are independent of the selected activity record; unselected calls remain in history. */
export function visibleWorkItems(messages: readonly ChatMessage[]): VisibleWorkItem[] {
	const activity: VisibleWorkItem[] = [], parts: VisibleWorkItem[] = [];
	for (const message of [...messages].sort((a, b) => a.order - b.order)) for (const [index, block] of message.blocks.entries()) {
		if (!block || !["shown", "diff", "document"].includes(block.type)) continue;
		if (block.type !== "shown" && !message.work) continue;
		const item: VisibleWorkItem = { id: `${message.id}:${index}`, at: message.timestamp, message: message.id,
			...(message.work ? { title: message.work.description, activity: true } : {}), block: block as VisibleWorkItem["block"] };
		if (block.type !== "shown" || !block.shown.id || message.work) { activity.push(item); continue; }
		item.id = `part:${block.shown.id}`;
		const previous = parts.findIndex(part => part.id === item.id);
		if (block.shown.remove) { if (previous >= 0) parts.splice(previous, 1); continue; }
		if (previous >= 0) parts[previous] = item; else parts.push(item);
		if (block.shown.before && block.shown.before !== block.shown.id) {
			const target = parts.findIndex(part => part.id === `part:${block.shown.before}`);
			if (target >= 0) { parts.splice(parts.indexOf(item), 1); parts.splice(parts.findIndex(part => part.id === `part:${block.shown.before}`), 0, item); }
		}
	}
	return [...activity, ...parts.filter(item => item.block.type === "shown" && item.block.shown.pinned), ...parts.filter(item => item.block.type !== "shown" || !item.block.shown.pinned)];
}
