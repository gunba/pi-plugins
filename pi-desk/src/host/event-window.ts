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
