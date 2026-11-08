import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { interval, MAX_COMMANDS, MAX_TIMES, parseTime, when, type Shell, type WatchSpec } from "./common.ts";

/** What the watch tool takes and says, for both owners of watches: this process (index.ts) and Desk (desk.ts). */

/** Session entries recording each watch: its start, what it last reported, and its end. Watches are rebuilt from them. */
export const WATCH_ENTRY = "pi-watch/v1";
/** The message that wakes the agent. */
export const WATCH_MESSAGE = "pi-watch/event";
/** Emitted on the extension event bus with `{ sessionId, count }` whenever a conversation's watches change. */
export const WATCH_CHANGED = "pi-watch/changed";

/** Undelivered wakes wait this long between attempts while the agent is busy or the host holds the conversation. */
export const RETRY_MS = 2_000;

export type WatchRecord =
	| { op: "start"; watch: WatchSpec }
	| { op: "seen"; id: string; offset: number }
	/** A change watch's runner started again, after the computer restarted. */
	| { op: "runner"; id: string; pid: number }
	| { op: "end"; id: string; reason: string }
	/** A watch Desk runs (desk.ts), so the conversation keeps its name taken; computer: the one whose Desk keeps it. */
	| { op: "desk"; id: string; watch: string; computer?: string }
	/** The agent was told that Desk ended that watch without telling it, as when its conversation moved (desk.ts). */
	| { op: "gone"; id: string; watch: string };

const registryKey = Symbol.for("gunba.pi-watch.v1");
const registry = ((globalThis as Record<symbol, unknown>)[registryKey] ??= new Map<string, number>()) as Map<string, number>;
const listKey = Symbol.for("gunba.pi-watch.list.v1");
const lists = ((globalThis as Record<symbol, unknown>)[listKey] ??= new Map<string, string[]>()) as Map<string, string[]>;
/** Watches active in a conversation. pi-plan holds automatic plan rounds while there are any. */
export const activeWatches = (sessionId: string): number => registry.get(sessionId) ?? 0;
/** A conversation's active watches as its agent reads them ("w3: \`make\`"), once pi-watch runs in its process. */
export const watchList = (sessionId: string): readonly string[] | undefined => lists.get(sessionId);
/** Records what a conversation's watches are, for activeWatches and watchList, and tells pi-plan. */
export function announceWatches(pi: ExtensionAPI, sessionId: string, items: string[] | undefined): void {
	if (items?.length) { registry.set(sessionId, items.length); lists.set(sessionId, items); }
	else { registry.delete(sessionId); if (items) lists.set(sessionId, []); else lists.delete(sessionId); }
	try { pi.events.emit(WATCH_CHANGED, { sessionId, count: items?.length ?? 0 }); } catch { /* the session is gone */ }
}

export const Parameters = Type.Object({
	command: Type.Optional(Type.String({ description: "Shell command; with every, re-run." })),
	program: Type.Optional(Type.String({ description: "A program, as for codemode, re-run every every seconds instead of a command; it can call any operation." })),
	every: Type.Optional(Type.Integer({ minimum: 1, description: "Seconds between runs. Wakes you on a change, then ends, unless keep." })),
	keep: Type.Optional(Type.Boolean({ description: "With every: keep watching after a result wakes you, waking you for each later one, until stopped or hours end." })),
	until: Type.Optional(Type.String({ description: "Wake after a delay (90s, 5m, 2h), at HH:MM (local) or at an ISO time." })),
	wake_when: Type.Optional(Type.String({ description: "Wake only for output showing this, in plain words." })),
	hours: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	computer: Type.Optional(Type.String({ description: "Run the command or program on another of Jordan's computers, by name or ID as agent_list shows." })),
	cwd: Type.Optional(Type.String({ description: "With computer: the folder to run it in there (default: its home folder)." })),
	stop: Type.Optional(Type.String({ description: "Watch ID to stop." })),
	close: Type.Optional(Type.Boolean({ description: "Close this conversation until a watch wakes it." })),
}, { additionalProperties: false });
export type Params = Static<typeof Parameters>;

/** What a conversation's watch tool and bash need from whoever runs its watches: this process or Desk. */
export interface WatchBackend {
	readonly sessionId: string;
	readonly bashFolder: string;
	restore(): void;
	close(shutdown?: boolean): void;
	call(input: Params, ctx: ExtensionContext, label?: string): Promise<string>;
	useContext(ctx: ExtensionToolContext): void;
	keepOpen(): void;
	shell(): Shell;
	/** Starts a bash call's command under a runner, in `folder`. */
	launch(spec: WatchSpec, folder: string, env?: NodeJS.ProcessEnv): ChildProcess;
	/** A bash command that outlived its call's wait goes on as a watch; its name is set. */
	adopt(spec: WatchSpec): WatchSpec;
	/** Stops a bash call's command before it became a watch. */
	stopRun(spec: WatchSpec): void;
}

/**
 * Checks what a call asks for and returns the watch it describes, or a reason to refuse it. stop and listing are the
 * callers'. `counts` are the agent's time and command watches already active.
 */
export function plannedWatch(params: Omit<Params, "close" | "stop">, ctx: ExtensionContext, label: string | undefined, counts: { times: number; commands: number },
	list: () => string, now = Date.now()): WatchSpec {
	const given = Object.entries(params).filter(([, value]) => value !== undefined).map(([key]) => key);
	if ([params.command, params.program, params.until].filter(value => value !== undefined).length > 1)
		throw new Error("Give one of command, program or until; hours sets how long a command or program watch lasts.");
	if (params.program !== undefined && params.every === undefined) throw new Error("A program watch needs every: the seconds between its runs.");
	if (params.program !== undefined && !params.program.trim()) throw new Error("program is empty.");
	if (params.until !== undefined && params.computer !== undefined)
		throw new Error("until wakes you from this computer: leave computer out. On another computer, a watch runs a command or program.");
	if (params.until !== undefined && given.length > 1) throw new Error("until wakes you after a delay or at a time (5m, HH:MM or an ISO time) and takes nothing else; to check something repeatedly, give command with every. Either way, end your turn and you are woken.");
	if (params.keep !== undefined && params.every === undefined) throw new Error("keep goes with every: it keeps a re-run command or program reporting after it first wakes you.");
	if (params.cwd !== undefined && params.computer === undefined) throw new Error("cwd names the folder on another computer; give computer too. Here, watches run in this conversation's folder.");
	const command = params.command?.trim(), wakeWhen = params.wake_when?.trim() || undefined;
	if (params.command !== undefined && !command) throw new Error("command is empty.");
	if (params.until !== undefined ? counts.times >= MAX_TIMES : counts.commands >= MAX_COMMANDS)
		throw new Error(`At most ${params.until !== undefined ? `${MAX_TIMES} time` : `${MAX_COMMANDS} command`} watches can run at once. ${list()}`);
	const at = params.until !== undefined ? parseTime(params.until, now) : undefined;
	return {
		id: "", mode: at !== undefined ? "time" : params.every !== undefined ? "change" : "output",
		...(command ? { command } : {}), ...(params.program !== undefined ? { program: params.program } : {}),
		...(params.every !== undefined ? { every: params.every } : {}), ...(at !== undefined ? { at } : {}),
		...(wakeWhen ? { wakeWhen } : {}), ...(params.keep ? { keep: true } : {}),
		cwd: ctx.cwd, created: now, ...(at !== undefined ? { expires: at } : params.hours !== undefined ? { expires: now + params.hours * 3_600_000 } : {}),
		computer: hostname(), ...(label ? { label } : {}),
	};
}

/** What the agent is told when a watch starts. */
export function startedText(spec: WatchSpec, where?: string): string {
	const ending = spec.expires && spec.mode !== "time" ? ` It ends ${when(spec.expires)}.` : "", on = where ? ` on ${where}` : "";
	const then = spec.keep ? "; it keeps watching, and wakes you for each later one, until stopped" : "; the watch then ends";
	const text = spec.mode === "time" ? `Watching as ${spec.id}: you'll be woken at ${when(spec.at!)}.`
		: spec.program !== undefined ? `Watching as ${spec.id}${on}, running the program every ${interval(spec.every!)}: you'll be woken when ${spec.wakeWhen ? "a run's result shows that" : "its result changes"}${then}.${ending}`
		: spec.mode === "change" ? `Watching as ${spec.id}${on}, every ${interval(spec.every!)}: you'll be woken when ${spec.wakeWhen ? "a run's output shows that" : "its output changes"}${then}.${ending}`
		: `Watching as ${spec.id}${on}: you'll be woken ${spec.wakeWhen ? "when its output shows that" : "with its new output"}, and when it ends.${ending}${spec.log ? ` Output: ${spec.log}` : ""}`;
	return `${text} End your turn now unless you have other work.`;
}

