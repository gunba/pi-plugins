import type { ExtensionAPI, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { getWorkCoordinator } from "../../pi-work-coordination/core.ts";

export const FOLLOWUP_MESSAGE = "pi-subagents/followup";
export type FollowupInput = { messageId: string; content: string };

export function deliveredFollowups(entries: readonly SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== FOLLOWUP_MESSAGE) continue;
		const details = entry.details as { messageIds?: unknown } | undefined;
		if (Array.isArray(details?.messageIds)) for (const id of details.messageIds) if (typeof id === "string") ids.add(id);
	}
	return ids;
}

/** The owning runtime retains acceptance; native boundary entries prove delivery. */
export class FollowupDelivery {
	private readonly pending = new Map<string, FollowupInput>();
	private readonly observed = new Set<string>();
	private readonly manager: SessionManager;
	private readonly onDelivered: (ids: string[]) => void;
	constructor(manager: SessionManager, onDelivered: (ids: string[]) => void = () => {}) {
		this.manager = manager; this.onDelivered = onDelivered;
	}

	enqueue(input: FollowupInput): void {
		if (this.pending.has(input.messageId)) return;
		this.pending.set(input.messageId, input);
		getWorkCoordinator(this.manager.getSessionId())?.notify([input.messageId]);
	}

	private unsent(): FollowupInput[] {
		if (!this.pending.size) return [];
		const delivered = deliveredFollowups(this.manager.getBranch());
		return [...this.pending.values()].filter(input => !delivered.has(input.messageId));
	}

	private message(inputs: FollowupInput[]) {
		return { customType: FOLLOWUP_MESSAGE, content: inputs.map(input => input.content).join("\n\n"), display: true,
			details: { messageIds: inputs.map(input => input.messageId) } };
	}

	install(pi: ExtensionAPI): void {
		pi.on("context", event => {
			const ids = event.messages.flatMap(message => {
				if (message.role !== "custom" || message.customType !== FOLLOWUP_MESSAGE) return [];
				const details = message.details as { messageIds?: unknown } | undefined;
				return Array.isArray(details?.messageIds) ? details.messageIds.filter((id): id is string => typeof id === "string" && this.pending.has(id) && !this.observed.has(id)) : [];
			});
			if (ids.length) { this.onDelivered(ids); for (const id of ids) this.observed.add(id); }
		});
		pi.on("before_agent_start", () => {
			const inputs = this.unsent();
			if (inputs.length) return { message: this.message(inputs) };
		});
		const boundary = (event: { outcome: string }) => {
			if (event.outcome !== "completed") return;
			const inputs = this.unsent();
			if (!inputs.length) return;
			return { entries: inputs.map(input => ({ type: "custom_message" as const, ...this.message([input]) })), continue: true };
		};
		pi.on("turn_end", boundary);
		pi.on("agent_before_settle", boundary);
	}

	finish(): string[] {
		const delivered = deliveredFollowups(this.manager.getBranch());
		const consumed = [...this.pending.keys()].filter(id => delivered.has(id));
		// Undelivered inputs return to the runtime's durable queue, not an opaque SDK queue.
		getWorkCoordinator(this.manager.getSessionId())?.consume([...this.pending.keys()]);
		this.pending.clear();
		this.observed.clear();
		return consumed;
	}
}
