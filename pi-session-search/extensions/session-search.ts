import { spawn } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionInfo,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

const EXTENSION_NAME = "pi-session-search";
const CACHE_TTL_MS = 30_000;
const MAX_SNIPPETS = 3;

type Scope = "all" | "current";

type IndexedSession = SessionInfo & {
	title: string;
	titleLower: string;
	cwdLower: string;
	pathLower: string;
	haystack: string;
	haystackLower: string;
};

type QueryToken = {
	value: string;
	quoted: boolean;
};

type ParsedQuery = {
	raw: string;
	terms: string[];
	phrases: string[];
	regex: RegExp | null;
	filters: {
		cwd?: string;
		name?: string;
		id?: string;
		path?: string;
		after?: Date;
		before?: Date;
		days?: number;
	};
	error?: string;
};

type SearchRow = {
	session: IndexedSession;
	score: number;
	snippets: string[];
};

type ModalResult =
	| { action: "resume"; session: IndexedSession }
	| { action: "refresh"; query: string; scope: Scope }
	| { action: "agent"; query: string; scope: Scope }
	| null;

type ModalOptions = {
	sessions: IndexedSession[];
	currentCwd: string;
	currentSessionPath: string | undefined;
	initialQuery: string;
	initialScope: Scope;
	theme: Theme;
	requestRender: () => void;
	done: (result: ModalResult) => void;
};

type SessionCache = {
	loadedAt: number;
	sessions: IndexedSession[];
};

let sessionCache: SessionCache | null = null;

function safeFileSegment(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "session-hunt"
	);
}

function agentResultDir(): string {
	return join(homedir(), ".pi", "agent", "tmp", "session-search");
}

function agentResultPath(request: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(agentResultDir(), `${stamp}_${safeFileSegment(request)}.md`);
}

function tailFile(path: string, maxChars = 5_000): string {
	try {
		const text = readFileSync(path, "utf8");
		return text.length <= maxChars ? text : `…\n${text.slice(-maxChars)}`;
	} catch {
		return "";
	}
}

function buildAgentPrompt(request: string): string {
	return `Find the saved local AI session(s) matching this request: ${JSON.stringify(request)}

You are a background session-search agent. Do not modify files. Search local session stores and return evidence, not guesses.

Search priority:
1. Pi sessions under ~/.pi/agent/sessions/**/*.jsonl
2. Codex sessions under ~/.codex/sessions/**/*.jsonl and ~/.codex/history.jsonl
3. context-mode indexed memory if available

Use scripts or context-mode tools to summarize large data; do not dump huge raw files. Prefer exact matches, nearby timestamps, user prompts, assistant summaries, and output file paths.

Return a concise ranked report with:
- best matching session IDs and full paths
- cwd, timestamps, title/name/first prompt if available
- 2-4 short snippets proving the match
- exact resume/open command for each likely hit
- places searched and next search terms if no strong hit
`;
}

function startAgentSearch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	request: string,
): string {
	mkdirSync(agentResultDir(), { recursive: true });
	const outputPath = agentResultPath(request);
	const prompt = buildAgentPrompt(request);
	const command = process.env.PI_SESSION_SEARCH_AGENT_COMMAND || "pi";
	const args = ["--no-session", "-p", prompt];
	const statusKey = `${EXTENSION_NAME}:agent`;

	writeFileSync(
		outputPath,
		`# Session search agent\n\nRequest: ${request}\nStarted: ${new Date().toISOString()}\nCommand: ${command} --no-session -p <prompt>\n\n---\n\n`,
	);

	const child = spawn(command, args, {
		cwd: ctx.cwd,
		env: { ...process.env, PI_SESSION_SEARCH_AGENT: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});

	ctx.ui.setStatus(statusKey, "session search agent running");

	child.stdout.on("data", (chunk: Buffer) => appendFileSync(outputPath, chunk));
	child.stderr.on("data", (chunk: Buffer) =>
		appendFileSync(outputPath, `\n\n[stderr]\n${chunk.toString("utf8")}`),
	);
	child.on("error", (error) => {
		appendFileSync(
			outputPath,
			`\n\nAgent failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		ctx.ui.setStatus(statusKey, undefined);
		ctx.ui.notify(`Session search agent failed: ${outputPath}`, "error");
	});
	child.on("close", (code) => {
		appendFileSync(
			outputPath,
			`\n\n---\nFinished: ${new Date().toISOString()}\nExit code: ${code ?? "unknown"}\n`,
		);
		ctx.ui.setStatus(statusKey, undefined);
		const ok = code === 0;
		ctx.ui.notify(
			`Session search agent ${ok ? "finished" : "exited"}: ${outputPath}`,
			ok ? "info" : "warning",
		);
		const summary = tailFile(outputPath);
		pi.sendMessage({
			customType: EXTENSION_NAME,
			content: `Session search agent ${ok ? "finished" : "exited"}.\n\nResult: ${outputPath}\n\n${summary}`,
			display: true,
			details: { outputPath, request, exitCode: code },
		});
	});

	return outputPath;
}

function normalizeSpaces(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function lower(value: string | undefined): string {
	return (value ?? "").toLowerCase();
}

function shortPath(path: string | undefined): string {
	if (!path) return "";
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function comparablePath(path: string | undefined): string {
	if (!path) return "";
	return resolve(path);
}

function samePath(
	left: string | undefined,
	right: string | undefined,
): boolean {
	const a = comparablePath(left);
	const b = comparablePath(right);
	return Boolean(a && b && a === b);
}

function formatAge(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const mins = Math.max(0, Math.floor(diffMs / 60_000));
	const hours = Math.floor(diffMs / 3_600_000);
	const days = Math.floor(diffMs / 86_400_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 14) return `${days}d`;
	if (days < 60) return `${Math.floor(days / 7)}w`;
	if (days < 730) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function formatAbsoluteDate(date: Date): string {
	return date.toISOString().slice(0, 19).replace("T", " ");
}

function indexSession(session: SessionInfo): IndexedSession {
	const title = normalizeSpaces(
		session.name || session.firstMessage || "(no messages)",
	);
	const haystack = normalizeSpaces(
		[
			session.id,
			session.name ?? "",
			session.firstMessage,
			session.cwd,
			session.path,
			session.allMessagesText,
		].join(" "),
	);

	return {
		...session,
		title,
		titleLower: lower(title),
		cwdLower: lower(session.cwd),
		pathLower: lower(session.path),
		haystack,
		haystackLower: lower(haystack),
	};
}

async function loadIndexedSessions(
	ctx: ExtensionCommandContext,
	force: boolean,
): Promise<IndexedSession[]> {
	const now = Date.now();
	if (!force && sessionCache && now - sessionCache.loadedAt < CACHE_TTL_MS) {
		return sessionCache.sessions;
	}

	ctx.ui.setStatus(EXTENSION_NAME, "loading sessions…");
	try {
		let lastProgress = 0;
		const sessions = await SessionManager.listAll((loaded, total) => {
			const progress = Date.now();
			if (progress - lastProgress < 100) return;
			lastProgress = progress;
			ctx.ui.setStatus(EXTENSION_NAME, `loading sessions ${loaded}/${total}`);
		});
		const indexed = sessions.map(indexSession);
		sessionCache = { loadedAt: Date.now(), sessions: indexed };
		return indexed;
	} finally {
		ctx.ui.setStatus(EXTENSION_NAME, undefined);
	}
}

function tokenizeQuery(query: string): QueryToken[] {
	const tokens: QueryToken[] = [];
	let buffer = "";
	let inQuote = false;
	let quotedToken = false;

	const flush = () => {
		const value = buffer.trim();
		if (value) tokens.push({ value, quoted: quotedToken });
		buffer = "";
		quotedToken = false;
	};

	for (const char of query.trim()) {
		if (char === '"') {
			if (inQuote) {
				flush();
				inQuote = false;
			} else {
				flush();
				inQuote = true;
				quotedToken = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(char)) {
			flush();
			continue;
		}

		buffer += char;
	}

	flush();
	return tokens;
}

function parseDate(value: string): Date | undefined {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function emptyParsedQuery(query: string, error?: string): ParsedQuery {
	return {
		raw: query,
		terms: [],
		phrases: [],
		regex: null,
		filters: {},
		error,
	};
}

function applyFilterToken(
	parsed: ParsedQuery,
	key: string,
	value: string,
): boolean {
	switch (key) {
		case "cwd":
		case "repo":
			parsed.filters.cwd = lower(value);
			return true;
		case "name":
			parsed.filters.name = lower(value);
			return true;
		case "id":
			parsed.filters.id = lower(value);
			return true;
		case "path":
		case "file":
			parsed.filters.path = lower(value);
			return true;
		case "days":
		case "d": {
			const days = Number(value);
			if (Number.isFinite(days) && days >= 0) parsed.filters.days = days;
			return true;
		}
		case "after":
		case "since": {
			const date = parseDate(value);
			if (date) parsed.filters.after = date;
			return true;
		}
		case "before":
		case "until": {
			const date = parseDate(value);
			if (date) parsed.filters.before = date;
			return true;
		}
		default:
			return false;
	}
}

function parseQuery(query: string): ParsedQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return emptyParsedQuery(query);
	}

	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) return emptyParsedQuery(query, "Empty regex");
		try {
			return {
				raw: query,
				terms: [],
				phrases: [],
				regex: new RegExp(pattern, "i"),
				filters: {},
			};
		} catch (error) {
			return emptyParsedQuery(
				query,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	const parsed: ParsedQuery = {
		raw: query,
		terms: [],
		phrases: [],
		regex: null,
		filters: {},
	};

	for (const token of tokenizeQuery(trimmed)) {
		const filterMatch = token.value.match(/^([a-zA-Z]+):(.*)$/);
		if (filterMatch && !token.quoted) {
			const [, rawKey = "", rawValue = ""] = filterMatch;
			const key = rawKey.toLowerCase();
			const value = rawValue.trim();
			if (value && applyFilterToken(parsed, key, value)) {
				continue;
			}
		}

		if (token.quoted) {
			parsed.phrases.push(lower(token.value));
		} else {
			parsed.terms.push(lower(token.value));
		}
	}

	return parsed;
}

function filterMatches(session: IndexedSession, parsed: ParsedQuery): boolean {
	const filters = parsed.filters;
	if (filters.cwd && !session.cwdLower.includes(filters.cwd)) return false;
	if (filters.name && !lower(session.name).includes(filters.name)) return false;
	if (filters.id && !lower(session.id).includes(filters.id)) return false;
	if (filters.path && !session.pathLower.includes(filters.path)) return false;
	if (filters.after && session.modified.getTime() < filters.after.getTime())
		return false;
	if (filters.before && session.modified.getTime() > filters.before.getTime())
		return false;
	if (typeof filters.days === "number") {
		const cutoff = Date.now() - filters.days * 86_400_000;
		if (session.modified.getTime() < cutoff) return false;
	}
	return true;
}

function scoreLiteralMatch(
	session: IndexedSession,
	needles: string[],
): number | null {
	let score = 0;

	for (const needle of needles) {
		if (!needle) continue;
		const index = session.haystackLower.indexOf(needle);
		if (index < 0) return null;

		score += Math.min(index, 50_000) / 100;
		if (session.titleLower.includes(needle)) score -= 80;
		if (lower(session.name).includes(needle)) score -= 120;
		if (session.cwdLower.includes(needle)) score -= 20;
		if (lower(session.firstMessage).includes(needle)) score -= 10;
	}

	score -=
		Math.min(Date.now() - session.modified.getTime(), 90 * 86_400_000) /
		86_400_000;
	return score;
}

function makeSnippet(text: string, index: number, matchLength: number): string {
	const radius = 130;
	const start = Math.max(0, index - radius);
	const end = Math.min(text.length, index + matchLength + radius);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return normalizeSpaces(`${prefix}${text.slice(start, end)}${suffix}`);
}

function uniquePush(values: string[], value: string): void {
	if (!value || values.includes(value)) return;
	values.push(value);
}

function snippetsFor(session: IndexedSession, parsed: ParsedQuery): string[] {
	const source = session.haystack || session.firstMessage || session.title;
	const lowerSource = lower(source);
	const snippets: string[] = [];

	if (parsed.regex) {
		const match = parsed.regex.exec(source);
		if (match?.index !== undefined) {
			uniquePush(
				snippets,
				makeSnippet(source, match.index, match[0]?.length ?? 1),
			);
		}
	}

	for (const needle of [...parsed.phrases, ...parsed.terms]) {
		if (snippets.length >= MAX_SNIPPETS) break;
		const index = lowerSource.indexOf(needle);
		if (index >= 0)
			uniquePush(snippets, makeSnippet(source, index, needle.length));
	}

	if (snippets.length === 0) {
		uniquePush(
			snippets,
			truncateToWidth(
				normalizeSpaces(session.firstMessage || session.title),
				220,
				"…",
			),
		);
	}

	return snippets.slice(0, MAX_SNIPPETS);
}

function searchSessions(
	sessions: IndexedSession[],
	query: string,
): { rows: SearchRow[]; error?: string } {
	const parsed = parseQuery(query);
	if (parsed.error) return { rows: [], error: parsed.error };

	const needles = [...parsed.phrases, ...parsed.terms];
	const hasSearch = needles.length > 0 || parsed.regex;
	const rows: SearchRow[] = [];

	for (const session of sessions) {
		if (!filterMatches(session, parsed)) continue;

		if (parsed.regex) {
			const match = session.haystack.match(parsed.regex);
			if (!match) continue;
			rows.push({
				session,
				score: match.index ?? 0,
				snippets: snippetsFor(session, parsed),
			});
			continue;
		}

		if (!hasSearch) {
			rows.push({ session, score: 0, snippets: snippetsFor(session, parsed) });
			continue;
		}

		const score = scoreLiteralMatch(session, needles);
		if (score === null) continue;
		rows.push({ session, score, snippets: snippetsFor(session, parsed) });
	}

	if (hasSearch) {
		rows.sort(
			(a, b) =>
				a.score - b.score ||
				b.session.modified.getTime() - a.session.modified.getTime(),
		);
	} else {
		rows.sort(
			(a, b) => b.session.modified.getTime() - a.session.modified.getTime(),
		);
	}

	return { rows };
}

function fitLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "…");
}

function padToWidth(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return truncateToWidth(text, width, "");
	return `${text}${" ".repeat(width - visible)}`;
}

function borderLine(
	width: number,
	parts: { left: string; fill: string; right: string; label?: string },
	color: (value: string) => string,
): string {
	const innerWidth = Math.max(
		0,
		width - visibleWidth(parts.left) - visibleWidth(parts.right),
	);
	const { fill, label, left, right } = parts;
	if (!label) return color(`${left}${fill.repeat(innerWidth)}${right}`);
	const text = ` ${label} `;
	const textWidth = visibleWidth(text);
	if (textWidth >= innerWidth)
		return color(`${left}${truncateToWidth(text, innerWidth, "")}${right}`);
	const before = Math.floor((innerWidth - textWidth) / 2);
	const after = innerWidth - textWidth - before;
	return color(
		`${left}${fill.repeat(before)}${text}${fill.repeat(after)}${right}`,
	);
}

class SessionSearchModal implements Component, Focusable {
	private scope: Scope;
	private query: string;
	private selectedIndex = 0;
	private showPaths = false;
	private cachedKey = "";
	private cachedRows: SearchRow[] = [];
	private cachedError: string | undefined;
	private _focused = false;

	private readonly allSessions: IndexedSession[];
	private readonly currentCwd: string;
	private readonly currentSessionPath: string | undefined;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: (result: ModalResult) => void;

	constructor(options: ModalOptions) {
		this.allSessions = options.sessions;
		this.currentCwd = options.currentCwd;
		this.currentSessionPath = options.currentSessionPath;
		this.theme = options.theme;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.scope = options.initialScope;
		this.query = options.initialQuery;
		this.clampSelection(true);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {
		this.cachedKey = "";
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			const row = this.rows()[this.selectedIndex];
			if (row) this.done({ action: "resume", session: row.session });
			return;
		}
		if (matchesKey(data, Key.ctrl("r"))) {
			this.done({ action: "refresh", query: this.query, scope: this.scope });
			return;
		}
		if (matchesKey(data, Key.ctrl("a"))) {
			this.done({ action: "agent", query: this.query, scope: this.scope });
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.scope = this.scope === "all" ? "current" : "all";
			this.clampSelection(true);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("p"))) {
			this.showPaths = !this.showPaths;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
			this.selectedIndex = Math.min(
				this.rows().length - 1,
				this.selectedIndex + 1,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.selectedIndex = Math.max(
				0,
				this.selectedIndex - this.maxVisibleRows(),
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.selectedIndex = Math.min(
				this.rows().length - 1,
				this.selectedIndex + this.maxVisibleRows(),
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			this.query = [...this.query].slice(0, -1).join("");
			this.clampSelection(true);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.query = "";
			this.clampSelection(true);
			this.requestRender();
			return;
		}

		const printable =
			decodeKittyPrintable(data) ??
			(/^[^\x00-\x1f\x7f]$/.test(data) ? data : undefined);
		if (printable) {
			this.query += printable;
			this.clampSelection(true);
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const color = (value: string) => this.theme.fg("accent", value);
		const lines: string[] = [];
		lines.push(
			borderLine(
				width,
				{ left: "╭", fill: "─", right: "╮", label: " Session Search " },
				color,
			),
		);
		lines.push(...this.headerLines(width));
		lines.push(borderLine(width, { left: "├", fill: "─", right: "┤" }, color));

		if (width >= 112) {
			this.renderSplit(lines, width, color);
		} else {
			this.renderStacked(lines, width, color);
		}

		lines.push(borderLine(width, { left: "╰", fill: "─", right: "╯" }, color));
		return lines.map((line) => fitLine(line, width));
	}

	private headerLines(width: number): string[] {
		const scopeText = this.scope === "all" ? "All sessions" : "Current cwd";
		const currentCount = this.currentSessions().length;
		const totalCount = this.allSessions.length;
		const rowCount = this.rows().length;
		const pathState = this.showPaths ? "on" : "off";
		const queryText = this.query
			? this.theme.fg("text", this.query)
			: this.theme.fg(
					"dim",
					'type exact terms, "phrases", re:<regex>, days:14, cwd:repo',
				);
		const cursor = this._focused ? this.theme.fg("accent", "▌") : "";
		const summary = `${this.theme.fg("muted", "Scope:")} ${this.theme.fg("accent", scopeText)} ${this.theme.fg("dim", `(${currentCount}/${totalCount})`)}  ${this.theme.fg("muted", "Matches:")} ${this.theme.fg("accent", String(rowCount))}`;
		const search = `${this.theme.fg("muted", "Search:")} ${queryText}${cursor}`;
		const hints = [
			"enter resume",
			"tab scope",
			"ctrl+r refresh",
			"ctrl+a agent",
			`ctrl+p path ${pathState}`,
			"ctrl+u clear",
			"esc close",
		].join(" · ");

		return [
			fitLine(`│ ${summary}`, width - 1) + this.theme.fg("accent", "│"),
			fitLine(`│ ${search}`, width - 1) + this.theme.fg("accent", "│"),
			fitLine(`│ ${this.theme.fg("dim", hints)}`, width - 1) +
				this.theme.fg("accent", "│"),
		];
	}

	private renderSplit(
		lines: string[],
		width: number,
		color: (value: string) => string,
	): void {
		const innerWidth = Math.max(20, width - 4);
		const leftWidth = Math.floor(innerWidth * 0.56);
		const rightWidth = innerWidth - leftWidth - 1;
		const resultLines = this.resultLines(leftWidth);
		const previewLines = this.previewLines(rightWidth);
		const height = Math.max(resultLines.length, previewLines.length);
		const separator = color("│");

		for (let i = 0; i < height; i++) {
			const left = padToWidth(resultLines[i] ?? "", leftWidth);
			const right = padToWidth(previewLines[i] ?? "", rightWidth);
			lines.push(`${color("│")} ${left}${separator}${right} ${color("│")}`);
		}
	}

	private renderStacked(
		lines: string[],
		width: number,
		color: (value: string) => string,
	): void {
		const innerWidth = Math.max(20, width - 4);
		for (const line of this.resultLines(innerWidth)) {
			lines.push(`${color("│")} ${padToWidth(line, innerWidth)} ${color("│")}`);
		}
		lines.push(
			`${color("│")} ${padToWidth(this.theme.fg("dim", "Preview"), innerWidth)} ${color("│")}`,
		);
		for (const line of this.previewLines(innerWidth)) {
			lines.push(`${color("│")} ${padToWidth(line, innerWidth)} ${color("│")}`);
		}
	}

	private resultLines(width: number): string[] {
		const rows = this.rows();
		if (this.cachedError)
			return [this.theme.fg("error", `Invalid search: ${this.cachedError}`)];
		if (rows.length === 0) {
			return [
				this.theme.fg(
					"muted",
					"No sessions matched. Search is literal AND, not fuzzy.",
				),
			];
		}

		const lines: string[] = [];
		const maxRows = this.maxVisibleRows();
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxRows / 2),
				rows.length - maxRows,
			),
		);
		const end = Math.min(rows.length, start + maxRows);

		for (let i = start; i < end; i++) {
			const row = rows[i];
			if (row)
				lines.push(this.renderResultRow(row, i === this.selectedIndex, width));
		}

		if (start > 0 || end < rows.length) {
			lines.push(
				this.theme.fg(
					"dim",
					fitLine(`  (${this.selectedIndex + 1}/${rows.length})`, width),
				),
			);
		}

		return lines;
	}

	private renderResultRow(
		row: SearchRow,
		selected: boolean,
		width: number,
	): string {
		const session = row.session;
		const marker = selected ? this.theme.fg("accent", "› ") : "  ";
		const current = samePath(session.path, this.currentSessionPath);
		let titleColor: "accent" | "warning" | "text" = "text";
		if (current) titleColor = "accent";
		else if (session.name) titleColor = "warning";
		const title = this.theme.fg(
			titleColor,
			truncateToWidth(
				session.title,
				Math.max(10, Math.floor(width * 0.66)),
				"…",
			),
		);
		const cwd = this.scope === "all" ? ` ${shortPath(session.cwd)}` : "";
		const path = this.showPaths ? ` ${shortPath(session.path)}` : "";
		const right = this.theme.fg(
			"dim",
			`${session.messageCount} ${formatAge(session.modified)}${cwd}${path}`,
		);
		const rightWidth = visibleWidth(right);
		const leftMax = Math.max(8, width - rightWidth - 1);
		const left = truncateToWidth(`${marker}${title}`, leftMax, "…");
		const line = `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth))}${right}`;
		return selected
			? this.theme.bg("selectedBg", padToWidth(line, width))
			: fitLine(line, width);
	}

	private previewLines(width: number): string[] {
		const row = this.rows()[this.selectedIndex];
		if (!row) return [this.theme.fg("muted", "No selected session")];

		const session = row.session;
		const lines: string[] = [];
		const current = samePath(session.path, this.currentSessionPath);
		lines.push(
			this.theme.fg(
				current ? "accent" : "warning",
				truncateToWidth(session.title, width, "…"),
			),
		);
		lines.push(this.theme.fg("dim", `id: ${session.id}`));
		lines.push(
			this.theme.fg(
				"dim",
				`modified: ${formatAbsoluteDate(session.modified)} (${formatAge(session.modified)})`,
			),
		);
		lines.push(this.theme.fg("dim", `messages: ${session.messageCount}`));
		if (session.cwd)
			lines.push(this.theme.fg("dim", `cwd: ${shortPath(session.cwd)}`));
		lines.push(this.theme.fg("dim", `path: ${shortPath(session.path)}`));
		lines.push("");
		lines.push(this.theme.fg("accent", "Snippets"));
		for (const snippet of row.snippets) {
			lines.push(...this.wrapBullet(snippet, width));
		}
		return lines.map((line) => fitLine(line, width));
	}

	private wrapBullet(text: string, width: number): string[] {
		const words = text.split(/\s+/).filter(Boolean);
		const lines: string[] = [];
		let line = "•";
		for (const word of words) {
			const next = `${line} ${word}`;
			if (visibleWidth(next) > width && line !== "•") {
				lines.push(this.theme.fg("text", line));
				line = `  ${word}`;
			} else {
				line = next;
			}
		}
		if (line.trim()) lines.push(this.theme.fg("text", line));
		return lines;
	}

	private rows(): SearchRow[] {
		const key = `${this.scope}\0${this.query}`;
		if (key === this.cachedKey) return this.cachedRows;

		const pool =
			this.scope === "all" ? this.allSessions : this.currentSessions();
		const { rows, error } = searchSessions(pool, this.query);
		this.cachedKey = key;
		this.cachedRows = rows;
		this.cachedError = error;
		this.selectedIndex = Math.min(
			Math.max(0, this.selectedIndex),
			Math.max(0, rows.length - 1),
		);
		return rows;
	}

	private currentSessions(): IndexedSession[] {
		const current = comparablePath(this.currentCwd);
		return this.allSessions.filter(
			(session) => comparablePath(session.cwd) === current,
		);
	}

	private maxVisibleRows(): number {
		return 14;
	}

	private clampSelection(reset: boolean): void {
		this.cachedKey = "";
		if (reset) this.selectedIndex = 0;
		this.rows();
	}
}

async function chooseSession(
	ctx: ExtensionCommandContext,
	sessions: IndexedSession[],
	initialQuery: string,
	initialScope: Scope,
): Promise<ModalResult> {
	return ctx.ui.custom<ModalResult>(
		(tui, theme, _keybindings, done) =>
			new SessionSearchModal({
				sessions,
				currentCwd: ctx.cwd,
				currentSessionPath: ctx.sessionManager.getSessionFile(),
				initialQuery,
				initialScope,
				theme,
				requestRender: () => tui.requestRender(),
				done,
			}),
		{
			overlay: true,
			overlayOptions: {
				width: "96%",
				minWidth: 80,
				maxHeight: "94%",
				anchor: "top-center",
				margin: 1,
			},
		},
	);
}

async function runSessionSearch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	let query = args.trim();
	let scope: Scope = "all";
	let force = false;

	const agentPrefix = query.match(/^(?:--agent|agent)\s+(.+)$/s);
	if (agentPrefix) {
		const request = agentPrefix[1]?.trim();
		if (request) {
			const outputPath = startAgentSearch(pi, ctx, request);
			ctx.ui.notify(`Session search agent started: ${outputPath}`, "info");
		}
		return;
	}

	for (;;) {
		const sessions = await loadIndexedSessions(ctx, force);
		force = false;
		const result = await chooseSession(ctx, sessions, query, scope);
		if (!result) return;

		if (result.action === "refresh") {
			query = result.query;
			scope = result.scope;
			force = true;
			continue;
		}

		if (result.action === "agent") {
			query = result.query;
			scope = result.scope;
			const request = await ctx.ui.input(
				"Send session-search agent",
				query || "Describe the session you want to find",
			);
			const trimmed = request?.trim();
			if (trimmed) {
				const outputPath = startAgentSearch(pi, ctx, trimmed);
				ctx.ui.notify(`Session search agent started: ${outputPath}`, "info");
			}
			continue;
		}

		const label =
			result.session.name || result.session.firstMessage || result.session.id;
		await ctx.switchSession(result.session.path, {
			withSession: async (nextCtx) => {
				nextCtx.ui.notify(`Resumed ${truncateToWidth(label, 80, "…")}`, "info");
			},
		});
		return;
	}
}

export default function sessionSearch(pi: ExtensionAPI) {
	pi.registerCommand("session-search", {
		description:
			"Open exact, cached session search with snippets and resume from a modal",
		handler: async (args, ctx) => {
			try {
				await runSessionSearch(pi, ctx, args);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`${EXTENSION_NAME}: ${message}`, "error");
			}
		},
	});
}
