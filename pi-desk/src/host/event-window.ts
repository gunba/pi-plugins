import type { HostEvent, SessionView, TranscriptEvent } from "../shared/protocol.ts";

/** Delivery credit bounds output even when a browser's networking survives a frozen renderer. */
export class EventWindow {
	private sizes = new Map<number, number>();
	private bytes = 0;
	private sent = 0;
	private accepted = 0;
	reserve(event: unknown): number | undefined {
		const size = Buffer.byteLength(JSON.stringify(event));
		if (this.sizes.size >= 128 || this.sizes.size > 0 && this.bytes + size > 8 * 1024 * 1024) return;
		const sequence = ++this.sent;
		this.sizes.set(sequence, size); this.bytes += size;
		return sequence;
	}
	acknowledge(sequence: unknown): void {
		if (!Number.isSafeInteger(sequence) || Number(sequence) < this.accepted || Number(sequence) > this.sent) throw new Error("Invalid event acknowledgement.");
		this.accepted = Number(sequence);
		for (const [id, bytes] of this.sizes) if (id <= this.accepted) { this.sizes.delete(id); this.bytes -= bytes; }
	}
}

type PendingEvent = { event: HostEvent; key?: string; bytes: number };
function transition(session: SessionView): unknown[] {
	return [session.key, session.activation, session.state, session.ui?.generation,
		session.controls?.map(control => [control.id, control.state]),
		session.inputs?.map(input => [input.id, input.state]), session.ui?.interactions.map(item => item.id)];
}
function refreshKey(event: HostEvent): string | undefined {
	if (event.type === "state") return JSON.stringify(["state", event.state.sessions.map(transition)]);
	if (event.type === "session") return JSON.stringify(["session", transition(event.session)]);
}
type Delta = Extract<TranscriptEvent, { type: "delta" }>;
/** A piece of streamed message text, and the transcript it belongs to (undefined for the conversation's own). */
function streamed(event: HostEvent): { delta: Delta; source?: string } | undefined {
	if (event.type !== "worker") return;
	if (event.message.type === "delta") return { delta: event.message };
	if (event.message.type === "transcript" && event.message.event.type === "delta") return { delta: event.message.event, source: event.message.source };
}

/** Only unsent replacement snapshots coalesce; ordered events keep their delivery credit. */
export class EventDelivery {
	private pending: PendingEvent[] = [];
	private bytes = 0;
	private sending = false;
	private closed = false;
	private window: EventWindow;
	private send: (sequence: number, event: HostEvent) => Promise<void>;
	private failed: (reason: string) => void;
	constructor(window: EventWindow, send: (sequence: number, event: HostEvent) => Promise<void>, failed: (reason: string) => void) {
		this.window = window; this.send = send; this.failed = failed;
	}
	push(event: HostEvent): void {
		if (this.closed || this.extend(event)) return;
		const key = refreshKey(event), bytes = Buffer.byteLength(JSON.stringify(event));
		const old = key === undefined ? -1 : this.pending.findIndex(item => item.key === key);
		if (old >= 0) { this.bytes -= this.pending[old]!.bytes; this.pending.splice(old, 1); }
		if (this.pending.length >= 128 || this.pending.length > 0 && this.bytes + bytes > 8 * 1024 * 1024
			|| bytes > 32 * 1024 * 1024) { const waiting = this.pending.length; this.close(); this.failed(`it fell behind, with ${waiting} events waiting`); return; }
		this.pending.push({ event, key, bytes }); this.bytes += bytes;
		this.resume();
	}
	resume(): void {
		if (this.closed || this.sending || !this.pending.length) return;
		const first = this.pending[0]!, sequence = this.window.reserve(first.event);
		if (sequence === undefined) return;
		this.pending.shift(); this.bytes -= first.bytes; this.sending = true;
		void this.send(sequence, first.event).catch(error => { this.close(); this.failed(`an event could not be sent (${error instanceof Error ? error.message : String(error)})`); })
			.finally(() => { this.sending = false; this.resume(); });
	}
	close(): void { this.closed = true; this.pending = []; this.bytes = 0; }
	/**
	 * Adds streamed text to the waiting piece of the same message it follows, when nothing else of its conversation is
	 * queued after that piece. A busy computer or a slow browser then falls behind by a few longer pieces, not by more
	 * events than the queue holds, which disconnected the browser.
	 */
	private extend(event: HostEvent): boolean {
		const next = streamed(event);
		if (!next || event.type !== "worker") return false;
		for (let index = this.pending.length - 1; index >= 0; index--) {
			const item = this.pending[index]!, queued = item.event;
			if (queued.type === "state") return false;
			if ((queued.type === "session" ? queued.session.key : queued.key) !== event.key) continue;
			// Consecutive revisions: nothing else of that transcript came between them.
			const previous = streamed(queued);
			if (!previous || previous.source !== next.source || previous.delta.generation !== next.delta.generation || previous.delta.id !== next.delta.id
				|| previous.delta.index !== next.delta.index || previous.delta.kind !== next.delta.kind || previous.delta.revision + 1 !== next.delta.revision) return false;
			const delta: Delta = { ...previous.delta, revision: next.delta.revision, text: previous.delta.text + next.delta.text,
				...(previous.delta.truncated || next.delta.truncated ? { truncated: true } : {}) };
			// The text's escaped length, without stringifying the whole piece again on every addition.
			const added = Buffer.byteLength(JSON.stringify(next.delta.text)) - 2;
			this.pending[index] = { event: { type: "worker", key: event.key, message: next.source === undefined ? delta : { type: "transcript", source: next.source, event: delta } },
				bytes: item.bytes + added };
			this.bytes += added;
			return true;
		}
		return false;
	}
}
