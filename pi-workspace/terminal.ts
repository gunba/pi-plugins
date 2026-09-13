import type { Terminal } from "@earendil-works/pi-tui";

/** Coordinates the frontend's layout with the public terminal resize callback. */
export class WorkspaceTerminal implements Terminal {
	onResize?: () => void;
	onInput?: (data: string) => boolean;
	private terminal: Terminal;
	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}
	get columns(): number {
		return this.terminal.columns;
	}
	get rows(): number {
		return this.terminal.rows;
	}
	get kittyProtocolActive(): boolean {
		return this.terminal.kittyProtocolActive;
	}
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.terminal.start(
			(data) => {
				if (!this.onInput?.(data)) onInput(data);
			},
			() => {
				this.onResize?.();
				onResize();
			},
		);
	}
	stop(): void {
		this.terminal.stop();
	}
	drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		return this.terminal.drainInput(maxMs, idleMs);
	}
	write(data: string): void {
		this.terminal.write(data);
	}
	moveBy(lines: number): void {
		this.terminal.moveBy(lines);
	}
	hideCursor(): void {
		this.terminal.hideCursor();
	}
	showCursor(): void {
		this.terminal.showCursor();
	}
	clearLine(): void {
		this.terminal.clearLine();
	}
	clearFromCursor(): void {
		this.terminal.clearFromCursor();
	}
	clearScreen(): void {
		this.terminal.clearScreen();
	}
	setTitle(title: string): void {
		this.terminal.setTitle(title);
	}
	setProgress(active: boolean): void {
		this.terminal.setProgress(active);
	}
}
