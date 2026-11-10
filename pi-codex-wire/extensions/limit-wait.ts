import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { when } from "../../pi-watch/common.ts";
import { START_WATCH, watchList, type WatchRequest } from "../../pi-watch/tool.ts";
import { currentUsageSource, savedUsageWindows } from "./usage.ts";

/**
 * A turn refused because a usage limit was reached ends in an error, and Pi leaves the conversation waiting for the
 * user. Here it waits for the limit to reset instead: a time watch wakes it then, and a hidden note tells the agent why,
 * so it carries on with what it was doing.
 */

/** A provider's usage window: the share used, when it resets, whether it refused requests, and the model it is for. */
export type LimitWindow = { label: string; used?: number; resetAt?: number; rejected?: boolean; model?: string };
/** When a refused turn can carry on, and the limit that refused it. */
export type LimitWait = { at: number; limit: string };

/** Session entries recording the watch that carries the conversation on: { watch, at, waits } or { done: true }. */
export const LIMIT_ENTRY = "pi-codex-wire/limit-wait";
/** The hidden note telling the agent its turn was refused and when it will be woken. */
export const LIMIT_NOTE = "pi-codex-wire/limit-note";
/** Waits in a row that met a limit again, after which the conversation waits for the user. */
export const MAX_WAITS = 8;
/** A window this full when the limit was met is taken as the one that refused it. */
const NEARLY_USED = 0.9;
/** After a reset, so that the provider has applied it. */
const MARGIN_MS = 60_000;
/** A rate limit that names no reset is tried again after this long. */
const UNKNOWN_WAIT_MS = 15 * 60_000;

/**
 * Claude subscription windows from a response's anthropic-ratelimit-unified-<window>-{utilization,reset,status}
 * headers: 5h, 7d, and windows for some models only, such as 7d_oi on Fable models' responses, which are recorded with
 * that model.
 */
export function claudeWindows(headers: Record<string, unknown>, model?: string): LimitWindow[] {
	const windows = new Map<string, LimitWindow>();
	for (const [name, raw] of Object.entries(headers)) {
		const match = /^anthropic-ratelimit-unified-(.+)-(utilization|reset|status)$/.exec(name.toLowerCase());
		// Overage is paid usage beyond the plan, not a window that resets.
		if (!match || match[1] === "overage") continue;
		const window = windows.get(match[1]!) ?? { label: match[1]! }, value = String(raw).trim(), number = Number(value);
		if (match[2] === "utilization" && Number.isFinite(number)) window.used = number;
		// Epoch seconds, though milliseconds have been seen too.
		else if (match[2] === "reset" && number > 0) window.resetAt = number >= 1e12 ? number : number * 1000;
		else if (match[2] === "status") window.rejected = value === "rejected";
		windows.set(match[1]!, window);
	}
	return [...windows.values()].filter(window => window.resetAt !== undefined)
		.map(window => window.label.includes("_") && model ? { ...window, model } : window);
}

function windowName(window: LimitWindow, modelName: string | undefined): string {
	if (window.label === "5h") return "the 5-hour usage limit";
	if (window.label === "7d") return "the weekly usage limit";
	if (window.model) return `the weekly allowance for ${modelName ?? window.model}`;
	return `the ${window.label} usage limit`;
}

/** When a turn that ended with this error can carry on; undefined when the error is not a usage or rate limit. */
export function limitWait(error: string, windows: readonly LimitWindow[], model?: { id: string; name?: string }, now = Date.now()): LimitWait | undefined {
	// "You have hit your ChatGPT usage limit (pro plan). Try again in ~195 min."
	const minutes = /usage limit\b[\s\S]*?try again in ~?\s*(\d+)\s*min/i.exec(error);
	if (minutes) return { at: now + Number(minutes[1]) * 60_000 + MARGIN_MS, limit: /ChatGPT/i.test(error) ? "the ChatGPT usage limit" : "the usage limit" };
	// "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."
	const regain = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) UTC/i.exec(error);
	if (regain) return { at: Math.max(Date.parse(`${regain[1]}T${regain[2]}:00Z`), now) + MARGIN_MS, limit: "the API usage limit" };
	// Pi's retry, when a provider asks for a longer wait than it makes.
	const requested = /Server requested (\d+)s retry delay/.exec(error);
	if (requested) return { at: now + Number(requested[1]) * 1000 + MARGIN_MS, limit: "the rate limit" };
	if (!/\b429\b|rate.?limit|usage.?limit/i.test(error)) return undefined;
	// A refusal's headers don't reach extensions, so the windows are the last ones reported. The soonest reset of one that
	// refused, or else of one nearly used up, is tried first; if another window refused, the turn meets it then and waits again.
	const open = windows.filter(window => window.resetAt! > now && (!window.model || window.model === model?.id));
	const refused = open.filter(window => window.rejected), full = refused.length ? refused : open.filter(window => (window.used ?? 0) >= NEARLY_USED);
	const due = full.sort((a, b) => a.resetAt! - b.resetAt!)[0];
	return due ? { at: due.resetAt! + MARGIN_MS, limit: windowName(due, model?.name) } : { at: now + UNKNOWN_WAIT_MS, limit: "the rate limit" };
}

type Reply = { role?: string; stopReason?: string; errorMessage?: string };
type Pending = { watch: string; at: number; waits: number };

export default function limitWaits(pi: ExtensionAPI): void {
	let own: LimitWindow[] = [], error: string | undefined, pending: Pending | undefined, waits = 0;
	const active = (ctx: ExtensionContext) => !!pending && !!watchList(ctx.sessionManager.getSessionId())?.some(item => item.startsWith(`${pending!.watch}:`));
	const watch = (ctx: ExtensionContext, params: WatchRequest["params"], label?: string) => {
		const request: WatchRequest = { params, ctx, label };
		pi.events.emit(START_WATCH, request);
		return request.result ?? Promise.reject(new Error("pi-watch is not loaded."));
	};

	pi.on("session_start", (_event, ctx) => {
		own = []; pending = undefined; waits = 0;
		const entry = [...ctx.sessionManager.getBranch()].reverse().find(item => item.type === "custom" && item.customType === LIMIT_ENTRY);
		const data = entry?.type === "custom" ? entry.data as Partial<Pending> & { done?: boolean } : undefined;
		if (data && !data.done && typeof data.watch === "string" && typeof data.at === "number") {
			pending = { watch: data.watch, at: data.at, waits: data.waits ?? 1 };
			waits = pending.waits;
		}
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (event.status < 200 || event.status >= 300 || ctx.model?.provider !== "anthropic") return;
		const windows = claudeWindows(event.headers, ctx.model.id);
		if (windows.length) own = windows;
	});
	pi.on("agent_end", (event, ctx) => {
		const reply = [...event.messages as Reply[]].reverse().find(message => message.role === "assistant");
		error = reply?.stopReason === "error" ? reply.errorMessage ?? "" : undefined;
		if (!reply || reply.stopReason === "error" || reply.stopReason === "aborted") return;
		// A reply went through: the limit has reset, and a watch still waiting for it has nothing to do.
		waits = 0;
		if (!pending) return;
		if (active(ctx)) watch(ctx, { stop: pending.watch }).catch(() => undefined);
		pending = undefined;
		pi.appendEntry(LIMIT_ENTRY, { done: true });
	});
	pi.on("agent_settled", async (event, ctx) => {
		const message = error, model = ctx.model;
		error = undefined;
		if (message === undefined || event.aborted || !model) return;
		const source = currentUsageSource(model, model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model));
		const saved = source ? savedUsageWindows(source).map(window => ({ label: window.label, used: window.usedPercent === undefined ? undefined : window.usedPercent / 100, resetAt: window.resetAtMs })) : [];
		const wait = limitWait(message, [...own, ...saved.filter(window => !own.some(item => item.label === window.label))], model);
		// A message sent while the conversation waits meets the limit too; the watch already waiting wakes it.
		if (!wait || active(ctx)) return;
		if (waits >= MAX_WAITS) {
			ctx.ui.notify(`This conversation met ${wait.limit} ${MAX_WAITS} times in a row after waiting for it, so it waits for you now.`, "warning");
			return;
		}
		const limit = `${wait.limit.charAt(0).toUpperCase()}${wait.limit.slice(1)}`;
		try {
			const { id } = await watch(ctx, { until: new Date(wait.at).toISOString() }, `Carry on once ${wait.limit} resets`);
			if (!id) throw new Error("the watch started without an ID");
			pending = { watch: id, at: wait.at, waits: ++waits };
			pi.appendEntry(LIMIT_ENTRY, pending);
			pi.sendMessage({ customType: LIMIT_NOTE, display: false, content: `Your last request was refused because ${wait.limit} was reached. `
				+ `Watch ${id} wakes you at ${when(wait.at)}, after it resets; then carry on with what you were doing.` }, { triggerTurn: false });
			ctx.ui.notify(`${limit} was reached. This conversation carries on by itself at ${when(wait.at)}.`, "info");
		} catch (failure) {
			ctx.ui.notify(`${limit} was reached, and waiting for it to reset failed: ${failure instanceof Error ? failure.message : String(failure)}`, "warning");
		}
	});
}
