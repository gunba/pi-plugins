import { highlightCode, getLanguageFromPath, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	HStack,
	ScrollView,
	Text,
	VStack,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	sliceByColumn,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TUI,
} from "@earendil-works/pi-tui";
import { safeWorkText } from "../pi-work-ui/view.ts";

export class ActionBar implements Component {
	private hits: { from: number; to: number; action: () => void }[] = [];
	private items: () => { label: string; selected?: boolean; action: () => void }[];
	private theme: Theme;
	constructor(
		items: () => { label: string; selected?: boolean; action: () => void }[],
		theme: Theme,
	) {
		this.items = items;
		this.theme = theme;
	}
	invalidate(): void {}
	render(width: number): string[] {
		this.hits = [];
		let line = "";
		for (const item of this.items()) {
			const from = visibleWidth(line);
			const label = ` ${safeWorkText(item.label)} `;
			if (from >= width) break;
			this.hits.push({
				from,
				to: Math.min(width, from + visibleWidth(label)),
				action: item.action,
			});
			line += item.selected
				? this.theme.bg("selectedBg", this.theme.fg("accent", label))
				: this.theme.fg("muted", label);
		}
		return [truncateToWidth(line, width)];
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.alt || event.ctrl || event.shift)
			return;
		const hit = this.hits.find((h) => event.x >= h.from && event.x < h.to);
		if (hit) {
			hit.action();
			return { handled: true, render: true };
		}
	}
}

export class WorkspaceScroll extends ScrollView {
	private pendingRow?: number;
	reveal(row: number): void {
		this.pendingRow = row;
	}
	override updateLayout(
		contentHeight: number,
		viewportHeight: number,
		requestRender: () => void,
	): void {
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		if (this.pendingRow !== undefined) {
			const row = this.pendingRow;
			this.pendingRow = undefined;
			this.scrollTo(row);
		}
	}
	handleInput(data: string): void {
		if (matchesKey(data, "up")) this.scrollBy(-1);
		else if (matchesKey(data, "down")) this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-Math.max(1, this.viewportHeight - 2));
		else if (matchesKey(data, "pageDown")) this.scrollBy(Math.max(1, this.viewportHeight - 2));
		else if (matchesKey(data, "home")) this.scrollToStart();
		else if (matchesKey(data, "end")) this.scrollToEnd();
	}
}

export class Reader implements Component {
	focused = false;
	private raw: string[] = [];
	private rendered: string[] = [];
	private horizontal = 0;
	private query = "";
	private matches: number[] = [];
	private match = -1;
	private hunks: number[] = [];
	private numbers: string[] = [];
	private newLines: number[] = [];
	private numberWidth = 1;
	private maximumWidth = 0;
	private cache?: { width: number; lines: string[] };
	scroll?: WorkspaceScroll;
	onFocus?: () => void;
	private theme: Theme;
	private refresh: () => void;
	constructor(theme: Theme, refresh: () => void) {
		this.theme = theme;
		this.refresh = refresh;
	}
	set(text: string, path: string, diff = false): void {
		const safe = safeWorkText(text, true);
		this.raw = safe.split("\n");
		this.maximumWidth = this.raw.reduce((width, line) => Math.max(width, visibleWidth(line)), 0);
		this.newLines = [];
		if (diff) {
			let old = 0,
				next = 0,
				inHunk = false;
			const numbers = this.raw.map((line, row) => {
				const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
				if (hunk) {
					old = Number(hunk[1]);
					next = Number(hunk[2]);
					inHunk = true;
					return ["", ""];
				}
				if (!inHunk || line.startsWith("\\")) return ["", ""];
				if (line.startsWith("-")) return [String(old++), ""];
				this.newLines[row] = next;
				if (line.startsWith("+")) return ["", String(next++)];
				if (line.startsWith(" ")) return [String(old++), String(next++)];
				return ["", ""];
			});
			const size = String(Math.max(old, next)).length;
			this.numbers = numbers.map(([a, b]) => `${a!.padStart(size)} ${b!.padStart(size)} `);
		} else {
			this.numbers = this.raw.map(
				(_line, i) => `${String(i + 1).padStart(String(this.raw.length).length)} `,
			);
		}
		this.numberWidth = Math.max(1, ...this.numbers.slice(0, 1).map((number) => number.length));
		this.rendered = diff
			? this.raw.map((line) =>
					this.theme.fg(
						line.startsWith("+")
							? "toolDiffAdded"
							: line.startsWith("-")
								? "toolDiffRemoved"
								: line.startsWith("@@")
									? "accent"
									: "toolDiffContext",
						line,
					),
				)
			: safe.length <= 256_000
				? highlightCode(safe, getLanguageFromPath(path))
				: this.raw;
		this.hunks = this.raw.flatMap((line, index) => (/^@@/.test(line) ? [index] : []));
		this.horizontal = 0;
		this.search(this.query, false);
		this.invalidate();
	}
	search(query: string, move = true): void {
		this.query = query;
		this.matches = query
			? this.raw.flatMap((line, i) =>
					line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [i] : [],
				)
			: [];
		this.match = -1;
		if (move) this.nextMatch(1);
		this.invalidate();
		this.refresh();
	}
	get searchStatus(): string {
		return this.query ? `${Math.max(0, this.match + 1)}/${this.matches.length} matches` : "";
	}
	nextMatch(direction: number): void {
		if (!this.matches.length) return;
		this.match = (this.match + direction + this.matches.length) % this.matches.length;
		this.scroll?.reveal(this.matches[this.match]!);
		this.refresh();
	}
	goTo(line: number): void {
		const row = this.newLines.findIndex((value) => value >= line);
		this.scroll?.reveal(row >= 0 ? row : Math.max(0, Math.floor(line) - 1));
		this.refresh();
	}
	nextHunk(direction: number): void {
		const current = this.scroll?.scrollTop ?? 0;
		const target =
			direction > 0
				? (this.hunks.find((h) => h > current) ?? this.hunks[0])
				: ([...this.hunks].reverse().find((h) => h < current) ?? this.hunks.at(-1));
		if (target !== undefined) this.scroll?.scrollTo(target);
		this.refresh();
	}
	invalidate(): void {
		this.cache = undefined;
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const gutter = this.numberWidth;
		const lines = this.rendered.map((line, i) => {
			const number = this.theme.fg("dim", this.numbers[i] ?? "");
			const content = sliceByColumn(line, this.horizontal, Math.max(0, width - gutter), true);
			return truncateToWidth(
				number +
					(this.query && this.raw[i]?.toLocaleLowerCase().includes(this.query.toLocaleLowerCase())
						? this.theme.bg("selectedBg", content)
						: content),
				width,
			);
		});
		this.cache = { width, lines };
		return lines;
	}
	handleInput(data: string): void {
		if (matchesKey(data, "up") || data === "k") this.scroll?.scrollBy(-1);
		else if (matchesKey(data, "down") || data === "j") this.scroll?.scrollBy(1);
		else if (matchesKey(data, "pageUp"))
			this.scroll?.scrollBy(-Math.max(1, this.scroll.viewportHeight - 2));
		else if (matchesKey(data, "pageDown"))
			this.scroll?.scrollBy(Math.max(1, this.scroll.viewportHeight - 2));
		else if (matchesKey(data, "home")) this.scroll?.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll?.scrollToEnd();
		else if (matchesKey(data, "left")) {
			this.horizontal = Math.max(0, this.horizontal - 4);
			this.invalidate();
		} else if (matchesKey(data, "right")) {
			this.horizontal = Math.min(Math.max(0, this.maximumWidth - 1), this.horizontal + 4);
			this.invalidate();
		} else if (data === "n") this.nextMatch(1);
		else if (data === "N") this.nextMatch(-1);
		else if (data === "]") this.nextHunk(1);
		else if (data === "[") this.nextHunk(-1);
		this.refresh();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click" && event.button === "left") {
			this.onFocus?.();
			return { focus: true };
		}
	}
}

/** Owns the complete layout. Only public Pi layout and input APIs are used. */
export class WorkspaceLayout {
	readonly chat = new Container();
	readonly header = new Container();
	readonly editor = new Container();
	readonly footer = new Container();
	readonly status = new Container();
	readonly widgets = new Container();
	readonly content = new VStack();
	readonly tabs = new Container();
	readonly heading = new Container();
	readonly transcript: ScrollView;
	readonly workScroll: WorkspaceScroll;
	readonly readerScroll: WorkspaceScroll;
	readonly main: VStack;
	readonly right: VStack;
	readonly root: HStack;
	private share = 40;
	private side = true;
	private narrowSide = false;
	private divider: Component;
	readonly tui: TUI & { setLayoutRoot(component: Component | undefined): void };
	readonly reader: Reader;
	private theme: Theme;
	constructor(
		tui: TUI & { setLayoutRoot(component: Component | undefined): void },
		reader: Reader,
		theme: Theme,
	) {
		this.tui = tui;
		this.reader = reader;
		this.theme = theme;
		this.transcript = new ScrollView(new VStack([this.header, this.chat]), {
			primary: true,
			follow: "end",
			overscroll: "contain",
		});
		this.workScroll = new WorkspaceScroll(this.widgets, { overscroll: "contain" });
		this.readerScroll = new WorkspaceScroll(reader, { overscroll: "contain" });
		reader.scroll = this.readerScroll;
		this.main = new VStack([
			{ component: this.transcript, basis: 0, grow: 1, minSize: 1 },
			{ component: this.status, maxSize: 3 },
			{ component: this.editor, minSize: 3 },
			{ component: this.footer, maxSize: 2 },
		]);
		this.right = new VStack([
			{ component: this.tabs, maxSize: 1 },
			{ component: this.heading, maxSize: 2 },
			{ component: this.content, basis: 0, grow: 1, minSize: 1 },
		]);
		this.content.addChild(this.readerScroll, { basis: 0, grow: 1 });
		this.divider = {
			invalidate() {},
			render: () => Array.from({ length: tui.terminal.rows }, () => theme.fg("borderMuted", "│")),
			handleMouse: (event) => {
				if (event.button !== "left" || !["press", "drag", "release"].includes(event.type)) return;
				if (event.type !== "release")
					this.resize(100 * (1 - event.screenX / Math.max(1, tui.terminal.columns)));
				return { handled: true, capture: event.type === "press", render: true };
			},
		};
		this.root = new HStack();
		this.mount();
	}
	resize(percent: number): void {
		this.share = Math.max(25, Math.min(60, Math.round(percent)));
		this.mount();
	}
	get widthPercent(): number {
		return this.share;
	}
	toggle(): void {
		this.side = !this.side;
		this.mount();
	}
	show(reveal = true): void {
		this.side = true;
		if (reveal) this.narrowSide = true;
		this.mount();
	}
	focusChat(): void {
		this.narrowSide = false;
		this.mount();
	}
	reflow(): void {
		this.mount();
	}
	private mount(): void {
		this.root.clear();
		const width = Math.max(1, this.tui.terminal.columns);
		const split = this.side && width >= 80;
		const rightWidth = Math.round(((width - 1) * this.share) / 100);
		if (split || !this.side || !this.narrowSide)
			this.root.addChild(this.main, { basis: split ? width - 1 - rightWidth : width, shrink: 0 });
		if (split) {
			this.root.addChild(this.divider, { basis: 1, minSize: 1, maxSize: 1 });
		}
		if (this.side && (split || this.narrowSide))
			this.root.addChild(this.right, { basis: split ? rightWidth : width, shrink: 0 });
		this.tui.setLayoutRoot(this.root);
		this.tui.requestRender();
	}
	showWork(): void {
		this.content.clear();
		this.content.addChild(this.workScroll, { basis: 0, grow: 1 });
		this.tui.requestRender();
	}
	showReader(): void {
		this.content.clear();
		this.content.addChild(this.readerScroll, { basis: 0, grow: 1 });
		this.tui.requestRender();
	}
	showView(component: Component): void {
		this.content.clear();
		this.content.addChild(component, { basis: 0, grow: 1 });
		this.tui.requestRender();
	}
}
