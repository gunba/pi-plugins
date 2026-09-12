import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type WorkSectionId = "goal" | "todos" | "subagents" | "party";
export type WorkTone = "accent" | "muted" | "success" | "warning" | "error";
export interface WorkSection {
	label: string;
	/** Short, factual state; placed before the preview so attention survives truncation. */
	status: string;
	summary?: string;
	detail: string;
	tone?: WorkTone;
}
export type WorkSnapshot = ReadonlyArray<readonly [WorkSectionId, Readonly<WorkSection>]>;
export const SECTION_ORDER: readonly WorkSectionId[] = ["goal", "todos", "subagents", "party"];

/** Data is never interpreted as terminal control sequences. Persistence is untouched. */
export function safeWorkText(text: string, multiline = false): string {
	return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (character) => {
		if (character === "\n") return multiline ? "\n" : " ";
		if (character === "\t") return "    ";
		return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}

export function workPanelLines(snapshot: WorkSnapshot, theme: Theme, width: number): string[] {
	if (!snapshot.length || width <= 0) return [];
	const fit = (text: string) => truncateToWidth(text, Math.floor(width), "…");
	const heading = width < 24 ? "Work" : "Work · Alt+1–4";
	return [theme.fg("dim", fit(heading)), ...snapshot.map(([id, section]) => {
		const state = theme.fg(section.tone ?? "accent", safeWorkText(section.status));
		const label = id === "subagents" && width < 40 ? "Agents" : safeWorkText(section.label);
		const prefix = `${theme.fg("dim", "›")} ${theme.bold(label)} ${state}`;
		const preview = section.summary ? ` · ${safeWorkText(section.summary).replace(/\s+/g, " ").trim()}` : "";
		return fit(prefix + theme.fg("muted", preview));
	})];
}
