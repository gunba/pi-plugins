const MARKER = "pi-desk:surface";
interface HistoryPort {
	readonly state: unknown; readonly length: number;
	pushState(state: unknown, title: string): void;
	replaceState(state: unknown, title: string): void;
	back(): void;
}
export interface Surface {
	close: () => void;
	back?: () => void;
}
const stateObject = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** One transient history entry protects the whole stack; Back dismisses one surface. */
export class SurfaceHistory<T extends Surface = Surface> {
	private history: HistoryPort;
	private canPush: () => boolean;
	private token = crypto.randomUUID();
	private entries: T[] = [];
	private scheduled = false;
	private returning = false;
	private prepared?: Promise<void>;
	private resumed?: () => void;
	constructor(history: HistoryPort, canPush: () => boolean = () => true) {
		this.history = history; this.canPush = canPush;
	}
	get top(): T | undefined { return this.entries.at(-1); }
	get stack(): readonly T[] { return this.entries; }
	private get owned(): boolean { return stateObject(this.history.state)[MARKER] === this.token; }
	private strip(): void {
		const state = { ...stateObject(this.history.state) }; delete state[MARKER];
		this.history.replaceState(state, "");
	}
	prepare(): Promise<void> {
		if (this.prepared) return this.prepared;
		if (typeof stateObject(this.history.state)[MARKER] === "string" && this.history.length > 1) {
			this.returning = true;
			this.prepared = new Promise(resolve => { this.resumed = resolve; });
			this.history.back();
		} else { this.strip(); this.prepared = Promise.resolve(); }
		return this.prepared;
	}
	add(surface: T): () => void {
		this.entries.push(surface); this.changed();
		return () => this.remove(surface);
	}
	private remove(surface: T): void {
		const index = this.entries.indexOf(surface);
		if (index !== -1) { this.entries.splice(index, 1); this.changed(); }
	}
	dismiss(surface: T): void { this.remove(surface); surface.close(); }
	back(): void {
		const top = this.top;
		if (top?.back) top.back();
		else if (top) this.dismiss(top);
	}
	pop(): void {
		const returning = this.returning; this.returning = false;
		this.resumed?.(); this.resumed = undefined;
		if (!returning && !this.owned) this.back();
		if (!this.entries.length && stateObject(this.history.state)[MARKER]) this.strip();
		this.changed();
	}
	changed(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.returning || !this.canPush()) return;
			if (this.entries.length && !this.owned) {
				this.history.pushState({ ...stateObject(this.history.state), [MARKER]: this.token }, "");
			} else if (!this.entries.length && this.owned) {
				this.returning = true; this.history.back();
			}
		});
	}
}
