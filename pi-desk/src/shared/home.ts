export const HOME_MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" } as const;
export const HOME_WORK = "home-work-v1";

/** files: the names of files Jordan attached. */
export interface HomeMessage { id: string; role: "user" | "assistant"; text: string; at: number; files?: string[]; state?: "queued" | "running" | "done" | "interrupted" }
/** A watch Home has set: a time watch has `at`; the others watch a command. */
export interface HomeWatch { id: string; title: string; at?: number }
export interface HomeRun { at: number; cost: number; input: number; output: number; cacheRead: number }
/** A conversation Home lists; wakes is when a watch next wakes it. A secondary agent names its conversation as parent. */
export interface HomeWork { id: string; computer?: string; title: string; status: string; detail: string; view?: string; wakes?: number; parent?: string }
/**
 * page is Jordan's tasks file, which Home shows as his page; work is the live work Desk shows above it. activation is
 * the Home conversation's, which uploads to it need.
 */
export interface HomeSnapshot { messages: HomeMessage[]; busy: boolean; error?: string; run?: HomeRun; session?: string; activation?: string;
	work?: HomeWork[]; watches?: HomeWatch[]; page?: string;
	/** Present when Jordan can change the page: what a change must be made over (POST /api/home/page). */
	pageVersion?: string }
