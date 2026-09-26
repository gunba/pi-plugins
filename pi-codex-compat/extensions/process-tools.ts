import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { executeApplyPatch, renderApplyPatchResult, type ApplyPatchDetails } from "./patch-tools.ts";
import { resolveToolPath } from "./paths.ts";
import { extractShellApplyPatch } from "./shell-apply-patch.ts";
import {
	type ExecRuntimeOwner, type ExecRuntimeOwnerFor, createExecRuntimeOwner,
	executeManagedExecCommand, executeWriteStdin, prepareExecCommandArguments, prepareWriteStdinArguments,
	shutdownExecSessions, startExecSessionRuntime,
} from "./shell-runtime.ts";
import { formatApplyPatchCall, formatExecCommandCall, formatWriteStdinCall, renderExecResult } from "./tool-rendering.ts";

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

function interceptedPatchWorkdir(cwd: string, execWorkdir: string | undefined, shellWorkdir: string | undefined): string | undefined {
	const outer = execWorkdir ? resolveToolPath(cwd, execWorkdir) : cwd;
	if (shellWorkdir) return resolveToolPath(outer, shellWorkdir);
	return execWorkdir ? outer : undefined;
}

export function registerProcessTools(pi: ExtensionAPI, ownerFor: ExecRuntimeOwnerFor): void {
	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description: "Runs a command with plain pipes, returning output or a session ID for ongoing polling. tty defaults to false; tty:true is rejected because PTY/ConPTY allocation belongs to the Codex core runtime and is unavailable inside this extension.",
		promptSnippet: "Run commands in managed sessions with the Codex Unified Exec contract",
		promptGuidelines: [
			"A command still running after yield_time_ms returns a session ID. Completion notifications arrive automatically; write_stdin collects the result.",
			"exec_command intercepts `apply_patch <<'PATCH'` heredocs and routes them to apply_patch instead of executing a shell binary.",
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
			const patch = extractShellApplyPatch(params.cmd);
			if (patch) {
				return executeApplyPatch(patch.input,
					interceptedPatchWorkdir(ctx.cwd, params.workdir, patch.workdir), ctx, signal);
			}
			const workdir = params.workdir ? resolveToolPath(ctx.cwd, params.workdir) : ctx.cwd;
			return executeManagedExecCommand({ ...params, workdir }, signal, ctx, onUpdate, ownerFor(ctx));
		},
		renderCall(args, theme, context) {
			const patch = typeof args.cmd === "string" ? extractShellApplyPatch(args.cmd) : undefined;
			const label = patch ? formatApplyPatchCall({
				input: patch.input,
				workdir: interceptedPatchWorkdir(context.cwd, typeof args.workdir === "string" ? args.workdir : undefined, patch.workdir),
			}) : formatExecCommandCall(args);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(label)));
			return text;
		},
		renderResult(result, options, theme, context) {
			const cmd = (context.args as { cmd?: unknown } | undefined)?.cmd;
			if (typeof cmd === "string" && extractShellApplyPatch(cmd)) {
				return renderApplyPatchResult(result as AgentToolResult<ApplyPatchDetails>, options, theme, context);
			}
			return renderExecResult(result, options, theme, context);
		},
	});
	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description: "Writes characters to an existing unified exec session and returns recent output. In this plain-pipe fallback, only empty polling or an exact U+0003 interrupt is accepted.",
		promptSnippet: "Poll a Unified Exec session or send an exact Ctrl-C interrupt",
		promptGuidelines: [
			"session_id comes from exec_command. Omitted or empty chars reads output; stdin is closed except for the U+0003 interruption request.",
			"On Unix, exact Ctrl-C targets the process group with SIGINT. On Windows, it requests `taskkill /T` tree termination because an extension cannot emit a truthful console Ctrl-C event.",
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
