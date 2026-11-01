export const HOME_MODEL = { provider: "openai-codex", id: "gpt-6.1-terra" } as const;
export const HOME_WORK = "home-work-v1";

export interface HomeMessage { id: string; role: "user" | "assistant"; text: string; at: number; state?: "queued" | "running" | "done" | "interrupted" }
export interface HomeRun { at: number; cost: number; input: number; output: number; cacheRead: number }
/** A conversation Home lists; wakes is when a watch next wakes it. */
export interface HomeWork { id: string; computer?: string; title: string; status: string; detail: string; view?: string; wakes?: number }
/** page is Jordan's tasks file, which Home shows as his page; work is the live work Desk shows above it. */
export interface HomeSnapshot { messages: HomeMessage[]; busy: boolean; error?: string; run?: HomeRun; session?: string; work?: HomeWork[]; page?: string }
