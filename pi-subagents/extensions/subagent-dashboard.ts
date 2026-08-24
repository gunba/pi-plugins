import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import type { RuntimeChildSnapshot } from "./subagent-runtime.ts";

export type DashboardSnapshot = {
	rootSessionId: string;
	agents: RuntimeChildSnapshot[];
	feed: string[];
	transcript: string[];
	transcriptError?: string;
};

export type DashboardAction = {
	action: "message" | "interrupt";
	id: string;
};

export type DashboardRow = { agent: RuntimeChildSnapshot; depth: number };

const GLYPH: Record<RuntimeChildSnapshot["state"], string> = {
	running: "●",
	waiting: "◐",
	settled: "✓",
	error: "✗",
	aborted: "■",
};

const STATE_COLOR: Record<RuntimeChildSnapshot["state"], ThemeColor> = {
	running: "accent",
	waiting: "warning",
	settled: "success",
	error: "error",
	aborted: "warning",
};

function directPrintableInput(data: string): string | undefined {
	const characters = [...data];
	if (characters.length !== 1) return undefined;
	const codePoint = characters[0]?.codePointAt(0);
	return codePoint !== undefined && codePoint >= 32 && codePoint !== 127
		? data
		: undefined;
}

function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const clipped = truncateToWidth(text, safeWidth);
	return `${clipped}${" ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)))}`;
}

function boxedLine(
	content: string,
	width: number,
	color: (text: string) => string,
): string {
	if (width <= 2) return fitLine(content, width);
	return color("│") + fitLine(content, width - 2) + color("│");
}

function borderLine(
	width: number,
	left: string,
	fill: string,
	right: string,
	color: (text: string) => string,
	label?: string,
): string {
	if (width <= 2) return color(fill.repeat(Math.max(0, width)));
	const inner = width - 2;
	if (!label || visibleWidth(label) + 2 >= inner)
		return color(`${left}${fill.repeat(inner)}${right}`);
	const tag = ` ${label} `;
	const rest = Math.max(0, inner - visibleWidth(tag) - 1);
	return color(`${left}${fill}`) + tag + color(`${fill.repeat(rest)}${right}`);
}

function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTokens(value = 0): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}

export function flattenDashboardAgents(
	agents: RuntimeChildSnapshot[],
	rootSessionId: string,
): DashboardRow[] {
	const byParent = new Map<string, RuntimeChildSnapshot[]>();
	for (const agent of agents) {
		const siblings = byParent.get(agent.parentId) ?? [];
		siblings.push(agent);
		byParent.set(agent.parentId, siblings);
	}
	for (const siblings of byParent.values())
		siblings.sort(
			(a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
		);
	const rows: DashboardRow[] = [];
	const seen = new Set<string>();
	const walk = (parentId: string, depth: number): void => {
		for (const agent of byParent.get(parentId) ?? []) {
			if (seen.has(agent.id)) continue;
			seen.add(agent.id);
			rows.push({ agent, depth });
			walk(agent.id, depth + 1);
		}
	};
	walk(rootSessionId, 0);
	for (const agent of agents) {
		if (!seen.has(agent.id)) rows.push({ agent, depth: 0 });
	}
	return rows;
}

export function activitySummary(agents: RuntimeChildSnapshot[]): string {
	const running = agents.filter((agent) => agent.state === "running").length;
	const waiting = agents.filter((agent) => agent.state === "waiting").length;
	const ready = agents.filter((agent) => agent.state === "settled").length;
	const attention = agents.filter(
		(agent) => agent.state === "error" || agent.state === "aborted",
	).length;
	const parts = [`${running} running`];
	if (waiting) parts.push(`${waiting} waiting`);
	if (ready) parts.push(`${ready} ready`);
	if (attention) parts.push(`${attention} need attention`);
	return `Subagents: ${parts.join(" · ")}  —  /subagents`;
}

export class SubagentDashboard implements Component {
	private selectedId: string | undefined;
	private filter = "";
	private searching = false;
	private transcriptOffset = 0;
	private lastTranscriptWidth = 80;
	private cachedWidth: number | undefined;
	private cachedHeight: number | undefined;
	private cachedLines: string[] | undefined;
	private snapshot: DashboardSnapshot;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: (action: DashboardAction | null) => void;
	private readonly getViewportHeight: () => number;
	private readonly onSelectionChange: (id: string | undefined) => void;

	constructor(
		snapshot: DashboardSnapshot,
		initialId: string | undefined,
		theme: Theme,
		requestRender: () => void,
		done: (action: DashboardAction | null) => void,
		getViewportHeight: () => number = () => 36,
		onSelectionChange: (id: string | undefined) => void = () => {},
	) {
		this.snapshot = snapshot;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		this.getViewportHeight = getViewportHeight;
		this.onSelectionChange = onSelectionChange;
		this.selectedId = initialId;
		this.clampSelection();
	}

	getSelectedId(): string | undefined {
		return this.selectedId;
	}

	update(snapshot: DashboardSnapshot): void {
		this.snapshot = snapshot;
		this.clampSelection();
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.searching) {
			this.handleSearchInput(data);
			return;
		}
		if (this.handleNavigationInput(data)) return;
		const selected = this.snapshot.agents.find((agent) => agent.id === this.selectedId);
		if (
			data === "m" &&
			selected?.mode === "continuable" &&
			selected.parentId === this.snapshot.rootSessionId
		)
			this.done({ action: "message", id: selected.id });
		if (data === "x" && this.selectedId)
			this.done({ action: "interrupt", id: this.selectedId });
	}

	private handleSearchInput(data: string): void {
		const previousSelection = this.selectedId;
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.return)
		) {
			this.searching = false;
		} else if (
			matchesKey(data, Key.backspace) ||
			matchesKey(data, Key.delete)
		) {
			this.filter = [...this.filter].slice(0, -1).join("");
			this.clampSelection(true);
		} else if (matchesKey(data, Key.ctrl("u"))) {
			this.filter = "";
			this.clampSelection(true);
		} else {
			const printable = decodeKittyPrintable(data) ?? directPrintableInput(data);
			if (printable) {
				this.filter += printable;
				this.clampSelection(true);
			}
		}
		if (this.selectedId !== previousSelection)
			this.onSelectionChange(this.selectedId);
		this.invalidateAndRender();
	}

	private handleNavigationInput(data: string): boolean {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(null);
			return true;
		}
		if (data === "/") {
			this.searching = true;
			this.invalidateAndRender();
			return true;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
			return true;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
			return true;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.transcriptOffset += 12;
			this.invalidateAndRender();
			return true;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.transcriptOffset = Math.max(0, this.transcriptOffset - 12);
			this.invalidateAndRender();
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const safeHeight = Math.max(6, this.getViewportHeight());
		if (
			this.cachedLines &&
			this.cachedWidth === safeWidth &&
			this.cachedHeight === safeHeight
		)
			return this.cachedLines;
		const color = (text: string) => this.theme.fg("accent", text);
		const rows = this.filteredRows();
		const selected = rows.find((row) => row.agent.id === this.selectedId);
		const lines = [
			borderLine(safeWidth, "╭", "─", "╮", color, " background activity "),
			boxedLine(
				` ${this.theme.fg("text", activitySummary(this.snapshot.agents))}`,
				safeWidth,
				color,
			),
			boxedLine(
				this.searching
					? ` Search: ${this.filter || this.theme.fg("dim", "type an id, label, state, or model")}`
					: this.theme.fg(
							"dim",
							" ↑↓/jk agents · / search · PgUp/PgDn transcript · m message · x interrupt · Esc close",
						),
				safeWidth,
				color,
			),
			borderLine(safeWidth, "├", "─", "┤", color),
		];
		const bodyRows = Math.max(1, safeHeight - 5);
		if (rows.length === 0) {
			lines.push(
				boxedLine(
					this.theme.fg(
						"warning",
						this.filter ? ` No matches for ${JSON.stringify(this.filter)}` : " No subagents",
					),
					safeWidth,
					color,
				),
			);
		} else if (safeWidth >= 100) {
			this.renderSplit(lines, rows, selected, safeWidth, bodyRows, color);
		} else {
			this.renderStacked(lines, rows, selected, safeWidth, bodyRows, color);
		}
		while (lines.length < safeHeight - 1)
			lines.push(boxedLine("", safeWidth, color));
		if (lines.length > safeHeight - 1) lines.length = safeHeight - 1;
		const position = selected
			? `${rows.findIndex((row) => row.agent.id === selected.agent.id) + 1}/${rows.length}`
			: `0/${rows.length}`;
		lines.push(borderLine(safeWidth, "╰", "─", "╯", color, position));
		this.cachedWidth = safeWidth;
		this.cachedHeight = safeHeight;
		this.cachedLines = lines;
		return lines;
	}

	private renderSplit(
		lines: string[],
		rows: DashboardRow[],
		selected: DashboardRow | undefined,
		width: number,
		height: number,
		color: (text: string) => string,
	): void {
		const inner = width - 2;
		const leftWidth = Math.max(38, Math.min(64, Math.floor(inner * 0.42)));
		const rightWidth = inner - leftWidth - 1;
		const visibleRows = this.visibleRows(rows, height);
		const detail = this.detailLines(selected, height, rightWidth);
		for (let index = 0; index < height; index++) {
			const row = visibleRows[index];
			const left = row
				? this.renderAgentRow(row, row.agent.id === this.selectedId, leftWidth)
				: "";
			lines.push(
				color("│") +
					fitLine(left, leftWidth) +
					color("│") +
					fitLine(detail[index] ?? "", rightWidth) +
					color("│"),
			);
		}
	}

	private renderStacked(
		lines: string[],
		rows: DashboardRow[],
		selected: DashboardRow | undefined,
		width: number,
		height: number,
		color: (text: string) => string,
	): void {
		const listHeight = height >= 8 ? Math.min(10, Math.max(3, Math.floor(height * 0.3))) : 1;
		const visibleRows = this.visibleRows(rows, listHeight);
		for (let index = 0; index < listHeight; index++) {
			const row = visibleRows[index];
			lines.push(
				boxedLine(
					row
						? this.renderAgentRow(row, row.agent.id === this.selectedId, width - 2)
						: "",
					width,
					color,
				),
			);
		}
		const detailHeight = Math.max(0, height - listHeight - 1);
		lines.push(borderLine(width, "├", "─", "┤", color, " selected agent "));
		const details = this.detailLines(selected, detailHeight, width - 2);
		for (let index = 0; index < detailHeight; index++)
			lines.push(boxedLine(details[index] ?? "", width, color));
	}

	private renderAgentRow(
		row: DashboardRow,
		selected: boolean,
		width: number,
	): string {
		const agent = row.agent;
		const branch = row.depth === 0 ? "" : `${"  ".repeat(Math.min(row.depth, 4))}↳ `;
		const id = agent.id.slice(0, 8);
		const text = `${selected ? "→" : " "} ${branch}${this.theme.fg(STATE_COLOR[agent.state], GLYPH[agent.state])} ${this.theme.bold(agent.label)}  ${this.theme.fg(STATE_COLOR[agent.state], agent.state)} · ${id}`;
		return selected
			? this.theme.fg("accent", truncateToWidth(text, width))
			: truncateToWidth(text, width);
	}

	private detailLines(
		selected: DashboardRow | undefined,
		maxRows: number,
		width: number,
	): string[] {
		if (!selected) return [this.theme.fg("dim", "Select an agent to inspect it")];
		const agent = selected.agent;
		const duration = formatAge((agent.finishedAt ?? Date.now()) - agent.createdAt);
		const usage = agent.usage
			? `↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)} · ctx ${formatTokens(agent.usage.contextTokens)} · $${agent.usage.cost.toFixed(4)}`
			: undefined;
		const metadata = [
			this.theme.fg("accent", this.theme.bold(agent.label)),
			agent.id,
			`${agent.state}${agent.activity ? ` · ${agent.activity}` : ""} · ${agent.context} ${agent.mode} · ${duration}`,
			`Parent: ${agent.parentId}`,
			`Model: ${agent.model} · thinking ${agent.thinkingLevel}`,
			usage,
			"",
			this.theme.fg("accent", "── session tail ──"),
			"",
		].filter((line): line is string => line !== undefined);
		const feed = this.snapshot.feed.length
			? [
					"",
					this.theme.fg("accent", "── recent activity ──"),
					...this.snapshot.feed.slice(-2).map((line) => this.theme.fg("dim", line)),
				]
			: [];
		const room = Math.max(1, maxRows - metadata.length - feed.length);
		const transcript = this.transcriptWindow(room, width).map((line) =>
			this.theme.fg("muted", line),
		);
		if (transcript.length === 0)
			transcript.push(
				this.theme.fg(
					"dim",
					this.snapshot.transcriptError ?? "No session entries yet",
				),
			);
		return [...metadata, ...transcript, ...feed].slice(0, maxRows);
	}

	private transcriptWindow(maxRows: number, width: number): string[] {
		this.lastTranscriptWidth = width;
		const lines = this.snapshot.transcript.flatMap((line) =>
			line.length ? wrapTextWithAnsi(line, Math.max(8, width)) : [""],
		);
		const end = Math.max(0, lines.length - this.transcriptOffset);
		return lines.slice(Math.max(0, end - maxRows), end);
	}

	private filteredRows(): DashboardRow[] {
		const rows = flattenDashboardAgents(
			this.snapshot.agents,
			this.snapshot.rootSessionId,
		);
		const query = this.filter.trim().toLowerCase();
		if (!query) return rows;
		return rows.filter(({ agent }) =>
			[
				agent.id,
				agent.label,
				agent.state,
				agent.model,
				agent.thinkingLevel,
				agent.context,
			]
				.join(" ")
				.toLowerCase()
				.includes(query),
		);
	}

	private visibleRows(rows: DashboardRow[], maxRows: number): DashboardRow[] {
		const selectedIndex = Math.max(
			0,
			rows.findIndex((row) => row.agent.id === this.selectedId),
		);
		const windowSize = Math.min(maxRows, rows.length);
		let start = Math.max(0, selectedIndex - Math.floor(windowSize / 2));
		start = Math.min(start, Math.max(0, rows.length - windowSize));
		return rows.slice(start, start + windowSize);
	}

	private moveSelection(delta: number): void {
		const rows = this.filteredRows();
		if (rows.length === 0) return;
		const current = Math.max(
			0,
			rows.findIndex((row) => row.agent.id === this.selectedId),
		);
		const selected = rows[Math.max(0, Math.min(rows.length - 1, current + delta))];
		if (!selected) return;
		this.selectedId = selected.agent.id;
		this.transcriptOffset = 0;
		this.onSelectionChange(this.selectedId);
		this.invalidateAndRender();
	}

	private clampSelection(reset = false): void {
		const rows = this.filteredRows();
		if (rows.length === 0) {
			this.selectedId = undefined;
			return;
		}
		if (reset || !rows.some((row) => row.agent.id === this.selectedId))
			this.selectedId = rows[0]?.agent.id;
	}

	private invalidateAndRender(): void {
		this.invalidate();
		this.requestRender();
	}
}
