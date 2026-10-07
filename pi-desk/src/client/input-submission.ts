import type { InputStatus, PromptCommand } from "../shared/inputs.ts";

export interface SubmissionReceipt {
	id: string;
	activation: string;
	generation?: string;
	fingerprint: string;
	behavior?: PromptCommand["behavior"];
	requiresConfirmation?: boolean;
}
export function createSubmission(session: { activation: string; state: string; generation?: string },
	fingerprint: string, delivery: NonNullable<PromptCommand["behavior"]>): SubmissionReceipt {
	return { id: crypto.randomUUID(), activation: session.activation,
		generation: session.state === "starting" ? undefined : session.generation,
		fingerprint, behavior: delivery };
}
export const submissionKey = (session: string) => `pi-desk:submission:${session}`;
export const admittedInput = (status: InputStatus | undefined): boolean =>
	!!status && ["queued", "sending", "accepted"].includes(status.state);
export async function submissionFingerprint(prompt: PromptCommand): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(prompt)))),
		byte => byte.toString(16).padStart(2, "0")).join("");
}
export function submissionDecision(previous: SubmissionReceipt | null, activation: string, fingerprint: string,
	status?: InputStatus): "new" | "reuse" | "confirm" | "confirmed" {
	if (!previous) return "new";
	if (status?.id === previous.id) {
		if (admittedInput(status)) return previous.fingerprint === fingerprint ? "confirmed" : "new";
		return "confirm";
	}
	return previous.activation === activation && !previous.requiresConfirmation && previous.fingerprint === fingerprint ? "reuse" : "confirm";
}
export async function readSubmission(receipt: SubmissionReceipt, read: (id: string) => Promise<InputStatus>): Promise<InputStatus | undefined> {
	try {
		const status = await read(receipt.id);
		return status.id === receipt.id ? status : undefined;
	} catch { return undefined; }
}
/** A lost reply is resolved by a read, never another write. */
export async function submitWithReceipt(receipt: SubmissionReceipt, submit: () => Promise<InputStatus>,
	read: (id: string) => Promise<InputStatus>): Promise<InputStatus> {
	try { return await submit(); }
	catch (error) {
		const status = (error as { status?: number } | undefined)?.status;
		if (status === undefined || status === 408 || status >= 500) {
			const confirmed = await readSubmission(receipt, read);
			if (admittedInput(confirmed)) return confirmed!;
		}
		throw error;
	}
}
export function clearSubmission(storage: Pick<Storage, "getItem" | "removeItem">, session: string, id: string): boolean {
	const key = submissionKey(session);
	if (JSON.parse(storage.getItem(key) ?? "null")?.id !== id) return false;
	storage.removeItem(key);
	return true;
}
