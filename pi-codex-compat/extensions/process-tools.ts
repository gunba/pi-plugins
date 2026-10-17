import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkCoordinator } from "../../pi-work-coordination/index.ts";
import { recordRun, runDuration } from "./run-times.ts";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveToolPath } from "./paths.ts";
import {
	type ExecRuntimeOwner, type ExecRuntimeOwnerFor, createExecRuntimeOwner,
	executeManagedExecCommand, executeWriteStdin, onBackgroundExit, onSlowCommand, prepareExecCommandArguments, prepareWriteStdinArguments,
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
			onSlowCommand(owner, slow => {
				const id = `process-slow:${sessionId}:${slow.id}`, context = contexts.get(sessionId);
				pi.sendMessage({ customType: PROCESS_EXIT, display: true, details: { messageIds: [id], ...slow },
					content: `Background command still running: \`${slow.cmd.length > 200 ? `${slow.cmd.slice(0, 200)}…` : slow.cmd}\` (session ${slow.id}) has run ${runDuration(slow.seconds)}; it usually takes ${runDuration(slow.median)} here (${slow.runs} runs). It may be stuck. It has not been stopped.` },
					{ deliverAs: "steer", triggerTurn: context?.isIdle() ?? false });
				getWorkCoordinator(sessionId)?.notify([id]);
			});
		}
		return owner;
	};
	pi.on("session_shutdown", async (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const owner = owners.get(id);
		contexts.delete(id);
		if (!owner) return;
		onBackgroundExit(owner, undefined); onSlowCommand(owner, undefined);
		await shutdownExecSessions(owner);
		owners.delete(id);
	});
	// bash runs are timed too, so exec_command knows how long a command usually takes in this folder.
	const started = new Map<string, { cwd: string; cmd: string; at: number }>();
	pi.on("tool_call", (event, ctx) => {
		const command = (event.input as { command?: unknown }).command;
		if (event.toolName === "bash" && typeof command === "string") started.set(event.toolCallId, { cwd: ctx.cwd, cmd: command, at: Date.now() });
	});
	pi.on("tool_result", event => {
		const run = started.get(event.toolCallId);
		if (!run) return;
		started.delete(event.toolCallId);
		if (!event.isError) recordRun(run.cwd, run.cmd, (Date.now() - run.at) / 1000);
	});
	pi.on("session_start", async (_event, ctx) => {
		contexts.set(ctx.sessionManager.getSessionId(), ctx);
		await startExecSessionRuntime(ownerFor(ctx));
	});
	return ownerFor;
}

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
