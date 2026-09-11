import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SECTION_ORDER, WorkDetailView, workPanelLines, type WorkSection, type WorkSectionId, type WorkSnapshot } from "./view.ts";
export { safeWorkText, workPanelLines, WorkDetailView } from "./view.ts";
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
	private overlay: { view: WorkDetailView; close: () => void } | undefined;

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
		this.listeners.clear();
		const overlay = this.overlay;
		this.overlay = undefined;
		const widgetInstalled = this.widgetInstalled;
		this.widgetInstalled = false;
		overlay?.view.dispose();
		try { overlay?.close(); } catch (error) { reportUiFailure(error); }
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
				if (section) this.sections.set(id, Object.freeze({ ...section, ...(section.action ? { action: Object.freeze({ ...section.action }) } : {}) }));
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
		this.overlay?.view.update(this.snapshot());
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
					render: (width) => disposed || !this.active(generation) ? [] : workPanelLines(this.snapshot(), theme, width),
					invalidate() {},
					dispose: () => { disposed = true; this.listeners.delete(changed); },
				};
			}, { placement: "aboveEditor" });
		}
		for (const listener of this.listeners) listener();
	}

	private forgetOverlay(view: WorkDetailView | undefined): void {
		if (this.overlay?.view === view) this.overlay = undefined;
	}

	async open(ctx: ExtensionCommandContext, initialSection?: WorkSectionId): Promise<void> {
		const generation = this.generation;
		if (!this.active(generation)) return;
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify("The work panel requires TUI mode.", "info");
			return;
		}
		if (this.overlay) return;
		let opened: WorkDetailView | undefined;
		try {
			const action = await ctx.ui.custom<WorkSectionId | undefined>((tui, theme, keybindings, done) => {
				const view = new WorkDetailView(this.snapshot(), {
					theme, keybindings, initialSection,
					getHeight: () => Math.max(1, Math.min(24, Math.floor(tui.terminal.rows * 0.7))),
					requestRender: () => { if (this.active(generation)) tui.requestRender(); },
					done,
				});
				opened = view;
				if (!this.active(generation)) view.dispose();
				else this.overlay = { view, close: () => done(undefined) };
				return view;
			}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "70%", anchor: "center" } });
			if (!this.active(generation)) return;
			this.forgetOverlay(opened);
			opened?.dispose();
			if (action) await this.sections.get(action)?.action?.run(ctx);
		} finally {
			this.forgetOverlay(opened);
			opened?.dispose();
		}
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
	pi.registerCommand("work", {
		description: "Expand goal, todos and subagents in a scrollable work panel",
		getArgumentCompletions: (prefix) => SECTION_ORDER.filter((id) => id.startsWith(prefix)).map((id) => ({ value: id, label: id })),
		handler: async (args, ctx) => {
			const section = args.trim().toLowerCase();
			if (section && !SECTION_ORDER.includes(section as WorkSectionId)) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /work [goal|todos|subagents]", "info");
				return;
			}
			await ui.open(ctx, section ? section as WorkSectionId : undefined);
		},
	});
	return ui;
}
