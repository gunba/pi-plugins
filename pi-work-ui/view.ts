import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi, type Component,
} from "@earendil-works/pi-tui";

export type WorkSectionId = "goal" | "todos" | "subagents";
export type WorkTone = "accent" | "muted" | "success" | "warning" | "error";
export interface WorkSection {
	label: string;
	/** Short, factual state; placed before the preview so attention survives truncation. */
	status: string;
	summary?: string;
	detail: string;
	tone?: WorkTone;
	action?: { label: string; run: (ctx: ExtensionCommandContext) => Promise<void> };
}
export type WorkSnapshot = ReadonlyArray<readonly [WorkSectionId, Readonly<WorkSection>]>;
export const SECTION_ORDER: readonly WorkSectionId[] = ["goal", "todos", "subagents"];

/** Data is never interpreted as terminal control sequences. Persistence is untouched. */
export function safeWorkText(text: string, multiline = false): string {
	return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (character) => {
		if (character === "\n") return multiline ? "\n" : " ";
		if (character === "\t") return "    ";
		return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}

function fit(text: string, width: number): string {
	return width <= 0 ? "" : truncateToWidth(text, Math.floor(width), "…");
}

export function workPanelLines(snapshot: WorkSnapshot, theme: Theme, width: number): string[] {
	if (!snapshot.length || width <= 0) return [];
	const heading = width < 24 ? "/work expand" : "Work · /work expand";
	return [theme.fg("dim", fit(heading, width)), ...snapshot.map(([id, section]) => {
		const state = theme.fg(section.tone ?? "accent", safeWorkText(section.status));
		const label = id === "subagents" && width < 40 ? "Agents" : safeWorkText(section.label);
		const prefix = `${theme.fg("dim", "›")} ${theme.bold(label)} ${state}`;
		const preview = section.summary ? ` · ${safeWorkText(section.summary).replace(/\s+/g, " ").trim()}` : "";
		return fit(prefix + theme.fg("muted", preview), width);
	})];
}

interface ViewKeybindings {
	matches(data: string, action: string): boolean;
	getKeys(action: string): readonly string[];
}
export interface WorkViewOptions {
	theme: Theme;
	keybindings: ViewKeybindings;
	getHeight: () => number;
	requestRender: () => void;
	done: (action?: WorkSectionId) => void;
	initialSection?: WorkSectionId;
}

/** A fresh instance per opening. Its height is independent of the length of the objective. */
export class WorkDetailView implements Component {
	private snapshot: WorkSnapshot;
	private options: WorkViewOptions;
	private list!: SelectList;
	private selected: WorkSectionId | undefined;
	private expanded: WorkSectionId | undefined;
	private offset = 0;
	private pageSize = 1;
	private lineCount = 0;
	private disposed = false;
	private cachedBody: { width: number; id: WorkSectionId; text: string; lines: string[] } | undefined;

	constructor(snapshot: WorkSnapshot, options: WorkViewOptions) {
		this.snapshot = snapshot;
		this.options = options;
		this.selected = options.initialSection ?? snapshot[0]?.[0];
		this.expanded = options.initialSection;
		this.rebuildList();
	}

	update(snapshot: WorkSnapshot): void {
		if (this.disposed) return;
		const previous = this.snapshot.find(([id]) => id === this.expanded)?.[1].detail;
		this.snapshot = snapshot;
		if (!snapshot.some(([id]) => id === this.selected)) this.selected = snapshot[0]?.[0];
		if (!snapshot.some(([id]) => id === this.expanded)) this.expanded = undefined;
		if (previous !== snapshot.find(([id]) => id === this.expanded)?.[1].detail) this.offset = 0;
		this.rebuildList();
		this.invalidate();
		this.options.requestRender();
	}

	private rebuildList(): void {
		const theme = this.options.theme;
		this.list = new SelectList(this.snapshot.map(([id, section]) => ({
			value: id,
			label: `${safeWorkText(section.label)} · ${safeWorkText(section.status)}`,
		})), 3, {
			selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s),
			description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s),
			noMatch: (s) => theme.fg("muted", s),
		});
		this.list.setSelectedIndex(Math.max(0, this.snapshot.findIndex(([id]) => id === this.selected)));
	}

	private hint(action: string, fallback: string): string {
		return this.options.keybindings.getKeys(action).join("/") || fallback;
	}

	render(width: number): string[] {
		if (this.disposed || width <= 0) return [];
		const height = Math.max(1, Math.floor(this.options.getHeight()));
		const theme = this.options.theme;
		const section = this.snapshot.find(([id]) => id === this.expanded)?.[1];
		const confirm = this.hint("tui.select.confirm", "enter");
		const cancel = this.hint("tui.select.cancel", "esc");
		let title = theme.bold("Work");
		let body: string[];
		let help: string;
		if (section && this.expanded) {
			title += ` · ${theme.fg(section.tone ?? "accent", safeWorkText(section.label))} · ${safeWorkText(section.status)}`;
			const text = safeWorkText(section.detail, true);
			if (!this.cachedBody || this.cachedBody.width !== width || this.cachedBody.id !== this.expanded || this.cachedBody.text !== text) {
				this.cachedBody = { width, id: this.expanded, text, lines: wrapTextWithAnsi(text, Math.max(1, width)).map((line) => fit(line, width)) };
			}
			const lines = this.cachedBody.lines;
			this.pageSize = Math.max(1, height - 3);
			this.lineCount = lines.length;
			this.offset = Math.max(0, Math.min(this.offset, lines.length - this.pageSize));
			body = lines.slice(this.offset, this.offset + this.pageSize);
			help = width < 48
				? `↑↓ scroll · ${confirm} collapse · ${cancel} close`
				: `↑↓ / PgUp PgDn scroll · ${confirm} collapse · ${cancel} close${section.action ? ` · d ${safeWorkText(section.action.label)}` : ""}`;
			body.push(theme.fg("dim", `${Math.min(this.offset + 1, lines.length)}–${Math.min(lines.length, this.offset + this.pageSize)}/${lines.length}${section.action && width < 48 ? ` · d ${safeWorkText(section.action.label)}` : ""}`));
		} else {
			body = this.snapshot.length ? this.list.render(width) : ["No current work."];
			help = `↑↓ select · ${confirm} expand · ${cancel} close`;
		}
		return [theme.fg("accent", fit(title, width)), ...body, theme.fg("dim", fit(help, width))]
			.slice(0, height).map((line) => fit(line, width));
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel")) { this.options.done(); return; }
		const section = this.snapshot.find(([id]) => id === this.expanded)?.[1];
		if (data === "d" && section?.action && this.expanded) { this.options.done(this.expanded); return; }
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
			this.expanded = this.expanded ? undefined : this.selected;
			this.offset = 0;
		} else if (this.expanded) {
			if (kb.matches(data, "tui.select.up")) this.offset -= 1;
			else if (kb.matches(data, "tui.select.down")) this.offset += 1;
			else if (kb.matches(data, "tui.select.pageUp")) this.offset -= this.pageSize;
			else if (kb.matches(data, "tui.select.pageDown")) this.offset += this.pageSize;
			else if (matchesKey(data, "home")) this.offset = 0;
			else if (matchesKey(data, "end")) this.offset = this.lineCount;
			this.offset = Math.max(0, Math.min(this.offset, this.lineCount - this.pageSize));
		} else {
			const index = this.snapshot.findIndex(([id]) => id === this.selected);
			const direction = kb.matches(data, "tui.select.up") ? -1 : kb.matches(data, "tui.select.down") ? 1 : 0;
			if (direction) {
				this.selected = this.snapshot[Math.max(0, Math.min(this.snapshot.length - 1, index + direction))]?.[0];
				this.list.setSelectedIndex(Math.max(0, this.snapshot.findIndex(([id]) => id === this.selected)));
			}
		}
		this.options.requestRender();
	}

	invalidate(): void { this.cachedBody = undefined; this.list.invalidate(); }
	dispose(): void { this.disposed = true; this.snapshot = []; this.cachedBody = undefined; }
}
