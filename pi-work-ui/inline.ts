import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { safeWorkText, workPanelLines, type WorkSectionId, type WorkSnapshot } from "./view.ts";

/** Per-section display state. Pointer input never takes focus from the editor. */
export class InlineWorkView {
	private expanded = new Set<WorkSectionId>();
	private selected: WorkSectionId | undefined;
	private offsets = new Map<WorkSectionId, number>();
	private pages = new Map<WorkSectionId, { size: number; total: number }>();
	private rows = new Map<number, { id: WorkSectionId; kind: "header" | "detail" | "pager" }>();
	private cache = new Map<WorkSectionId, { width: number; text: string; lines: string[] }>();

	toggle(id: WorkSectionId): void {
		if (this.expanded.has(id)) this.expanded.delete(id);
		else this.expanded.add(id);
		this.selected = id;
		this.offsets.set(id, 0);
	}

	page(direction: number, id = this.selected, lines = false): void {
		if (!id) return;
		const page = this.pages.get(id);
		if (!page) return;
		this.selected = id;
		this.offsets.set(id, Math.max(0, Math.min(Math.max(0, page.total - page.size),
			(this.offsets.get(id) ?? 0) + direction * (lines ? 1 : page.size))));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const row = this.rows.get(event.y);
		if (!row || event.shift || event.ctrl || event.alt) return;
		if (event.type === "click" && event.button === "left") {
			if (row.kind === "header") this.toggle(row.id);
			else if (row.kind === "pager") this.page(event.x < event.width / 2 ? -1 : 1, row.id);
			else return;
			return { handled: true, render: true };
		}
		if (event.type === "wheel" && row.kind !== "header" && event.wheelDelta) {
			const before = this.offsets.get(row.id);
			this.page(event.wheelDelta, row.id, true);
			if (before !== this.offsets.get(row.id)) return { handled: true, render: true };
		}
	}

	reset(): void { this.expanded.clear(); this.offsets.clear(); this.pages.clear(); this.rows.clear(); this.selected = undefined; this.invalidate(); }
	invalidate(): void { this.cache.clear(); }

	render(snapshot: WorkSnapshot, theme: Theme, width: number, height: number): string[] {
		this.rows.clear();
		this.pages.clear();
		if (!snapshot.length || width <= 0 || height <= 0) return [];
		const compact = workPanelLines(snapshot, theme, width);
		const open = snapshot.filter(([id]) => this.expanded.has(id)).length;
		const budget = Math.max(0, Math.floor((height - 1 - snapshot.length) / Math.max(1, open)));
		const result = [compact[0]!];
		for (const [index, [id, section]] of snapshot.entries()) {
			this.rows.set(result.length, { id, kind: "header" });
			result.push(compact[index + 1]!.replace("›", this.expanded.has(id) ? "▾" : "▸"));
			if (!this.expanded.has(id) || !budget) continue;
			const text = safeWorkText(section.detail, true);
			let cached = this.cache.get(id);
			if (!cached || cached.width !== width || cached.text !== text) {
				cached = { width, text, lines: wrapTextWithAnsi(text, Math.max(1, width - 2)).map(line => truncateToWidth(`  ${line}`, width)) };
				this.cache.set(id, cached);
			}
			const paged = cached.lines.length > budget;
			const size = Math.max(1, budget - (paged && budget > 1 ? 1 : 0));
			const offset = Math.max(0, Math.min(this.offsets.get(id) ?? 0, cached.lines.length - size));
			this.offsets.set(id, offset);
			this.pages.set(id, { size, total: cached.lines.length });
			for (const line of cached.lines.slice(offset, offset + size)) {
				this.rows.set(result.length, { id, kind: "detail" });
				result.push(line);
			}
			if (paged && budget > 1) {
				this.rows.set(result.length, { id, kind: "pager" });
				result.push(theme.fg("dim", truncateToWidth(`  ‹ ${offset + 1}–${Math.min(cached.lines.length, offset + size)}/${cached.lines.length} ›`, width)));
			}
		}
		return result.slice(0, height);
	}
}
