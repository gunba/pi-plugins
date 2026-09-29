import type { SavedSession } from "./protocol.ts";
export const SAVED_PAGE_SIZE = 50;
export interface CatalogProgress {
	id: string; state: "queued" | "loading" | "ready" | "cancelled" | "error"; loaded: number; total: number;
}
export interface SavedPage {
	sessions: SavedSession[]; total: number; matched: number; offset: number;
	next?: number; revision: string; scanned: number; warning?: string;
	progress: CatalogProgress;
}

export function savedProgressLabel(page?: SavedPage, filtered = false): string {
	if (!page) return "Opening saved conversations…";
	const { state, loaded, total } = page.progress;
	const available = page.matched ? `${page.matched} found · ` : "";
	if (state === "queued") return `${available}Waiting to read saved conversations…`;
	if (state === "loading") return total ? `${available}Reading ${loaded} of ${total} files…`
		: `${available}Reading saved conversations…`;
	if (state === "cancelled") return `${page.matched} found · scan stopped`;
	if (state === "error") return `${available}Could not finish reading saved conversations`;
	return `${page.matched} ${filtered ? page.matched === 1 ? "match" : "matches"
		: page.matched === 1 ? "conversation" : "conversations"} · most recent first`;
}
