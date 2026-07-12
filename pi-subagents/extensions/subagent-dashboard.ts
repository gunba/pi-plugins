import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";

export type DashboardAgent = {
	name: string;
	taskId: string;
	parent: string | null;
	taskName: string;
	state: string;
	activity?: string;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	responses?: number;
	inputTokens?: number;
	outputTokens?: number;
	contextTokens?: number;
	cost?: number;
	model?: string;
	thinking?: string;
	lastAssistantText?: string;
	generation?: number;
	resultFile?: string;
};

export type DashboardSnapshot = {
	agents: DashboardAgent[];
	feed: string[];
	transcript: string[];
	transcriptError?: string;
};

export type DashboardAction = {
	action: "message" | "kill";
	name: string;
};

type AgentRow = { agent: DashboardAgent; depth: number };

const GLYPH: Record<string, string> = {
	queued: "○",
	spawning: "◌",
	running: "●",
	waiting: "◐",
	completed: "✓",
	error: "✗",
	interrupted: "■",
	hard_killed: "×",
};
const STATE_COLOR: Record<string, ThemeColor> = {
	queued: "dim",
	spawning: "dim",
	running: "accent",
	waiting: "warning",
	completed: "success",
	error: "error",
	interrupted: "warning",
	hard_killed: "dim",
};

export function taskPathLabel(taskPath: string): string {
	if (taskPath === "/root") return taskPath;
	const separator = taskPath.lastIndexOf("/");
	return separator >= 0 ? taskPath.slice(separator + 1) || taskPath : taskPath;
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

function fmtAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function fmtTokens(value = 0): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function flattenDashboardAgents(agents: DashboardAgent[]): AgentRow[] {
	const byParent = new Map<string, DashboardAgent[]>();
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	for (const agent of agents) {
		if (agent.name === "/root") continue;
		const parent =
			agent.parent && byName.has(agent.parent) ? agent.parent : "/root";
		const siblings = byParent.get(parent) ?? [];
		siblings.push(agent);
		byParent.set(parent, siblings);
	}
	for (const siblings of byParent.values())
		siblings.sort(
			(a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name),
		);

	const rows: AgentRow[] = [];
	const seen = new Set<string>();
	const walk = (parent: string, depth: number): void => {
		for (const agent of byParent.get(parent) ?? []) {
			if (seen.has(agent.name)) continue;
			seen.add(agent.name);
			rows.push({ agent, depth });
			walk(agent.name, depth + 1);
		}
	};
	walk("/root", 0);
	for (const agent of agents) {
		if (agent.name !== "/root" && !seen.has(agent.name))
			rows.push({ agent, depth: 0 });
	}
	return rows;
}

export function orchestrationSummary(agents: DashboardAgent[]): string {
	const workers = agents.filter((agent) => agent.name !== "/root");
	const active = workers.filter(
		(agent) => agent.state === "running" || agent.state === "spawning",
	).length;
	const waiting = workers.filter(
		(agent) => agent.state === "waiting" || agent.state === "queued",
	).length;
	const done = workers.filter((agent) => agent.state === "completed").length;
	const stopped = workers.filter(
		(agent) => agent.state === "interrupted" || agent.state === "hard_killed",
	).length;
	const attention = workers.filter((agent) => agent.state === "error").length;
	const parts = [`${active} active`];
	if (waiting) parts.push(`${waiting} waiting/queued`);
	if (done) parts.push(`${done} done`);
	if (stopped) parts.push(`${stopped} stopped`);
	if (attention) parts.push(`${attention} need attention`);
	return `Subagents: ${parts.join(" · ")}  —  /subagents`;
}

export class SubagentDashboard implements Component {
	private selectedName: string | undefined;
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

	constructor(
		snapshot: DashboardSnapshot,
		initialName: string | undefined,
		theme: Theme,
		requestRender: () => void,
		done: (action: DashboardAction | null) => void,
		getViewportHeight: () => number = () => 36,
	) {
		this.snapshot = snapshot;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		this.getViewportHeight = getViewportHeight;
		this.selectedName = initialName;
		this.clampSelection();
	}

	getSelectedName(): string | undefined {
		return this.selectedName;
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
		const actions: Record<string, DashboardAction["action"]> = {
			m: "message",
			x: "kill",
		};
		const action = actions[data];
		if (action && this.selectedName)
			this.done({ action, name: this.selectedName });
	}

	private handleSearchInput(data: string): void {
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
			const decoded = decodeKittyPrintable(data);
			const printable =
				decoded ?? (/^[^\x00-\x1f\x7f]$/.test(data) ? data : undefined);
			if (printable) {
				this.filter += printable;
				this.clampSelection(true);
			}
		}
		this.invalidateAndRender();
	}

	private handleNavigationInput(data: string): boolean {
		const command = this.navigationCommand(data);
		if (!command) return false;
		if (command === "close") this.done(null);
		if (command === "search") {
			this.searching = true;
			this.invalidateAndRender();
		}
		if (command === "up") this.moveSelection(-1);
		if (command === "down") this.moveSelection(1);
		if (command === "pageUp") {
			const transcriptHeight = this.transcriptVisualLines(
				this.lastTranscriptWidth,
			).length;
			this.transcriptOffset = Math.min(
				transcriptHeight,
				this.transcriptOffset + 12,
			);
			this.invalidateAndRender();
		}
		if (command === "pageDown") {
			this.transcriptOffset = Math.max(0, this.transcriptOffset - 12);
			this.invalidateAndRender();
		}
		return true;
	}

	private navigationCommand(
		data: string,
	): "close" | "search" | "up" | "down" | "pageUp" | "pageDown" | undefined {
		if (matchesKey(data, Key.escape) || data === "q") return "close";
		if (data === "/") return "search";
		if (matchesKey(data, Key.up) || data === "k") return "up";
		if (matchesKey(data, Key.down) || data === "j") return "down";
		if (matchesKey(data, Key.pageUp)) return "pageUp";
		if (matchesKey(data, Key.pageDown)) return "pageDown";
		return undefined;
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
		const selected = rows.find((row) => row.agent.name === this.selectedName);
		const lines: string[] = [
			borderLine(safeWidth, "╭", "─", "╮", color, " subagent orchestration "),
			boxedLine(
				` ${this.theme.fg("text", orchestrationSummary(this.snapshot.agents))}`,
				safeWidth,
				color,
			),
			boxedLine(
				this.searching
					? ` Search: ${this.filter || this.theme.fg("dim", "type a task path, task summary, or state")}`
					: this.theme.fg(
							"dim",
							" ↑↓/jk agents · / search · PgUp/PgDn transcript · m message · x stop · Esc close",
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
						this.filter
							? ` No matches for ${JSON.stringify(this.filter)}`
							: " No subagents in this run",
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
			? `${rows.findIndex((row) => row.agent.name === selected.agent.name) + 1}/${rows.length}`
			: `0/${rows.length}`;
		lines.push(borderLine(safeWidth, "╰", "─", "╯", color, position));
		this.cachedWidth = safeWidth;
		this.cachedHeight = safeHeight;
		this.cachedLines = lines;
		return lines;
	}

	private renderSplit(
		lines: string[],
		rows: AgentRow[],
		selected: AgentRow | undefined,
		width: number,
		height: number,
		color: (text: string) => string,
	): void {
		const inner = width - 2;
		const leftWidth = Math.max(
			38,
			Math.min(64, Math.floor(inner * 0.42), inner - 49),
		);
		const rightWidth = inner - leftWidth - 1;
		const visibleRows = this.visibleRows(rows, height);
		const detail = this.detailLines(selected, height, rightWidth);
		for (let index = 0; index < height; index++) {
			const row = visibleRows[index];
			const left = row
				? this.renderAgentRow(
						row.row,
						row.row.agent.name === this.selectedName,
						leftWidth,
					)
				: "";
			const right = detail[index] ?? "";
			lines.push(
				color("│") +
					fitLine(left, leftWidth) +
					color("│") +
					fitLine(right, rightWidth) +
					color("│"),
			);
		}
	}

	private renderStacked(
		lines: string[],
		rows: AgentRow[],
		selected: AgentRow | undefined,
		width: number,
		height: number,
		color: (text: string) => string,
	): void {
		const listHeight =
			height >= 8
				? Math.min(10, Math.max(3, Math.floor(height * 0.3)))
				: Math.max(1, height - 1);
		const visibleRows = this.visibleRows(rows, listHeight);
		for (let index = 0; index < listHeight; index++) {
			const row = visibleRows[index];
			const content = row
				? this.renderAgentRow(
						row.row,
						row.row.agent.name === this.selectedName,
						width - 2,
					)
				: "";
			lines.push(boxedLine(content, width, color));
		}
		const detailHeight = height - listHeight - 1;
		if (detailHeight < 0) return;
		lines.push(borderLine(width, "├", "─", "┤", color, " selected agent "));
		const details = this.detailLines(selected, detailHeight, width - 2);
		for (let index = 0; index < detailHeight; index++)
			lines.push(boxedLine(details[index] ?? "", width, color));
	}

	private renderAgentRow(
		row: AgentRow,
		selected: boolean,
		width: number,
	): string {
		const agent = row.agent;
		const stateColor = STATE_COLOR[agent.state] ?? "muted";
		const branch =
			row.depth === 0 ? "" : `${"  ".repeat(Math.min(row.depth, 4))}↳ `;
		const task = agent.taskName ? ` · ${agent.taskName}` : "";
		const label = taskPathLabel(agent.name);
		const text = `${selected ? "→" : " "} ${branch}${this.theme.fg(stateColor, GLYPH[agent.state] ?? "•")} ${this.theme.bold(label)}  ${this.theme.fg(stateColor, agent.state)}${task}`;
		return selected
			? this.theme.fg("accent", truncateToWidth(text, width))
			: truncateToWidth(text, width);
	}

	private detailLines(
		selected: AgentRow | undefined,
		maxRows: number,
		width: number,
	): string[] {
		if (!selected)
			return [this.theme.fg("dim", "Select an agent to inspect it")];
		const metadata = this.agentMetadata(selected.agent);
		const feed = this.feedLines();
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

	private agentMetadata(agent: DashboardAgent): string[] {
		const duration = fmtAge((agent.finishedAt ?? Date.now()) - agent.startedAt);
		const heading = this.theme.fg("accent", this.theme.bold(agent.name));
		const metadata = [
			heading,
			`${agent.state}${agent.activity ? ` · ${agent.activity}` : ""} · generation ${agent.generation ?? 1} · ${duration}`,
			this.modelLine(agent),
			this.statsLine(agent),
			agent.taskName ? `Task: ${agent.taskName}` : undefined,
			"",
			this.theme.fg("accent", "── session tail ──"),
		];
		const lines = metadata.filter(
			(line): line is string => line !== undefined && line !== "",
		);
		lines.push("");
		return lines;
	}

	private modelLine(agent: DashboardAgent): string | undefined {
		if (agent.model)
			return `Model: ${agent.model}${agent.thinking ? ` · thinking ${agent.thinking}` : ""}`;
		return agent.thinking ? `Thinking: ${agent.thinking}` : undefined;
	}

	private statsLine(agent: DashboardAgent): string | undefined {
		const parts: string[] = [];
		if (agent.responses) parts.push(`${agent.responses} responses`);
		if (agent.inputTokens || agent.outputTokens)
			parts.push(
				`↑${fmtTokens(agent.inputTokens)} ↓${fmtTokens(agent.outputTokens)}`,
			);
		if (agent.contextTokens)
			parts.push(`ctx ${fmtTokens(agent.contextTokens)}`);
		if (agent.cost) parts.push(`$${agent.cost.toFixed(4)}`);
		return parts.length ? parts.join(" · ") : undefined;
	}

	private feedLines(): string[] {
		if (!this.snapshot.feed.length) return [];
		return [
			"",
			this.theme.fg("accent", "── recent coordination ──"),
			...this.snapshot.feed.slice(-2).map((line) => this.theme.fg("dim", line)),
		];
	}

	private transcriptVisualLines(width: number): string[] {
		const safeWidth = Math.max(8, width);
		return this.snapshot.transcript.flatMap((line) =>
			line.length ? wrapTextWithAnsi(line, safeWidth) : [""],
		);
	}

	private transcriptWindow(maxRows: number, width: number): string[] {
		this.lastTranscriptWidth = width;
		const lines = this.transcriptVisualLines(width);
		const end = Math.max(0, lines.length - this.transcriptOffset);
		const start = Math.max(0, end - maxRows);
		return lines.slice(start, end);
	}

	private filteredRows(): AgentRow[] {
		const rows = flattenDashboardAgents(this.snapshot.agents);
		const query = this.filter.trim().toLowerCase();
		if (!query) return rows;
		return rows.filter(({ agent }) =>
			[
				agent.name,
				agent.taskName,
				agent.state,
				agent.activity ?? "",
				agent.model ?? "",
				agent.thinking ?? "",
			]
				.join(" ")
				.toLowerCase()
				.includes(query),
		);
	}

	private visibleRows(
		rows: AgentRow[],
		maxRows: number,
	): Array<{ row: AgentRow; index: number }> {
		const selectedIndex = Math.max(
			0,
			rows.findIndex((row) => row.agent.name === this.selectedName),
		);
		const windowSize = Math.min(maxRows, rows.length);
		let start = Math.max(0, selectedIndex - Math.floor(windowSize / 2));
		start = Math.min(start, Math.max(0, rows.length - windowSize));
		return rows
			.slice(start, start + windowSize)
			.map((row, offset) => ({ row, index: start + offset }));
	}

	private moveSelection(delta: number): void {
		const rows = this.filteredRows();
		if (rows.length === 0) return;
		const current = Math.max(
			0,
			rows.findIndex((row) => row.agent.name === this.selectedName),
		);
		const next = Math.max(0, Math.min(rows.length - 1, current + delta));
		const selected = rows[next];
		if (!selected) return;
		this.selectedName = selected.agent.name;
		this.transcriptOffset = 0;
		this.invalidateAndRender();
	}

	private clampSelection(reset = false): void {
		const rows = this.filteredRows();
		if (rows.length === 0) {
			this.selectedName = undefined;
			return;
		}
		const first = rows[0];
		if (
			(reset || !rows.some((row) => row.agent.name === this.selectedName)) &&
			first
		)
			this.selectedName = first.agent.name;
	}

	private invalidateAndRender(): void {
		this.invalidate();
		this.requestRender();
	}
}
