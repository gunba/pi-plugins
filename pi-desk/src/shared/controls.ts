import type { WorkerCommand } from "./protocol.ts";

export const CONTROL_LABELS = {
	compact: "Compact context", navigate: "Change branch", fork: "Fork conversation",
	reload: "Reload resources", model: "Change model", account: "Change account", thinking: "Change reasoning", abort: "Stop work", close: "Close conversation",
	context_update: "Change context", context_save: "Save instruction file",
} as const;
export type ControlKind = keyof typeof CONTROL_LABELS;
export type ControlCommand = Extract<WorkerCommand, { kind: Exclude<ControlKind, "close"> }>;
export interface ControlStatus {
	id: string; kind: ControlKind; generation: string; started: number; ended?: number;
	state: "running" | "completed" | "failed" | "interrupted"; error?: string;
}
export function isControl(command: WorkerCommand): command is ControlCommand {
	return Object.hasOwn(CONTROL_LABELS, command.kind);
}
