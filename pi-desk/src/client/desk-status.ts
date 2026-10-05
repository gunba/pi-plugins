export interface DeskStatus { id: number; text: string; details: string; expires: number }
let status: DeskStatus | undefined, last = "", lastAt = 0, sequence = 0;
const listeners = new Set<() => void>();
export const deskStatus = () => status;
export function subscribeDeskStatus(listener: () => void): () => void {
	listeners.add(listener); return () => { listeners.delete(listener); };
}
export function dismissDeskStatus(id?: number): void {
	if (id !== undefined && id !== status?.id) return;
	status = undefined; for (const listener of listeners) listener();
}
export function reportDeskError(error: unknown): void {
	const details = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "").slice(0, 12_000);
	if (!details) return;
	const text = /IDBDatabase|IndexedDB|database connection is closing|InvalidStateError/.test(details)
		? "Local draft storage is temporarily unavailable."
		: /TypeError:|ReferenceError:|SyntaxError:/.test(String(error))
			? "Desk couldn't display an update."
			: details.slice(0, 500);
	const now = Date.now();
	if (text === last && now - lastAt < 30_000) return;
	last = text; lastAt = now;
	status = { id: ++sequence, text, details, expires: now + 12_000 };
	for (const listener of listeners) listener();
}
