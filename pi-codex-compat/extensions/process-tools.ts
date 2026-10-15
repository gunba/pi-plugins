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
			"A wait that runs out leaves the command running; call write_stdin again, with a longer yield_time_ms for slow commands.",
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
