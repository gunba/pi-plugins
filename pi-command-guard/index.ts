import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { assessCommand, dialectFor, type Assessment } from "./policy.ts";
import type { Environment } from "./paths.ts";
import { lostPaths } from "./lost.ts";
import { CHILD_POLICIES_EVENT, type ChildPolicySource } from "../pi-agents/subagents/child-policies.ts";

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
		// watch runs its command (until and stop take none) in the shell Pi finds for bash.
		if (!["bash", "powershell", "watch"].includes(event.toolName)) return;
		const env: Environment = { cwd: ctx.cwd, home: homedir(), platform: process.platform === "win32" ? "win32" : "posix" };
		const settings = pi.getSettings();
		const command = input.command;
		if (typeof command !== "string") return;
		// Pi's shell prefix and shell setting apply to bash only.
		const review = event.toolName === "bash" && settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${command}` : command;
		let assessment: Assessment;
		if (event.toolName === "powershell") assessment = assessCommand(review, env, "powershell");
		else if (event.toolName === "bash" && settings.shellPath) assessment = assessCommand(review, env, dialectFor(settings.shellPath));
		else {
			// The discovered shell is bash or sh; on Windows the command is checked in every dialect.
			const results = (env.platform === "win32" ? ["posix", "powershell", "cmd"] as const : ["posix"] as const).map(dialect => assessCommand(review, env, dialect));
			assessment = results.find(result => result.decision === "block") ?? results.find(result => result.decision === "confirm") ?? { decision: "pass" };
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
		// Shown only; the decision above does not depend on it.
		const lost = assessment.lost ? await lostPaths(assessment.lost, ctx.signal) : "";
		const asked = Date.now(), timeout = 120_000;
		const approved = await ctx.ui.confirm("Confirm Git wipe", `${assessment.reason}\n\nTool: ${event.toolName}\nDirectory: ${env.cwd}\n\n${review}${lost ? `\n\n${lost}` : ""}`, { signal: ctx.signal, timeout });
		// confirm() reports a timeout and a refusal alike; say which, so the agent does not tell the user they refused.
		if (approved !== true) return denied(ctx.signal?.aborted ? "The confirmation was cancelled."
			: Date.now() - asked >= timeout - 1_000 ? "The user was asked but did not answer within 2 minutes (they may be away); this is not a refusal."
			: "The user declined.");
		if (epoch !== generation || session !== ctx.sessionManager.getSessionId() || cwd !== ctx.cwd || ctx.signal?.aborted || original !== signature()) return denied("The operation or session changed while confirmation was open.");
	});
}
