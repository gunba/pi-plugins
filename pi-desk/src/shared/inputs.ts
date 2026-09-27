import type { WorkerCommand } from "./protocol.ts";

export type PromptCommand = Extract<WorkerCommand, { kind: "prompt" }>;
export interface InputStatus {
	id: string;
	state: "queued" | "sending" | "accepted" | "cancelled" | "failed" | "interrupted";
	created: number;
	updated: number;
	preview: string;
	files: number;
	error?: string;
}
export interface InputSubmission {
	id: string;
	activation: string;
	generation?: string;
	command: PromptCommand;
}
