import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SECTION_ORDER, workPanelLines, type WorkSection, type WorkSectionId, type WorkSnapshot } from "./view.ts";
import { WorkModal } from "./modal.ts";
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
	private currentSnapshot: WorkSnapshot = [];
	private interaction: symbol | undefined;
	private modal: WorkModal | undefined;
	private closeModal: (() => void) | undefined;

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
		this.interaction = undefined;
		const close = this.closeModal;
		this.closeModal = undefined;
		this.modal = undefined;
		try { close?.(); } catch (error) { reportUiFailure(error); }
		this.owners.clear();
		this.sections.clear();
		this.currentSnapshot = [];
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
				if (section) this.sections.set(id, Object.freeze({
					...section, ...(section.manage ? { manage: Object.freeze({ ...section.manage }) } : {}),
				}));
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
		if (!this.sections.size) {
			if (this.widgetInstalled) ctx.ui.setWidget(WORK_WIDGET_KEY, undefined);
			this.widgetInstalled = false;
		}
		if (this.sections.size && !this.widgetInstalled) {
			this.widgetInstalled = true;
			const generation = this.generation;
			ctx.ui.setWidget(WORK_WIDGET_KEY, (tui, theme) => {
				let disposed = false;
				let visibleRows = 0;
				let cache: { snapshot: WorkSnapshot; width: number; height: number; lines: string[] } | undefined;
				const changed = () => { if (!disposed && this.active(generation)) tui.requestRender(); };
				if (this.active(generation)) this.listeners.add(changed);
				return {
					render: (width) => {
						if (disposed || !this.active(generation)) return [];
						const height = Math.max(3, Math.floor(tui.terminal.rows / 2));
						if (!cache || cache.snapshot !== this.currentSnapshot || cache.width !== width || cache.height !== height) {
							cache = { snapshot: this.currentSnapshot, width, height, lines: workPanelLines(this.currentSnapshot, theme, width).slice(0, height) };
						}
						visibleRows = cache.lines.length;
						return cache.lines;
					},
					handleMouse: (event) => {
						if (disposed || !this.active(generation)) return;
						if (event.type !== "click" || event.button !== "left" || event.shift || event.ctrl || event.alt || event.y >= visibleRows) return;
						const section = this.currentSnapshot[event.y - 1];
						if (!section) return;
						void this.open(ctx, section[0]).catch(reportUiFailure);
						return { handled: true };
					},
					invalidate() { cache = undefined; },
					dispose: () => { disposed = true; this.listeners.delete(changed); },
				};
			}, { placement: "aboveEditor" });
		}
		for (const listener of this.listeners) listener();
	}

	async open(ctx: ExtensionContext, selected: WorkSectionId = this.currentSnapshot[0]?.[0] ?? "goal"): Promise<void> {
		if (!this.active(this.generation) || ctx.mode !== "tui") return;
		if (this.interaction) { this.modal?.select(selected); return; }
		const generation = this.generation;
		const interaction = this.interaction = Symbol("work-modal");
		try {
			while (this.active(generation)) {
				let owner: symbol | undefined;
				const action = await ctx.ui.custom<WorkSectionId | undefined>((tui, theme, keys, done) => {
					if (!this.active(generation)) {
						queueMicrotask(() => done(undefined));
						return { render: () => [], invalidate() {} };
					}
					let finished = false;
					const finish = (id?: WorkSectionId) => {
						if (finished) return;
						finished = true;
						owner = id ? this.owners.get(id) : undefined;
						done(id);
					};
					const modal = new WorkModal(this.currentSnapshot, selected, theme, keys,
						() => Math.floor(tui.terminal.rows * 0.85),
						() => { if (this.active(generation) && !finished) tui.requestRender(); },
						finish);
					this.modal = modal;
					this.closeModal = () => finish();
					const changed = () => modal.update(this.currentSnapshot);
					this.listeners.add(changed);
					return {
						render: width => this.active(generation) ? modal.render(width) : [],
						handleInput: data => { if (this.active(generation)) modal.handleInput(data); },
						handleMouse: event => this.active(generation) ? modal.handleMouse(event) : undefined,
						invalidate: () => modal.invalidate(),
						dispose: () => { modal.dispose(); this.listeners.delete(changed); },
					};
				}, { overlay: true, overlayOptions: { anchor: "center", width: "92%", maxHeight: "85%" } });
				if (!this.active(generation)) return;
				this.modal = undefined;
				this.closeModal = undefined;
				if (!action) return;
				selected = action;
				if (owner === this.owners.get(action)) await this.sections.get(action)?.manage?.run(ctx);
			}
		} finally {
			if (this.interaction === interaction) {
				this.interaction = undefined;
				this.modal = undefined;
				this.closeModal = undefined;
			}
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
		description: "Open work details: goal, todos, subagents, party, scheduled",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("Work details require TUI mode.", "warning"); return; }
			const id = args.trim() as WorkSectionId;
			if (id && !SECTION_ORDER.includes(id)) { ctx.ui.notify(`Usage: /work [${SECTION_ORDER.join("|")}]`, "warning"); return; }
			await ui.open(ctx, id || undefined);
		},
	});
	return ui;
}
