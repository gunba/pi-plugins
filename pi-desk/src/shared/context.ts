export type ContextResource = "tool" | "skill" | "instruction";
export interface ContextSnapshot {
	revision: string;
	prompt: string;
	estimatedTokens: number;
	instructions: { id: string; path: string; characters: number; included: boolean; editable: boolean }[];
	skills: { id: string; path: string; description: string; included: boolean }[];
	tools: { id: string; description: string; exposure: string; selected: boolean; declared: boolean; callable: boolean; selectable: boolean; characters: number }[];
}
export interface ContextFile { path: string; text: string; version: string; editable: boolean }
export interface ContextChange { resource: ContextResource; id: string; included: boolean; revision: string }
