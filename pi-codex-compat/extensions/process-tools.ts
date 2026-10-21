import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkCoordinator } from "../../pi-work-coordination/index.ts";
import { recordRun } from "./run-times.ts";
import { promptCacheState } from "../../pi-context-window/prompt-cache.ts";
import { WARM_EVENT, type WarmProbe } from "../../pi-compaction-context/extensions/warm.ts";

/** How long an idle conversation's cache is kept for a command it left running: at most this many hours of renewals. */
const WARM_HOURS = 6;
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveToolPath } from "./paths.ts";
import {
	type ExecRuntimeOwner, type ExecRuntimeOwnerFor, createExecRuntimeOwner,
	executeManagedExecCommand, executeWriteStdin, hasBackgroundCommand, onBackgroundExit, prepareExecCommandArguments, prepareWriteStdinArguments,
	shutdownExecSessions, startExecSessionRuntime, type BackgroundExit,
} from "./shell-runtime.ts";
import { formatExecCommandCall, formatWriteStdinCall, renderExecResult } from "./tool-rendering.ts";

export const PROCESS_EXIT = "pi-codex-compat/process-exit";
const duration = (seconds: number) => seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`
	: `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m`;
export function exitNotice(exit: BackgroundExit): string {
	const outcome = exit.signal ? `was stopped by ${exit.signal}` : typeof exit.exitCode === "number" ? `exited with code ${exit.exitCode}` : "ended";
	return `Background command finished: \`${exit.cmd.length > 200 ? `${exit.cmd.slice(0, 200)}…` : exit.cmd}\` (session ${exit.id}) ${outcome} after ${duration(exit.seconds)}.`
		+ (exit.tail.trim() ? `\n\nEnd of its output:\n${exit.tail.trimEnd()}` : "\n\nIt printed nothing.");
}

export function createExecLifecycle(pi: ExtensionAPI): ExecRuntimeOwnerFor {
	let fallback: ExecRuntimeOwner | undefined;
	const owners = new Map<string, ExecRuntimeOwner>(), contexts = new Map<string, ExtensionContext>();
	const ownerFor: ExecRuntimeOwnerFor = ctx => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) return fallback ??= createExecRuntimeOwner();
		let owner = owners.get(sessionId);
		if (!owner) {
			owner = createExecRuntimeOwner();
			owners.set(sessionId, owner);
			// A command the agent left running reports itself when it finishes: at the next step boundary, ending a
			// wait_agent, or starting a turn if the agent is idle. No polling needed.
			onBackgroundExit(owner, exit => {
				const id = `process-exit:${sessionId}:${exit.id}`, context = contexts.get(sessionId);
				pi.sendMessage({ customType: PROCESS_EXIT, content: exitNotice(exit), display: true, details: { messageIds: [id], ...exit } },
					{ deliverAs: "steer", triggerTurn: context?.isIdle() ?? false });
				getWorkCoordinator(sessionId)?.notify([id]);
			});
		}
		return owner;
	};
	// While the agent waits for a command it left running, its cache is renewed before it expires (warm.ts): the
	// command's exit wakes the agent, and a wake after expiry pays for the whole context again.
	const warming = new Map<string, { since: number; warmed?: boolean; timer?: ReturnType<typeof setTimeout> }>();
	const stopWarming = (id: string) => { const run = warming.get(id); if (run?.timer) clearTimeout(run.timer); warming.delete(id); };
	const scheduleWarm = (id: string, owner: ExecRuntimeOwner, ctx: ExtensionContext) => {
		const run = warming.get(id), state = promptCacheState(ctx.model, ctx.sessionManager.getBranch() as never);
		if (!run || !state || !hasBackgroundCommand(owner)) return stopWarming(id);
		const at = state.usedAt + Math.min(state.ttlMs * 0.9, state.ttlMs - 10_000);
		// After a warm the cache's time has moved on; if it has not, warming again would only repeat (never loop).
		if (at - run.since > WARM_HOURS * 3_600_000 || run.warmed && at - Date.now() < 60_000) return stopWarming(id);
		run.timer = setTimeout(async () => {
			run.timer = undefined;
			if (warming.get(id) !== run || !ctx.isIdle() || !hasBackgroundCommand(owner)) return stopWarming(id);
			const probe: WarmProbe = { session: id };
			pi.events.emit(WARM_EVENT, probe);
			if (!await probe.result) return stopWarming(id);
			run.warmed = true;
			if (warming.get(id) === run) scheduleWarm(id, owner, ctx);
		}, Math.max(0, at - Date.now()));
		run.timer.unref?.();
	};
	pi.on("agent_settled", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId(), owner = owners.get(id);
		stopWarming(id);
		if (!owner || !hasBackgroundCommand(owner)) return;
		warming.set(id, { since: Date.now() });
		scheduleWarm(id, owner, ctx);
	});
	// A turn renews the cache itself.
	pi.on("agent_start", (_event, ctx) => stopWarming(ctx.sessionManager.getSessionId()));
	pi.on("session_shutdown", async (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		stopWarming(id);
		const owner = owners.get(id);
		contexts.delete(id);
		if (!owner) return;
		onBackgroundExit(owner, undefined);
		await shutdownExecSessions(owner);
		owners.delete(id);
	});
	// bash runs are timed too, so exec_command can say how long commands like it took in this folder.
	const started = new Map<string, { cwd: string; cmd: string; at: number }>();
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash") return;
		const { command, timeout } = event.input as { command?: unknown; timeout?: unknown };
		// bash shows the agent nothing until it ends: an agent that gave a watch loop 45 minutes saw its job fail in the
		// first minute only when the user stopped it, 29 minutes later. Longer work runs in the background, looked at as it goes.
		if (typeof timeout === "number" && timeout > FOREGROUND_SECONDS) return { block: true, reason: FOREGROUND_LIMIT };
		if (typeof command === "string") started.set(event.toolCallId, { cwd: ctx.cwd, cmd: command, at: Date.now() });
	});
	pi.on("tool_result", event => {
		const run = started.get(event.toolCallId);
		if (!run) return;
		started.delete(event.toolCallId);
		if (!event.isError) recordRun(run.cwd, run.cmd, (Date.now() - run.at) / 1000);
	});
	// A call blocked before it ran has no tool_result.
	pi.on("tool_execution_end", event => { started.delete(event.toolCallId); });
	pi.on("session_start", async (_event, ctx) => {
		contexts.set(ctx.sessionManager.getSessionId(), ctx);
		await startExecSessionRuntime(ownerFor(ctx));
	});
	return ownerFor;
}

const FOREGROUND_SECONDS = 600;
const FOREGROUND_LIMIT = `Not run: bash waits at most ${FOREGROUND_SECONDS / 60} minutes (timeout ${FOREGROUND_SECONDS}), because you see nothing until it ends. `
	+ "Run longer work in the background with exec_command (find it with tool_search \"exec_command\"): write_stdin shows its output so far, "
	+ "at most 5 minutes per look, and it reports itself when it finishes. A loop that waits for an outcome should also stop on errors.";

// Codex models are trained on these tools, so they are declared for them; other models use bash and load these with
// tool_search when a command should keep running in the background.
const PROCESSES = { exposure: "deferred" as const, namespace: { name: "processes", description: "Run a command in the background and wait on or interrupt it." } };

export function registerProcessTools(pi: ExtensionAPI, ownerFor: ExecRuntimeOwnerFor): void {
	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		...PROCESSES,
		description: "Run a shell command and return its output, or a session_id if it is still running after yield_time_ms; continue it with write_stdin. No interactive terminal.",
		promptSnippet: "Run a command, keeping it if it is still running",
		promptGuidelines: [
			"Leave yield_time_ms unset for ordinary commands; use a short wait only to do other work meanwhile.",
			"Command output is capped: save large output, such as HTTP responses, to a file and read the parts you need.",
		],
		parameters: Type.Object({
			cmd: Type.String(),
			workdir: Type.Optional(Type.String({ description: "Default: the conversation's folder." })),
			tty: Type.Optional(Type.Boolean({ description: "Not supported." })),
			yield_time_ms: Type.Optional(Type.Integer({ description: "Wait before returning: default 10000, 250 to 30000.", minimum: 0 })),
			max_output_tokens: Type.Optional(Type.Integer({ description: "Default 10000.", minimum: 0 })),
			shell: Type.Optional(Type.String({ description: "Default: Pi's configured shell." })),
			login: Type.Optional(Type.Boolean({ description: "Login shell; default true." })),
		}, { additionalProperties: false }),
		prepareArguments: prepareExecCommandArguments,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const workdir = params.workdir ? resolveToolPath(ctx.cwd, params.workdir) : ctx.cwd;
			return executeManagedExecCommand({ ...params, workdir }, signal, ctx, onUpdate, ownerFor(ctx));
		},
		renderCall(args, theme, context) {
			const label = formatExecCommandCall(args);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(label)));
			return text;
		},
		renderResult: renderExecResult,
	});
	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		...PROCESSES,
		description: "Read more output from a running exec_command session, or send exactly \"\\u0003\" to interrupt it (Ctrl-C to its process group; on Windows its process tree is ended). Other input is rejected.",
		promptSnippet: "Wait on or interrupt a running command",
		promptGuidelines: [
			"A command left running reports itself when it finishes, with its exit code and the end of its output; there is no need to poll it.",
		],
		parameters: Type.Object({
			session_id: Type.Integer({ description: "From exec_command.", minimum: 1 }),
			chars: Type.Optional(Type.String({ description: "Empty to read output; \"\\u0003\" to interrupt." })),
			yield_time_ms: Type.Optional(Type.Integer({ description: "Wait for output: reads 5000 to 300000, interrupts up to 30000.", minimum: 0 })),
			max_output_tokens: Type.Optional(Type.Integer({ description: "Default 10000.", minimum: 0 })),
		}, { additionalProperties: false }),
		prepareArguments: prepareWriteStdinArguments,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeWriteStdin(params, signal, onUpdate, ownerFor(ctx));
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(formatWriteStdinCall(args))));
			return text;
		},
		renderResult: renderExecResult,
	});
}
