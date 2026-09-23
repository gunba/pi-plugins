import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export const TOOL_TIMING_ENTRY = "pi-message-timestamps/tool-timing";
const STATUS_KEY = "message-timestamps/activity";
const RENDER_PATCH = Symbol.for("pi-message-timestamps.tool-render.v1");
const TIMING_DETAIL = "piMessageTimestamps";
const MAX_TIMES = 2048;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface ToolTiming {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	finishedAt?: number;
	isError?: boolean;
	durationKnown?: boolean;
	display?: string;
	shortDisplay?: string;
}

interface ToolView {
	toolCallId: string;
	render(width: number): string[];
}

interface RenderPatch {
	original: (this: ToolView, width: number) => string[];
	wrapped: (this: ToolView, width: number) => string[];
}

interface Clock {
	now(): number;
	setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
	clearInterval(timer: ReturnType<typeof setInterval>): void;
}

const systemClock: Clock = {
	now: Date.now,
	setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
	clearInterval: (timer) => clearInterval(timer),
};

async function loadToolComponent(): Promise<{ ToolExecutionComponent?: { prototype: ToolView } }> {
	const entry = process.argv[1];
	if (!entry || !/[/\\]bundle[/\\]cli\.js$/.test(entry)) throw new Error("Bundled Pi CLI unavailable");
	return import(pathToFileURL(join(dirname(entry), "index.js")).href);
}

export function formatTimestamp(timestamp: number, now: number): string {
	const date = new Date(timestamp);
	const today = new Date(now);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	if (date.getFullYear() === today.getFullYear()
		&& date.getMonth() === today.getMonth()
		&& date.getDate() === today.getDate()) return time;
	return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

export function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function timingLabel(tool: ToolTiming, now: number): string {
	if (tool.durationKnown === false) return formatTimestamp(tool.finishedAt ?? tool.startedAt, now);
	const duration = (tool.finishedAt ?? now) - tool.startedAt;
	const elapsed = tool.finishedAt !== undefined && duration < 1000 ? "<1s" : formatElapsed(duration);
	return `${formatTimestamp(tool.startedAt, now)} · ${elapsed}${tool.finishedAt === undefined ? "…" : ""}`;
}

/** Replace unused right padding on the tool title, without adding a transcript row. */
export function embedToolTiming(lines: string[], width: number, label: string, shortLabel = label): string[] {
	const index = lines.findIndex((line) => stripTerminalSequences(line).trim() !== "");
	if (index < 0) return lines;
	const line = lines[index];
	const padding = /( +)((?:\x1b\[[0-9;]*m)*)$/.exec(line);
	for (const candidate of [label, shortLabel]) {
		if (padding && padding[1].length >= candidate.length + 3) {
			const before = line.slice(0, padding.index);
			const result = lines.slice();
			result[index] = `${before}${" ".repeat(padding[1].length - candidate.length - 1)}\x1b[2m${candidate}\x1b[22m ${padding[2]}`;
			return result;
		}
		if (!padding && visibleWidth(line) + candidate.length + 2 <= width) {
			const result = lines.slice();
			result[index] = `${line}  \x1b[2m${candidate}\x1b[22m`;
			return result;
		}
	}
	return lines;
}

export function installMessageTimestamps(
	pi: ExtensionAPI, clock: Clock = systemClock, loadHost = loadToolComponent,
): void {
	const times = new Map<string, ToolTiming>();
	const active = new Map<string, ToolTiming>();
	let working = false;
	let lastActivity = clock.now();
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastStatus: string | undefined;
	let unpatch: (() => void) | undefined;

	const remember = (tool: ToolTiming): void => {
		times.delete(tool.toolCallId);
		times.set(tool.toolCallId, tool);
		while (times.size > MAX_TIMES) times.delete(times.keys().next().value!);
	};

	const hydrate = (ctx: ExtensionContext): void => {
		times.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				const message = entry.message;
				const stored = (message.details as Record<string, unknown> | undefined)?.[TIMING_DETAIL] as
					{ startedAt?: unknown; finishedAt?: unknown } | undefined;
				const exact = Number.isFinite(stored?.startedAt) && Number.isFinite(stored?.finishedAt);
				const finishedAt = Number.isFinite(message.timestamp) ? message.timestamp : Date.parse(entry.timestamp);
				if (Number.isFinite(finishedAt)) remember({
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					startedAt: exact ? stored!.startedAt as number : finishedAt,
					finishedAt: exact ? stored!.finishedAt as number : finishedAt,
					isError: message.isError,
					durationKnown: exact,
				});
			}
			if (entry.type !== "custom" || entry.customType !== TOOL_TIMING_ENTRY) continue;
			const tools = (entry.data as { tools?: unknown } | undefined)?.tools;
			if (!Array.isArray(tools)) continue;
			for (const value of tools) {
				const tool = value as ToolTiming;
				if (typeof tool.toolCallId === "string" && Number.isFinite(tool.startedAt)
					&& Number.isFinite(tool.finishedAt)) remember(tool);
			}
		}
	};

	const setStatus = (ctx: ExtensionContext, value: string | undefined): void => {
		if (value === lastStatus) return;
		lastStatus = value;
		ctx.ui.setStatus(STATUS_KEY, value);
	};

	const refresh = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui" || !working) return;
		const now = clock.now();
		const oldest = [...active.values()].reduce<ToolTiming | undefined>(
			(previous, tool) => !previous || tool.startedAt < previous.startedAt ? tool : previous, undefined,
		);
		if (oldest) {
			const label = active.size === 1 ? oldest.toolName : `${active.size} tools`;
			const quiet = now - lastActivity >= 10_000 ? ` · quiet ${formatElapsed(now - lastActivity)}` : "";
			setStatus(ctx, `${label} · ${formatTimestamp(oldest.startedAt, now)} · ${formatElapsed(now - oldest.startedAt)} running${quiet}`);
		} else {
			setStatus(ctx, `working · ${formatElapsed(now - lastActivity)} since activity`);
		}
	};

	const stopTimer = (): void => {
		if (timer !== undefined) clock.clearInterval(timer);
		timer = undefined;
	};

	const installRenderPatch = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const host = await loadHost();
			const proto = host.ToolExecutionComponent?.prototype;
			if (!proto || typeof proto.render !== "function") throw new Error("Tool renderer unavailable");
			const patched = proto as ToolView & Record<symbol, RenderPatch | undefined>;
			const old = patched[RENDER_PATCH];
			if (old && proto.render === old.wrapped) proto.render = old.original;
			const original = proto.render;
			const wrapped = function(this: ToolView, width: number): string[] {
				const lines = original.call(this, width);
				const tool = times.get(this.toolCallId);
				if (!tool || lines.length === 0) return lines;
				const label = tool.finishedAt === undefined
					? timingLabel(tool, clock.now())
					: (tool.display ??= timingLabel(tool, clock.now()));
				const short = tool.shortDisplay ??= formatTimestamp(tool.startedAt, clock.now()).split(" ").at(-1)!;
				return embedToolTiming(lines, width, label, short);
			};
			patched[RENDER_PATCH] = { original, wrapped };
			proto.render = wrapped;
			unpatch = () => {
				if (proto.render === wrapped) proto.render = original;
				if (patched[RENDER_PATCH]?.wrapped === wrapped) delete patched[RENDER_PATCH];
			};
		} catch {
			ctx.ui.notify("Pi's tool renderer could not be decorated; the live activity clock remains available.", "warning");
		}
	};

	// Older versions stored a separate timing entry. Keep its data for the
	// existing tool block, but do not render the redundant transcript row.
	pi.registerEntryRenderer(TOOL_TIMING_ENTRY, () => undefined);

	pi.on("session_start", async (_event, ctx) => {
		stopTimer();
		unpatch?.();
		unpatch = undefined;
		times.clear();
		active.clear();
		working = false;
		lastStatus = undefined;
		if (ctx.mode !== "tui") return;
		hydrate(ctx);
		await installRenderPatch(ctx);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopTimer();
		active.clear();
		working = false;
		hydrate(ctx);
		setStatus(ctx, undefined);
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		working = true;
		lastActivity = clock.now();
		stopTimer();
		timer = clock.setInterval(() => refresh(ctx), 5000);
		timer.unref?.();
		refresh(ctx);
	});
	pi.on("message_start", (_event, ctx) => {
		if (ctx.mode === "tui") lastActivity = clock.now();
	});
	pi.on("message_update", (_event, ctx) => {
		if (ctx.mode === "tui") lastActivity = clock.now();
	});
	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "toolResult") return;
		const tool = times.get(event.message.toolCallId);
		if (!tool || tool.finishedAt === undefined) return;
		const metadata = { startedAt: tool.startedAt, finishedAt: tool.finishedAt };
		const details = event.message.details;
		if (details === undefined) event.message.details = { [TIMING_DETAIL]: metadata };
		else if (details && typeof details === "object" && !Array.isArray(details)
			&& Object.getPrototypeOf(details) === Object.prototype && Object.isExtensible(details)) {
			(details as Record<string, unknown>)[TIMING_DETAIL] = metadata;
		}
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const startedAt = clock.now();
		const tool = { toolCallId: event.toolCallId, toolName: event.toolName, startedAt };
		active.set(event.toolCallId, tool);
		remember(tool);
		lastActivity = startedAt;
		refresh(ctx);
	});
	pi.on("tool_execution_update", (_event, ctx) => {
		if (ctx.mode === "tui") lastActivity = clock.now();
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const finishedAt = clock.now();
		const tool = active.get(event.toolCallId) ?? {
			toolCallId: event.toolCallId, toolName: event.toolName, startedAt: finishedAt,
		};
		remember({ ...tool, finishedAt, isError: event.isError });
		active.delete(event.toolCallId);
		lastActivity = finishedAt;
		refresh(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		for (const tool of active.values()) remember({ ...tool, finishedAt: clock.now(), isError: true });
		active.clear();
		working = false;
		stopTimer();
		setStatus(ctx, undefined);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		unpatch?.();
		unpatch = undefined;
		active.clear();
		times.clear();
		working = false;
		if (ctx.mode === "tui") setStatus(ctx, undefined);
	});
}

export default installMessageTimestamps;
