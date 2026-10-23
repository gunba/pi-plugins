/**
 * The efficiency report: where a computer's agents spend, read incrementally from its native session files.
 * Each file is parsed once and then only what was appended, so the report stays cheap to refresh.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

/** Per-turn misses at or below this are cache breakpoint granularity, as in Pi core's cache-stats. */
const NOISE = 1024;
/** Why a request missed the cache: lifetime passed, model or thinking changed, system prompt or tools changed (tool
 * loading, extension or Desk updates), an extension edited context, no declared lifetime (Codex) after a long idle so
 * the cause is unknown, or nothing that explains it. */
export type Cause = "expiry" | "switch" | "prompt" | "contextEdit" | "unknown" | "unexplained";
export interface DayStats {
	steps: number; cost: number; costs: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** First model request after a user message, and how many of them missed a cache that should have been warm. */
	firstRequests: number; firstMisses: number;
	breaks: Record<Cause, { count: number; tokens: number; cost: number }>;
	compactions: { count: number; input: number; cacheRead: number; cost: number };
	cacheWarm: { count: number; cost: number };
	codexInTurn: number; codexLosses: number; codexLossCost: number;
	polls: number; tools: Record<string, { calls: number; errors: number }>;
}
export interface ErrorStat { tool: string; count: number; first: number; last: number; example: string }
interface Previous { prompt: number; model: string; at: number; cached: boolean }
export interface FileState {
	size: number; offset: number; carry: string;
	previous?: Previous; flags: { switch: boolean; prompt: boolean; contextEdit: boolean }; afterUser: boolean;
	/** Tool calls awaiting their result: name and whether it was a poll. */
	calls: Record<string, [string, boolean]>;
	days: Record<string, DayStats>; errors: Record<string, ErrorStat>;
}
export const emptyFile = (): FileState => ({ size: 0, offset: 0, carry: "", flags: { switch: false, prompt: false, contextEdit: false }, afterUser: false, calls: {}, days: {}, errors: {} });
const emptyDay = (): DayStats => ({ steps: 0, cost: 0, costs: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, firstRequests: 0, firstMisses: 0,
	breaks: { expiry: { count: 0, tokens: 0, cost: 0 }, switch: { count: 0, tokens: 0, cost: 0 }, prompt: { count: 0, tokens: 0, cost: 0 }, contextEdit: { count: 0, tokens: 0, cost: 0 }, unknown: { count: 0, tokens: 0, cost: 0 }, unexplained: { count: 0, tokens: 0, cost: 0 } },
	compactions: { count: 0, input: 0, cacheRead: 0, cost: 0 }, cacheWarm: { count: 0, cost: 0 }, codexInTurn: 0, codexLosses: 0, codexLossCost: 0, polls: 0, tools: {} });
const dayOf = (ms: number) => { const date = new Date(ms); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };

const ERROR_LINE = /(error|exception|not found|no such file|permission denied|failed|cannot|could not|unable to|fatal|not installed|unknown option|unrecognized|invalid)/i;
const GENERIC = /^(traceback|script failed|command exited|exit code|process exited|error:?$|<n>$)/i;
/** An error's first specific line with paths, quoted text, hashes and numbers replaced, so repeats match. */
export function errorSignature(text: string): string | undefined {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length <= 10 || !ERROR_LINE.test(trimmed) || GENERIC.test(trimmed)) continue;
		return trimmed.toLowerCase().replace(/(\/[\w.\-@~+()]+)+\/?/g, "<p>").replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<s>")
			.replace(/0x[0-9a-f]+|[0-9a-f]{8,}/g, "<h>").replace(/\d+/g, "<n>").slice(0, 120);
	}
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
const text = (content: unknown) => Array.isArray(content) ? content.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : typeof content === "string" ? content : "";

/** Fold one session entry into a file's state. `ttlMs` is the catalog cache lifetime for a provider/model, if it declares one. */
export function addEntry(state: FileState, entry: Record<string, any>, ttlMs: (model: string) => number | undefined): void {
	const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Date.now();
	const day = (ms: number) => state.days[dayOf(ms)] ??= emptyDay();
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		// A new context, not a miss; its own request is measured as compaction.
		state.previous = undefined; state.flags = { switch: false, prompt: false, contextEdit: false };
		if (entry.type === "compaction" && entry.usage) {
			const usage = entry.usage as Usage, stats = day(at).compactions;
			stats.count++; stats.input += usage.input + usage.cacheRead; stats.cacheRead += usage.cacheRead; stats.cost += usage.cost?.total ?? 0;
			addCost(day(at), usage);
		}
		return;
	}
	if (entry.type === "model_change" || entry.type === "thinking_level_change") { state.flags.switch = true; return; }
	if (entry.type === "context_edit") { state.flags.contextEdit = true; return; }
	if (entry.type === "usage" && entry.kind === "cache_warm" && entry.usage) {
		const usage = entry.usage as Usage, stats = day(at);
		stats.cacheWarm.count++; stats.cacheWarm.cost += usage.cost?.total ?? 0; addCost(stats, usage);
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		if (prompt > 0) state.previous = { prompt, model: `${entry.provider}/${entry.model}`, at, cached: true };
		return;
	}
	if (entry.type !== "message" || !entry.message) return;
	const message = entry.message, when = typeof message.timestamp === "number" ? message.timestamp : at;
	if (message.role === "user") { state.afterUser = true; return; }
	if (message.role === "system") { state.flags.prompt = true; return; }
	if (message.role === "toolResult") {
		const call = state.calls[message.toolCallId], name = message.toolName ?? call?.[0] ?? "tool", stats = day(when);
		delete state.calls[message.toolCallId];
		const tool = stats.tools[name] ??= { calls: 0, errors: 0 };
		tool.calls++;
		if (call?.[1]) stats.polls++;
		const body = text(message.content);
		if (message.isError) {
			tool.errors++;
			const signature = errorSignature(body);
			if (signature) {
				const error = state.errors[`${name}\0${signature}`] ??= { tool: name, count: 0, first: when, last: when, example: body.split("\n").find(line => line.trim())?.slice(0, 200) ?? "" };
				error.count++; error.last = Math.max(error.last, when); error.first = Math.min(error.first, when);
			}
		}
		return;
	}
	if (message.role !== "assistant") return;
	for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "toolCall" && typeof part.id === "string") {
		const args = part.arguments ?? {}, name = String(part.name ?? "tool");
		const poll = name === "write_stdin" && !args.chars || name === "wait_agent" || name === "wait_for_work"
			|| (name === "bash" || name === "exec_command") && /^\s*sleep\s+\d/.test(String(args.command ?? args.cmd ?? ""));
		state.calls[part.id] = [name, poll];
	}
	const usage = message.usage as Usage | undefined;
	if (!usage) return;
	const stats = day(when), prompt = usage.input + usage.cacheRead + usage.cacheWrite, model = `${message.provider}/${message.model}`;
	stats.steps++; addCost(stats, usage);
	const first = state.afterUser; state.afterUser = false;
	if (first) stats.firstRequests++;
	const previous = state.previous, codexInTurn = !first && message.provider === "openai-codex" && previous?.model === model && when - previous.at < 60_000;
	if (codexInTurn) stats.codexInTurn++;
	if (previous && prompt > 0 && (usage.cacheRead + usage.cacheWrite > 0 || previous.cached)) {
		const expected = Math.min(previous.prompt, prompt), missed = expected - usage.cacheRead;
		if (missed > NOISE) {
			const paid = usage.input + usage.cacheWrite, cost = usage.cost;
			const paidPer = paid > 0 && cost ? (cost.input + cost.cacheWrite) / paid : 0, readPer = usage.cacheRead > 0 && cost ? cost.cacheRead / usage.cacheRead : 0;
			const lost = missed * Math.max(0, paidPer - readPer), ttl = ttlMs(model);
			const idle = when - previous.at;
			const cause: Cause = previous.model !== model || state.flags.switch ? "switch" : ttl !== undefined && idle > ttl ? "expiry"
				: state.flags.prompt ? "prompt" : state.flags.contextEdit ? "contextEdit" : ttl === undefined && idle > 300_000 ? "unknown" : "unexplained";
			const bucket = stats.breaks[cause];
			bucket.count++; bucket.tokens += missed; bucket.cost += lost;
			if (first && (cause === "contextEdit" || cause === "unexplained")) stats.firstMisses++;
			// Codex in-turn requests that lost nearly the whole cache: nothing in the conversation changed.
			if (codexInTurn && usage.cacheRead < expected * 0.2 && expected > 50_000) { stats.codexLosses++; stats.codexLossCost += lost; }
		}
	}
	if (prompt > 0) state.previous = { prompt, model, at: when, cached: (previous?.cached ?? false) || usage.cacheRead + usage.cacheWrite > 0 };
	state.flags = { switch: false, prompt: false, contextEdit: false };
}
function addCost(stats: DayStats, usage: Usage) {
	const cost = usage.cost;
	if (!cost) return;
	stats.cost += cost.total; stats.costs.input += cost.input; stats.costs.output += cost.output; stats.costs.cacheRead += cost.cacheRead; stats.costs.cacheWrite += cost.cacheWrite;
}

/** Parse newly appended text. A trailing partial line waits for the rest. */
export function addText(state: FileState, chunk: string, ttlMs: (model: string) => number | undefined): void {
	const lines = (state.carry + chunk).split("\n");
	state.carry = lines.pop() ?? "";
	for (const line of lines) {
		if (!line) continue;
		let entry: Record<string, any>;
		try { entry = JSON.parse(line); } catch { continue; }
		addEntry(state, entry, ttlMs);
	}
	// Calls whose results never arrived would otherwise accumulate.
	const pending = Object.keys(state.calls);
	if (pending.length > 500) for (const id of pending.slice(0, pending.length - 200)) delete state.calls[id];
}

export interface Period {
	from: string; to: string; steps: number; cost: number; costs: DayStats["costs"];
	firstRequests: number; firstMisses: number; breaks: DayStats["breaks"]; compactions: DayStats["compactions"]; cacheWarm: DayStats["cacheWarm"];
	codexInTurn: number; codexLosses: number; codexLossCost: number; polls: number;
	tools: { name: string; calls: number; errors: number }[];
}
export interface EfficiencyReport {
	generated: number; files: number; week: Period; previousWeek: Period;
	/** Error signatures seen in more than one session, most frequent in the last 30 days first. */
	recurringErrors: (ErrorStat & { signature: string; sessions: number; recent: number })[];
}
function period(states: readonly FileState[], from: string, to: string): Period {
	const total = emptyDay();
	for (const state of states) for (const [day, stats] of Object.entries(state.days)) {
		if (day < from || day > to) continue;
		total.steps += stats.steps; total.cost += stats.cost;
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) total.costs[key] += stats.costs[key];
		total.firstRequests += stats.firstRequests; total.firstMisses += stats.firstMisses;
		for (const cause of Object.keys(total.breaks) as Cause[]) for (const key of ["count", "tokens", "cost"] as const) total.breaks[cause][key] += stats.breaks[cause][key];
		for (const key of ["count", "input", "cacheRead", "cost"] as const) total.compactions[key] += stats.compactions[key];
		total.cacheWarm.count += stats.cacheWarm.count; total.cacheWarm.cost += stats.cacheWarm.cost;
		total.codexInTurn += stats.codexInTurn; total.codexLosses += stats.codexLosses; total.codexLossCost += stats.codexLossCost; total.polls += stats.polls;
		for (const [name, tool] of Object.entries(stats.tools)) { const sum = total.tools[name] ??= { calls: 0, errors: 0 }; sum.calls += tool.calls; sum.errors += tool.errors; }
	}
	return { ...total, from, to, tools: Object.entries(total.tools).map(([name, tool]) => ({ name, ...tool })).sort((a, b) => b.errors - a.errors || b.calls - a.calls) };
}
export function buildReport(states: readonly FileState[], now = Date.now()): EfficiencyReport {
	const day = (offset: number) => dayOf(now - offset * 86_400_000);
	const signatures = new Map<string, ErrorStat & { signature: string; sessions: number; recent: number }>(), month = now - 30 * 86_400_000;
	for (const state of states) for (const [key, error] of Object.entries(state.errors)) {
		const known = signatures.get(key);
		const recent = error.last >= month ? error.count : 0;
		if (!known) signatures.set(key, { ...error, signature: key.slice(key.indexOf("\0") + 1), sessions: 1, recent });
		else {
			known.count += error.count; known.sessions++; known.recent += recent;
			known.first = Math.min(known.first, error.first);
			if (error.last > known.last) { known.last = error.last; known.example = error.example; }
		}
	}
	return { generated: now, files: states.length, week: period(states, day(6), day(0)), previousWeek: period(states, day(13), day(7)),
		recurringErrors: [...signatures.values()].filter(error => error.sessions > 1 && error.recent > 0).sort((a, b) => b.recent - a.recent).slice(0, 25) };
}

/** The host's latest report, rebuilt in a worker thread (efficiency-worker.ts) when it is older than ten minutes and someone asks. */
export class EfficiencyReports {
	private latest?: { report: unknown; at: number };
	private running?: Promise<void>;
	private readonly options: { agentDir: string; sessionDir?: string; directory: () => string; closing: () => boolean };
	constructor(options: EfficiencyReports["options"]) { this.options = options; }

	read(): { report: unknown; refreshing: boolean } {
		if (!this.latest || Date.now() - this.latest.at > 600_000) this.refresh();
		return { report: this.latest?.report ?? null, refreshing: !!this.running };
	}

	private refresh(): void {
		if (this.running || this.options.closing()) return;
		const built = new URL("./efficiency-worker.js", import.meta.url);
		const directories = [join(this.options.agentDir, "sessions"), ...(this.options.sessionDir ? [this.options.sessionDir] : [])];
		const worker = new Worker(existsSync(built) ? built : new URL("./efficiency-worker.ts", import.meta.url), {
			workerData: { directories, cachePath: join(this.options.directory(), "efficiency.json") }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
		this.running = new Promise(resolve => {
			worker.once("message", report => { this.latest = { report, at: Date.now() }; });
			worker.once("error", error => console.error(`The efficiency report could not be built: ${error instanceof Error ? error.message : String(error)}`));
			worker.once("exit", () => { this.running = undefined; resolve(); });
		});
	}
}
