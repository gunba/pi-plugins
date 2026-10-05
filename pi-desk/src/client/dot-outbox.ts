import type { DotAttachment, DotInput, DotMessage, DotUpload } from "../shared/dot.ts";

export type DotOutboxInput = Omit<DotInput, "state"> & {
	state: DotInput["state"] | "queued";
	attachments: DotAttachment[];
	ignored?: boolean;
};
export interface DotOutbox { draft: string; inputs: DotOutboxInput[] }
export const dotOutboxKey = (computer?: string) => `pi-desk:dot:${computer ?? "local"}:outbox`;

export function readDotOutbox(storage: Pick<Storage, "getItem">, computer?: string): DotOutbox {
	const saved = storage.getItem(dotOutboxKey(computer));
	if (saved) {
		const value = JSON.parse(saved) as DotOutbox;
		if (typeof value.draft !== "string" || !Array.isArray(value.inputs)) throw Error("Saved Dot messages could not be read.");
		return { ...value, inputs: value.inputs.map(input => input.state === "sending"
			? { ...input, state: "unknown", error: "Checking delivery after reconnecting…" } : input) };
	}
	const prefix = `pi-desk:dot:${computer ?? "local"}`;
	const draft = storage.getItem(`${prefix}:draft`) ?? "", pending = JSON.parse(storage.getItem(`${prefix}:pending`) ?? "null");
	return { draft, inputs: pending ? [{ ...pending, created: new Date().toISOString(), attachments: [], state: "unknown" }] : [] };
}

export function enqueueDot(outbox: DotOutbox, dot: string, files: DotUpload[], id = crypto.randomUUID(), created = new Date().toISOString()): DotOutbox {
	const text = outbox.draft.trim();
	if (!text && !files.length) return outbox;
	return { draft: "", inputs: [...outbox.inputs, { id, dot, text, files: files.map(file => file.id), created, state: "queued",
		attachments: files.map(file => ({ id: file.id, name: file.name, mime: file.mime, size: file.size, kind: "file", downloadable: false })) }] };
}

export function reconcileDotInput(outbox: DotOutbox, receipt: DotInput): DotOutbox {
	return { ...outbox, inputs: outbox.inputs.map(input => {
		if (input.id !== receipt.id || input.dot !== receipt.dot || input.text !== receipt.text
			|| JSON.stringify(input.files ?? []) !== JSON.stringify(receipt.files ?? []) || input.state === "accepted") return input;
		return { ...input, ...receipt, created: input.created };
	}) };
}

export function nextDotInput(outbox: DotOutbox, dot: string): DotOutboxInput | undefined {
	const first = outbox.inputs.find(input => input.dot === dot && input.state !== "accepted" && !input.ignored);
	return first?.state === "queued" ? first : undefined;
}

export function dotReservedFiles(outbox: DotOutbox, receipts: DotInput[]): Set<string> {
	return new Set([...outbox.inputs.filter(input => !input.ignored || input.state !== "not-sent"), ...receipts.filter(input => input.state === "accepted")].flatMap(input => input.files ?? []));
}

export function pendingDotMessages(outbox: DotOutbox, dot: string | undefined, messages: DotMessage[]): DotOutboxInput[] {
	const remote = new Set(messages.map(message => message.id));
	return outbox.inputs.filter(input => input.dot === dot && (!input.messageId || !remote.has(input.messageId)));
}
