import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { assessCommand, assessFile, dialectFor, type Assessment } from "./policy.ts";
import { normalizePath, type Environment } from "./paths.ts";
import { CHILD_POLICIES_EVENT, type ChildPolicySource } from "../pi-subagents/extensions/child-policies.ts";

export default function commandGuard(pi: ExtensionAPI): void {
	pi.events.on(CHILD_POLICIES_EVENT, data => {
		const request = data as { policies?: ChildPolicySource[] } | undefined;
		if (Array.isArray(request?.policies)) request.policies.push({ path: fileURLToPath(import.meta.url), scope: "user" });
	});
	let generation = 0;
	const retire = () => { generation++; };
	pi.on("session_start", retire); pi.on("session_tree", retire); pi.on("session_shutdown", retire);
	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		const input = event.input as Record<string, unknown>;
		const shellCall = ["bash", "powershell", "exec_command"].includes(event.toolName);
		const fileCall = event.toolName === "write" || event.toolName === "edit";
		if (!shellCall && !fileCall) return;
		const env: Environment = { cwd: ctx.cwd, home: homedir(), temp: tmpdir(), platform: process.platform === "win32" ? "win32" : "posix", workspace: ctx.cwd, agentDir: getAgentDir(), runtime: process.env.PI_DESK_RUNTIME };
		if (event.toolName === "exec_command" && typeof input.workdir === "string") env.cwd = normalizePath(input.workdir, env);
		const settings = pi.getSettings();
		let assessment: Assessment, review: string;
		if (shellCall) {
			const command = event.toolName === "exec_command" ? input.cmd : input.command;
			if (typeof command !== "string") return { block: true, reason: "Command protection: the command is missing." };
			review = event.toolName === "bash" && settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${command}` : command;
			const explicitShell = event.toolName === "exec_command" && typeof input.shell === "string" ? input.shell.trim() : "";
			if (event.toolName === "powershell") assessment = assessCommand(review, env, "powershell");
			else if (explicitShell || event.toolName === "bash" && settings.shellPath) assessment = assessCommand(review, env, dialectFor(explicitShell || settings.shellPath!));
			else {
				// Unified Exec resolves configuration when launching. Do not treat the
				// session's older shell setting as proof of its eventual dialect.
				const results = (event.toolName === "exec_command" || env.platform === "win32" ? ["posix", "powershell", "cmd"] as const : ["posix"] as const).map(dialect => assessCommand(review, env, dialect));
				assessment = results.find(result => result.decision === "block") ?? results.find(result => result.decision === "confirm") ?? { decision: "pass" };
			}
		} else {
			if (typeof input.path !== "string") return { block: true, reason: "Command protection: the file path is missing." };
			assessment = assessFile(input.path, env);
			review = JSON.stringify(input, null, 2);
		}
		if (assessment.decision === "pass") return;
		const denied = (reason: string) => ({ block: true as const, reason: `Command protection [${assessment.rule}]: ${reason} No operation was run.` });
		if (assessment.decision === "block") return denied(assessment.reason);
		if (!ctx.hasUI || ctx.signal?.aborted) return denied(`${assessment.reason} Operator confirmation is unavailable.`);
		if (review.length > 16_384) return denied("The operation is too large to display completely for confirmation.");
		const signature = () => {
			const current = pi.getSettings();
			return createHash("sha256").update(JSON.stringify({ tool: event.toolName, input: event.input, shell: current.shellPath, prefix: current.shellCommandPrefix })).digest("hex");
		};
		const original = signature(), epoch = generation, session = ctx.sessionManager.getSessionId(), cwd = ctx.cwd;
		const approved = await ctx.ui.confirm("Confirm destructive operation", `${assessment.reason}\n\nTool: ${event.toolName}\nDirectory: ${env.cwd}\n\n${review}`, { signal: ctx.signal, timeout: 120_000 });
		if (approved !== true) return denied("Operator confirmation was not granted.");
		if (epoch !== generation || session !== ctx.sessionManager.getSessionId() || cwd !== ctx.cwd || ctx.signal?.aborted || original !== signature()) return denied("The operation or session changed while confirmation was open.");
	});
}
