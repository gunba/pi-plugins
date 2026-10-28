import type { OperatorPresence } from "../shared/operator.ts";
import { setOperatorAvailability } from "./operator.ts";

/** Without use of Desk in any window for this long, its user is away. */
export const AWAY_AFTER = 15 * 60_000;
const MAX_WINDOWS = 64;

/**
 * Whether the user is at Desk, from use rather than a setting: every open window, on any device, reports when it was
 * last used (client presence.ts), and the user is away once no window has been used for AWAY_AFTER. Conversations'
 * processes read the result from operator.json (operator.ts), which this keeps current.
 */
export class Presence {
	private windows = new Map<string, { used: number; device: string }>();
	private timer?: ReturnType<typeof setTimeout>;
	private shown?: string;

	private directory: string;
	private changed: () => void;
	constructor(directory: string, changed: () => void) { this.directory = directory; this.changed = changed; this.update(); }

	/** `ago`: how long before now the window was last used, so its clock does not matter. */
	report(window: string, ago: number, device: string): void {
		const used = Date.now() - Math.max(0, ago), known = this.windows.get(window);
		if (known && known.used >= used) return;
		this.windows.delete(window); this.windows.set(window, { used, device });
		if (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value!);
		this.update();
	}
	get present(): boolean { return this.view.present; }
	get view(): OperatorPresence {
		let latest: { used: number; device: string } | undefined;
		for (const window of this.windows.values()) if (!latest || window.used > latest.used) latest = window;
		return latest ? { present: Date.now() - latest.used < AWAY_AFTER, device: latest.device, used: latest.used } : { present: false };
	}
	close(): void { clearTimeout(this.timer); }

	private update(): void {
		const view = this.view, now = Date.now();
		for (const [id, window] of this.windows) if (now - window.used >= AWAY_AFTER && window.used !== view.used) this.windows.delete(id);
		clearTimeout(this.timer);
		if (view.present) { this.timer = setTimeout(() => this.update(), view.used! + AWAY_AFTER - now + 1000); this.timer.unref(); }
		// Browsers hear of a change of state or device; the time of use goes out with the next state they receive.
		const shown = `${view.present}\0${view.device ?? ""}`;
		if (shown === this.shown) return;
		const first = this.shown === undefined; this.shown = shown;
		setOperatorAvailability(this.directory, view.present ? "present" : "away");
		if (!first) this.changed();
	}
}
