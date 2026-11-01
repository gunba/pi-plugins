export const HOME_MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" } as const;
export const HOME_WORK = "home-work-v1";

/** Home's canvas: one SVG document the agent writes whole. revision fences a write against a stale read. */
export interface HomeScene { version: 2; revision: number; svg: string }
export interface HomeMessage { id: string; role: "user" | "assistant"; text: string; at: number; state?: "queued" | "running" | "done" | "interrupted" }
export interface HomeRun { at: number; cost: number; input: number; output: number; cacheRead: number }
export interface HomeWork { id: string; computer?: string; title: string; status: string; detail: string; view?: string }
export interface HomeSnapshot { scene: HomeScene; messages: HomeMessage[]; busy: boolean; error?: string; run?: HomeRun; session?: string; work?: HomeWork[] }
export const emptyHomeScene = (): HomeScene => ({ version: 2, revision: 0, svg: "" });
/** Largest SVG Home keeps; far more than a drawing of tasks needs. */
export const HOME_SVG_LIMIT = 512 * 1024;

/** The key that opens a live work item: an element with data-open="<key>" opens it when clicked. */
export const homeWorkKey = (work: HomeWork): string => `${work.computer ?? "local"}.${work.id}${work.view ? `.${work.view}` : ""}`;

/** HTTP(S) only; a link in the canvas never navigates Desk to a local-file or script URL. */
export function homeUrl(value: string): boolean {
	try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
