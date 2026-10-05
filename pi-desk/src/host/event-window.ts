import type { HostEvent, SessionView } from "../shared/protocol.ts";

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

/** Only unsent replacement snapshots coalesce; ordered events keep their delivery credit. */
export class EventDelivery {
	private pending: PendingEvent[] = [];
	private bytes = 0;
	private sending = false;
	private closed = false;
	private window: EventWindow;
	private send: (sequence: number, event: HostEvent) => Promise<void>;
	private failed: () => void;
	constructor(window: EventWindow, send: (sequence: number, event: HostEvent) => Promise<void>, failed: () => void) {
		this.window = window; this.send = send; this.failed = failed;
	}
	push(event: HostEvent): void {
		if (this.closed) return;
		const key = refreshKey(event), bytes = Buffer.byteLength(JSON.stringify(event));
		const old = key === undefined ? -1 : this.pending.findIndex(item => item.key === key);
		if (old >= 0) { this.bytes -= this.pending[old]!.bytes; this.pending.splice(old, 1); }
		if (this.pending.length >= 128 || this.pending.length > 0 && this.bytes + bytes > 8 * 1024 * 1024
			|| bytes > 32 * 1024 * 1024) { this.close(); this.failed(); return; }
		this.pending.push({ event, key, bytes }); this.bytes += bytes;
		this.resume();
	}
	resume(): void {
		if (this.closed || this.sending || !this.pending.length) return;
		const first = this.pending[0]!, sequence = this.window.reserve(first.event);
		if (sequence === undefined) return;
		this.pending.shift(); this.bytes -= first.bytes; this.sending = true;
		void this.send(sequence, first.event).catch(() => { this.close(); this.failed(); })
			.finally(() => { this.sending = false; this.resume(); });
	}
	close(): void { this.closed = true; this.pending = []; this.bytes = 0; }
}
