import type { ExtensionAPI, ExtensionContext, MessageEndEventResult } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "message-timestamps/activity";
const TIMING_DETAIL = "piMessageTimestamps";
const MAX_TIMES = 2048;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface ToolTiming {
	toolCallId: string;
	toolName: string;
	startedAt: number;
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

export function installMessageTimestamps(pi: ExtensionAPI, clock: Clock = systemClock): void {
	const active = new Map<string, ToolTiming>();
	const finished = new Map<string, ToolTiming & { finishedAt: number }>();
	let working = false;
	let lastActivity = clock.now();
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastStatus: string | undefined;

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
		} else setStatus(ctx, `working · ${formatElapsed(now - lastActivity)} since activity`);
	};
	const stopTimer = (): void => {
		if (timer !== undefined) clock.clearInterval(timer);
		timer = undefined;
	};
	const reset = (ctx: ExtensionContext): void => {
		stopTimer();
		active.clear(); finished.clear(); working = false;
		if (ctx.mode === "tui") setStatus(ctx, undefined);
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));
	pi.on("agent_start", (_event, ctx) => {
		working = true;
		lastActivity = clock.now();
		if (ctx.mode !== "tui") return;
		stopTimer();
		timer = clock.setInterval(() => refresh(ctx), 5000);
		timer.unref?.();
		refresh(ctx);
	});
	pi.on("message_start", () => { lastActivity = clock.now(); });
	pi.on("message_update", () => { lastActivity = clock.now(); });
	pi.on("tool_execution_update", () => { lastActivity = clock.now(); });
	pi.on("tool_execution_start", (event, ctx) => {
		const startedAt = clock.now();
		active.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName, startedAt });
		lastActivity = startedAt;
		refresh(ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const tool = active.get(event.toolCallId);
		// A result without its start event has a timestamp, not a known duration.
		if (tool) {
			finished.set(event.toolCallId, { ...tool, finishedAt: clock.now() });
			while (finished.size > MAX_TIMES) finished.delete(finished.keys().next().value!);
		}
		active.delete(event.toolCallId);
		lastActivity = clock.now();
		refresh(ctx);
	});
	pi.on("message_end", (event): MessageEndEventResult | void => {
		if (event.message.role !== "toolResult") return;
		const tool = finished.get(event.message.toolCallId);
		if (!tool) return;
		finished.delete(event.message.toolCallId);
		const details = event.message.details;
		if (details !== undefined && (!details || typeof details !== "object" || Array.isArray(details)
			|| Object.getPrototypeOf(details) !== Object.prototype)) return;
		return { message: { ...event.message, details: {
			...details, [TIMING_DETAIL]: { startedAt: tool.startedAt, finishedAt: tool.finishedAt },
		} } };
	});
	// agent_end can precede automatic retries and queued work.
	pi.on("agent_settled", (_event, ctx) => reset(ctx));
}

export default installMessageTimestamps;
