import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SECTION_ORDER, type WorkSection, type WorkSectionId, type WorkSnapshot } from "./view.ts";
import { InlineWorkView } from "./inline.ts";
export { safeWorkText, workPanelLines } from "./view.ts";
export type { WorkSection, WorkSectionId, WorkSnapshot } from "./view.ts";

export const WORK_WIDGET_KEY = "pi-work";
const DISCOVER = "pi-work-ui/discover-v1";

function reportUiFailure(error: unknown): void {
	if (error instanceof Error && error.message.includes("extension ctx is stale")) return;
	console.warn("Work panel UI update failed:", error);
}

export interface WorkUiSource {
	/** A generation-bound lease. Updates after tree navigation or shutdown are ignored. */
	set(section: WorkSection | undefined): void;
	dispose(): void;
}

/** Presentation only: no persistence, inference, session writes, editor or footer overrides. */
export class WorkUi {
	private ctx: ExtensionContext | undefined;
	private generation = 0;
	private closed = false;
	private widgetInstalled = false;
	private sections = new Map<WorkSectionId, Readonly<WorkSection>>();
	private owners = new Map<WorkSectionId, symbol>();
	private listeners = new Set<() => void>();
	private inline = new InlineWorkView();
	private currentSnapshot: WorkSnapshot = [];

	start(ctx: ExtensionContext): void {
		if (this.closed) return;
		this.reset();
		this.ctx = ctx;
	}

	private reset(touchUi = true): void {
		// Retire leases and callbacks before touching the UI. Old component renders
		// and async command continuations must not read a retired ExtensionContext.
		const ctx = this.ctx;
		this.ctx = undefined;
		this.generation += 1;
		this.owners.clear();
		this.sections.clear();
		this.currentSnapshot = [];
		this.inline.reset();
		this.listeners.clear();
		const widgetInstalled = this.widgetInstalled;
		this.widgetInstalled = false;
		if (touchUi && widgetInstalled) {
			try { ctx?.ui.setWidget(WORK_WIDGET_KEY, undefined); }
			catch (error) { reportUiFailure(error); }
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.reset();
	}

	private active(generation: number): boolean {
		return !this.closed && this.ctx !== undefined && generation === this.generation;
	}

	snapshot(): WorkSnapshot {
		return SECTION_ORDER.flatMap((id) => {
			const section = this.sections.get(id);
			return section ? [[id, section] as const] : [];
		});
	}

	/** Call from a source's session_start/session_tree hook, not from rendering. */
	source(id: WorkSectionId): WorkUiSource {
		const generation = this.generation;
		const owner = Symbol(id);
		let disposed = false;
		if (this.active(generation)) {
			this.owners.set(id, owner);
			if (this.sections.delete(id)) this.refresh();
		}
		const current = () => !disposed && this.active(generation) && this.owners.get(id) === owner;
		return {
			set: (section) => {
				if (!current()) return;
				if (section) this.sections.set(id, Object.freeze({ ...section }));
				else this.sections.delete(id);
				this.refresh();
			},
			dispose: () => {
				if (current()) {
					this.owners.delete(id);
					this.sections.delete(id);
					this.refresh();
				}
				disposed = true;
			},
		};
	}

	private refresh(): void {
		try { this.refreshUi(); }
		catch (error) {
			// SDK invalidation can occur without session_shutdown. Optional
			// presentation must not fail a task or retain active stale callbacks.
			this.closed = true;
			this.reset(false);
			reportUiFailure(error);
		}
	}

	private refreshUi(): void {
		const ctx = this.ctx;
		if (this.closed || !ctx || ctx.mode !== "tui") return;
		this.currentSnapshot = this.snapshot();
		this.inline.invalidate();
		if (!this.sections.size) {
			if (this.widgetInstalled) ctx.ui.setWidget(WORK_WIDGET_KEY, undefined);
			this.widgetInstalled = false;
			return;
		}
		if (!this.widgetInstalled) {
			this.widgetInstalled = true;
			const generation = this.generation;
			ctx.ui.setWidget(WORK_WIDGET_KEY, (tui, theme) => {
				let disposed = false;
				const changed = () => { if (!disposed && this.active(generation)) tui.requestRender(); };
				if (this.active(generation)) this.listeners.add(changed);
				return {
					render: (width) => disposed || !this.active(generation) ? [] : this.inline.render(
						this.currentSnapshot, theme, width, Math.max(3, Math.min(24, Math.floor(tui.terminal.rows / 2))),
					),
					handleMouse: (event) => disposed || !this.active(generation) ? undefined : this.inline.handleMouse(event),
					invalidate: () => this.inline.invalidate(),
					dispose: () => { disposed = true; this.listeners.delete(changed); },
				};
			}, { placement: "aboveEditor" });
		}
		for (const listener of this.listeners) listener();
	}

	page(direction: number): void {
		if (!this.ctx || this.closed || this.ctx.mode !== "tui") return;
		this.inline.page(direction);
		for (const listener of this.listeners) listener();
	}

	toggle(id: WorkSectionId): void {
		if (!this.ctx || this.closed || this.ctx.mode !== "tui" || !this.sections.has(id)) return;
		this.inline.toggle(id);
		for (const listener of this.listeners) listener();
	}
}

/** Every package calls this, including standalone entry points. The host supplies
 * distinct events facades, so deduplicate via a synchronous underlying-bus probe. */
export function ensureWorkUi(pi: ExtensionAPI): WorkUi {
	const probe: { ui?: WorkUi } = {};
	pi.events.emit(DISCOVER, probe);
	if (probe.ui) return probe.ui;
	const ui = new WorkUi();
	const release = pi.events.on(DISCOVER, (value) => {
		if (value && typeof value === "object") (value as typeof probe).ui = ui;
	});
	pi.on("session_start", (_event, ctx) => ui.start(ctx));
	pi.on("session_tree", (_event, ctx) => ui.start(ctx));
	pi.on("session_shutdown", () => { try { ui.close(); } finally { release(); } });
	pi.registerShortcut("alt+pageUp", { description: "Scroll expanded work panel up", handler: async () => ui.page(-1) });
	pi.registerShortcut("alt+pageDown", { description: "Scroll expanded work panel down", handler: async () => ui.page(1) });
	const keys = ["alt+1", "alt+2", "alt+3", "alt+4"] as const;
	for (const [index, id] of SECTION_ORDER.entries()) {
		pi.registerShortcut(keys[index]!, { description: `Expand or collapse ${id}`, handler: async () => ui.toggle(id) });
	}
	return ui;
}
