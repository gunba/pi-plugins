import { resolve } from "node:path";
import { cacheExpired } from "../../pi-context-window/prompt-cache.ts";

/**
 * Tool results a later result made useless, replaced by a short stub in the provider request only. New ones are
 * chosen only at free moments (a known-expired cache, compaction, or a model or thinking switch), when the request
 * pays for its whole prompt anyway; they are recorded in the session so every later request sends the same stubs
 * and keeps its cache. Rewinding past a record drops it with the branch.
 */
export const SUPERSEDED = "superseded-results";

type Call = { type: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Message = { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
type Entry = { type: string; customType?: string; data?: unknown; message?: { role?: string; provider?: string; model?: string } };
type Model = { provider: string; id: string; promptCache?: { short?: number; long?: number } };
type Seen = { id: string; name: string; args: Record<string, unknown>; error: boolean };

const SEARCHES = new Set(["grep", "find", "ls", "glob", "web_search", "web_fetch", "view_image"]);
const COMMANDS = new Set(["bash", "exec_command"]);
const READS = new Set(["read"]);
const WRITES = new Set(["write"]);

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
	? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const short = (value: string) => value.length > 120 ? `${value.slice(0, 117)}…` : value;

/** Earlier call IDs a later result supersedes, with the later call that replaced each. */
export function supersededCalls(messages: readonly Message[], cwd: string): Map<string, { by: Seen; earlier: Seen }> {
	const calls = new Map<string, Seen>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content as Call[]) {
			if (part?.type === "toolCall" && part.id && part.name) calls.set(part.id, { id: part.id, name: part.name.toLowerCase(), args: part.arguments ?? {}, error: false });
		}
		if (message.role === "toolResult" && message.toolCallId && calls.has(message.toolCallId)) {
			calls.get(message.toolCallId)!.error = !!message.isError; results.add(message.toolCallId);
		}
	}
	const done = [...calls.values()].filter(call => results.has(call.id));
	const path = (call: Seen) => text(call.args.path) && resolve(cwd, text(call.args.path)!);
	const command = (call: Seen) => text(call.args.command ?? call.args.cmd) && `${text(call.args.command ?? call.args.cmd)}\0${resolve(cwd, text(call.args.workdir ?? call.args.cwd) ?? ".")}`;
	const replaces = (later: Seen, earlier: Seen): boolean => {
		if (later.error) return false;
		if (later.name === earlier.name && canonical(later.args) === canonical(earlier.args)
			&& (earlier.error || SEARCHES.has(later.name) || READS.has(later.name))) return true;
		if (COMMANDS.has(later.name) && COMMANDS.has(earlier.name)) return !!command(later) && command(later) === command(earlier);
		if (!READS.has(earlier.name) || !path(earlier) || path(earlier) !== path(later)) return false;
		if (WRITES.has(later.name)) return true;
		if (!READS.has(later.name) || (earlier.args.full && !later.args.full)) return false;
		// A whole-file read replaces any earlier range; otherwise only the same range.
		return (later.args.offset === undefined && later.args.limit === undefined)
			|| (later.args.offset === earlier.args.offset && later.args.limit === earlier.args.limit);
	};
	const found = new Map<string, { by: Seen; earlier: Seen }>();
	for (let index = done.length - 1; index > 0; index--) {
		const later = done[index]!;
		for (const earlier of done.slice(0, index)) if (!found.has(earlier.id) && replaces(later, earlier)) found.set(earlier.id, { by: later, earlier });
	}
	return found;
}

export function stubText({ by, earlier }: { by: Seen; earlier: Seen }): string {
	const subject = command(earlier) ? `\`${short(text(earlier.args.command ?? earlier.args.cmd)!)}\``
		: text(earlier.args.path) ? `${earlier.name} of ${short(text(earlier.args.path)!)}` : `this ${earlier.name} call`;
	const why = earlier.error && by.name === earlier.name ? "a later identical call succeeded" : WRITES.has(by.name) ? "the file was rewritten later"
		: COMMANDS.has(by.name) ? "the same command ran again later" : "a later call returned the newer result";
	return `[Result removed: ${subject} is superseded; ${why} (call ${by.id.split("|")[0]}).]`;
	function command(call: Seen) { return COMMANDS.has(call.name) && text(call.args.command ?? call.args.cmd); }
}

/** A request pays for its whole prompt: the cache is known to have expired, or it follows compaction or a model or thinking switch. */
export function freeMoment(model: Model | undefined, branch: readonly Entry[]): boolean {
	if (cacheExpired(model, branch as never)) return true;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		// A different model has no cache for this conversation.
		if (entry.type === "message" && entry.message?.role === "assistant") return !!model && (entry.message.provider !== model.provider || entry.message.model !== model.id);
		if (entry.type === "compaction" || entry.type === "model_change" || entry.type === "thinking_level_change") return true;
	}
	return false;
}

/** Stubs recorded on this branch, plus any new ones at a free moment; undefined when the request is unchanged. */
export function withoutSuperseded<T extends Message>(messages: T[], branch: readonly Entry[], model: Model | undefined, cwd: string,
	record: (stubs: Record<string, string>) => void): T[] | undefined {
	const stubs: Record<string, string> = {};
	for (const entry of branch) if (entry.type === "custom" && entry.customType === SUPERSEDED) Object.assign(stubs, (entry.data as { stubs?: Record<string, string> })?.stubs);
	if (freeMoment(model, branch)) {
		const fresh: Record<string, string> = {};
		for (const [id, found] of supersededCalls(messages, cwd)) if (!stubs[id]) fresh[id] = stubText(found);
		if (Object.keys(fresh).length) { record(fresh); Object.assign(stubs, fresh); }
	}
	let changed = false;
	const next = messages.map(message => {
		const stub = message.role === "toolResult" && message.toolCallId ? stubs[message.toolCallId] : undefined;
		if (!stub) return message;
		changed = true;
		return { ...message, content: [{ type: "text", text: stub }] };
	});
	return changed ? next : undefined;
}
