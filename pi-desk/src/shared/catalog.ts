import type { SavedSession } from "./protocol.ts";
export const SAVED_PAGE_SIZE = 50;
export interface SavedPage {
	sessions: SavedSession[]; total: number; matched: number; offset: number;
	next?: number; revision: string; scanned: number; warning?: string;
}
