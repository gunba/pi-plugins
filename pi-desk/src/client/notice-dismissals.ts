const key = "pi-desk:notice-dismissals";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export const noticeIdentity = (session: string, generation: string, id: string) => JSON.stringify([session, generation, id]);
export function readDismissals(storage: Storage): string[] {
	try {
		const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
		return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(-512) : [];
	} catch { return []; }
}
export function dismissNotice(storage: Storage, identity: string): string[] {
	const next = [...readDismissals(storage).filter(id => id !== identity), identity].slice(-512);
	try { storage.setItem(key, JSON.stringify(next)); } catch { /* Still dismiss for this visit. */ }
	return next;
}
