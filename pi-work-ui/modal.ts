import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key, matchesKey, ScrollView, Text, truncateToWidth, visibleWidth,
	type KeybindingsManager, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { safeWorkText, SECTION_LABELS, SECTION_ORDER, type WorkSectionId, type WorkSnapshot } from "./view.ts";

export class WorkModal {
	private snapshot: WorkSnapshot;
	private selected: WorkSectionId;
	private theme: Theme;
	private keys: KeybindingsManager;
	private height: () => number;
	private requestRender: () => void;
	private done: (manage?: WorkSectionId) => void;
	private text = new Text("", 0, 0);
	private scroll = new ScrollView(this.text, { scrollbar: "hidden" });
	private detail = "";
	private offsets = new Map<WorkSectionId, number>();
	private restoreOffset: number | undefined;
	private tabs: { start: number; end: number; id: WorkSectionId }[] = [];
	private footerRow = -1;
	private disposed = false;

	constructor(
		snapshot: WorkSnapshot,
		selected: WorkSectionId,
		theme: Theme,
		keys: KeybindingsManager,
		height: () => number,
		requestRender: () => void,
		done: (manage?: WorkSectionId) => void,
	) {
		this.snapshot = snapshot;
		this.selected = selected;
		this.theme = theme;
		this.keys = keys;
		this.height = height;
		this.requestRender = requestRender;
		this.done = done;
		this.update(snapshot);
	}

	update(snapshot: WorkSnapshot): void {
		if (this.disposed) return;
		this.snapshot = snapshot;
		const detail = this.section()?.detail ?? "No details available.";
		if (detail !== this.detail) {
			this.detail = detail;
			this.text.setText(safeWorkText(detail, true));
		}
		this.requestRender();
	}

	select(id: WorkSectionId): void {
		if (this.disposed || id === this.selected) return;
		this.offsets.set(this.selected, this.scroll.scrollTop);
		this.selected = id;
		// Restore after measuring the new section, not against the old bounds.
		this.restoreOffset = this.offsets.get(id) ?? 0;
		this.update(this.snapshot);
	}

	private section() { return this.snapshot.find(([id]) => id === this.selected)?.[1]; }
	private move(direction: number): void {
		const index = SECTION_ORDER.indexOf(this.selected);
		this.select(SECTION_ORDER[(index + direction + SECTION_ORDER.length) % SECTION_ORDER.length]!);
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) this.done();
		else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) this.move(-1);
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.move(1);
		else if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
		else if (this.keys.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
		else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
		else if (this.keys.matches(data, "tui.select.pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
		else if (matchesKey(data, Key.home)) this.scroll.scrollToStart();
		else if (matchesKey(data, Key.end)) this.scroll.scrollToEnd();
		else if (this.keys.matches(data, "tui.select.confirm") && this.section()?.manage) this.done(this.selected);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || event.shift || event.ctrl || event.alt) return;
		if (event.type === "wheel" && event.wheelDelta) {
			this.scroll.scrollBy(event.wheelDelta);
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left") return;
		const tab = event.y === 1 ? this.tabs.find(tab => event.x >= tab.start && event.x < tab.end) : undefined;
		if (tab) {
			this.select(tab.id);
			return { handled: true, render: true };
		}
		if (event.y === this.footerRow && event.x >= 2 && event.x < 11) {
			this.done();
			return { handled: true };
		}
	}

	render(width: number): string[] {
		this.tabs = [];
		this.footerRow = -1;
		if (this.disposed || width <= 0) return [];
		const height = Math.max(1, Math.floor(this.height()));
		if (width < 5 || height < 6) return [truncateToWidth("Work · Esc close", width)];
		const inner = width - 4;
		const fit = (value: string) => truncateToWidth(value, inner, "…", true);
		const border = (value: string) => this.theme.fg("border", value);
		const row = (value: string) => border("│ ") + fit(value) + border(" │");
		let tabs = "";
		if (visibleWidth(SECTION_ORDER.map(id => SECTION_LABELS[id]).join(" · ")) <= inner) {
			for (const id of SECTION_ORDER) {
				if (tabs) tabs += this.theme.fg("dim", " · ");
				const start = 2 + visibleWidth(tabs);
				const label = SECTION_LABELS[id];
				this.tabs.push({ start, end: start + label.length, id });
				tabs += id === this.selected ? this.theme.fg("accent", this.theme.bold(label)) : this.theme.fg("muted", label);
			}
		} else {
			tabs = this.theme.fg("accent", `‹ ${SECTION_LABELS[this.selected]} (${SECTION_ORDER.indexOf(this.selected) + 1}/${SECTION_ORDER.length}) ›`);
		}
		const section = this.section();
		const size = height - 5;
		const content = this.scroll.render(inner);
		// Compose the native scroll state into a bounded viewport in either TUI mode.
		this.scroll.updateLayout(content.length, size, this.requestRender);
		if (this.restoreOffset !== undefined) {
			this.scroll.scrollTo(this.restoreOffset);
			this.restoreOffset = undefined;
		}
		const offset = this.scroll.scrollTop;
		const body = content.slice(offset, offset + size);
		while (body.length < size) body.push("");
		const manage = section?.manage ? ` · Enter: ${safeWorkText(section.manage.label)}` : "";
		const hints = `Esc close${manage} · ←/→ Tab section · ↑/↓ PgUp/Dn scroll`;
		const position = ` ${content.length ? offset + 1 : 0}–${Math.min(content.length, offset + size)}/${content.length} `;
		const bottom = truncateToWidth(position, width - 2, "");
		const title = truncateToWidth(" Work ", width - 2, "");
		this.footerRow = height - 2;
		return [
			border("╭") + this.theme.fg("accent", title) + border(`${"─".repeat(width - 2 - visibleWidth(title))}╮`),
			row(tabs),
			row(this.theme.fg(section?.tone ?? "muted", safeWorkText(section?.status ?? "—"))),
			...body.map(row),
			row(this.theme.fg("dim", hints)),
			border(`╰${bottom}${"─".repeat(Math.max(0, width - 2 - visibleWidth(bottom)))}╯`),
		];
	}

	invalidate(): void { this.text.invalidate(); }
	dispose(): void { this.disposed = true; this.tabs = []; }
}
