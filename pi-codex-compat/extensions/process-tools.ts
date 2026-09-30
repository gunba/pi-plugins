import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveToolPath } from "./paths.ts";
import {
	type ExecRuntimeOwner, type ExecRuntimeOwnerFor, createExecRuntimeOwner,
	executeManagedExecCommand, executeWriteStdin, prepareExecCommandArguments, prepareWriteStdinArguments,
	shutdownExecSessions, startExecSessionRuntime,
} from "./shell-runtime.ts";
import { formatExecCommandCall, formatWriteStdinCall, renderExecResult } from "./tool-rendering.ts";

export function createExecLifecycle(pi: ExtensionAPI): ExecRuntimeOwnerFor {
	let fallback: ExecRuntimeOwner | undefined;
	const owners = new Map<string, ExecRuntimeOwner>();
	const ownerFor: ExecRuntimeOwnerFor = ctx => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) return fallback ??= createExecRuntimeOwner();
		let owner = owners.get(sessionId);
		if (!owner) {
			owner = createExecRuntimeOwner();
			owners.set(sessionId, owner);
		}
		return owner;
	};
	pi.on("session_shutdown", async (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const owner = owners.get(id);
		if (!owner) return;
		await shutdownExecSessions(owner);
		owners.delete(id);
	});
	pi.on("session_start", async (_event, ctx) => {
		await startExecSessionRuntime(ownerFor(ctx));
	});
	return ownerFor;
}

export function registerProcessTools(pi: ExtensionAPI, ownerFor: ExecRuntimeOwnerFor): void {
	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description: "Run a command with plain pipes, returning output or a session ID for background work. Interactive terminal allocation is not supported.",
		promptSnippet: "Run a command with background process control and completion notifications",
		promptGuidelines: [
			"Omit yield_time_ms for ordinary commands. Use short waits only for persistent services or when independent useful work can run concurrently.",
			"A command still running after the initial wait returns a session ID. Rely on completion notifications, then call write_stdin once to collect the result rather than repeatedly polling.",
			"For large HTTP responses, save the body to a file and inspect selected fields or ranges. Command output is bounded; use returned log paths or read_artifact references to recover omitted output.",
		],
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			workdir: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the turn cwd." })),
			tty: Type.Optional(Type.Boolean({
				description: "Requests PTY allocation. False or omitted uses plain pipes; true is rejected by this extension because PTY/ConPTY support belongs to Codex core.",
			})),
			yield_time_ms: Type.Optional(Type.Integer({
				description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms (2000-30000 ms on Windows).", minimum: 0,
			})),
			max_output_tokens: Type.Optional(Type.Integer({
				description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.", minimum: 0,
			})),
			shell: Type.Optional(Type.String({ description: "Shell binary to launch. Defaults to Pi's configured shellPath, then Pi's platform shell discovery." })),
			login: Type.Optional(Type.Boolean({ description: "True runs with login shell semantics; false disables them. Defaults to true." })),
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
		description: "Writes characters to an existing unified exec session and returns recent output. In this plain-pipe fallback, only empty polling or an exact U+0003 interrupt is accepted.",
		promptSnippet: "Poll a Unified Exec session or send an exact Ctrl-C interrupt",
		promptGuidelines: [
			"session_id comes from exec_command. Omitted or empty chars reads output; stdin is closed except for the U+0003 interruption request.",
			"Rely on completion notifications and collect the result once; omit yield_time_ms for ordinary collection.",
			"On Unix, exact Ctrl-C targets the process group with SIGINT. On Windows, it uses taskkill to terminate the command tree; it does not emit a console Ctrl-C event.",
		],
		parameters: Type.Object({
			session_id: Type.Integer({ description: "Identifier of the running unified exec session.", minimum: 1 }),
			chars: Type.Optional(Type.String({
				description: "Empty or omitted polls without writing. Exact U+0003 requests interruption; all other non-empty input is rejected for plain-pipe sessions.",
			})),
			yield_time_ms: Type.Optional(Type.Integer({
				description: "Wait before yielding output. Exact interrupt requests default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.", minimum: 0,
			})),
			max_output_tokens: Type.Optional(Type.Integer({
				description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.", minimum: 0,
			})),
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
