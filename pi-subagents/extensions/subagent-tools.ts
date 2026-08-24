import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	AgentListEntry,
	Authority,
	ChildContextMode,
	ChildMode,
	ParentInvocation,
	SubagentRuntime,
} from "./subagent-runtime.ts";
import {
	MAX_PARENT_NOTICE_BYTES,
	truncateForParent,
} from "./subagent-runtime.ts";

function delegationParameters(context: ChildContextMode) {
	return Type.Object(
		{
			description: Type.String({
				minLength: 1,
				description: "A short 3–5 word description of the delegated task, for display.",
			}),
			prompt: Type.String({
				minLength: 1,
				description:
					context === "fresh"
						? "The complete standalone task. The child cannot see this conversation."
						: "The task-specific information that is new. The child already sees all completed parent turns.",
			}),
			run_in_background: Type.Optional(
				Type.Boolean({
					description:
						"Run independently and return a durable subagent id. Defaults to true. Set false only when the next action needs the result.",
				}),
			),
		},
		{ additionalProperties: false },
	);
}

const sendParameters = Type.Object(
	{
		subagent_id: Type.String({
			description: "The durable id returned by subagent or subagent_fork.",
		}),
		message: Type.String({
			minLength: 1,
			description: "The message to queue as the child conversation's next turn.",
		}),
	},
	{ additionalProperties: false },
);

const interruptParameters = Type.Object(
	{
		agent_id: Type.String({
			description: "The durable id of the running descendant to interrupt.",
		}),
	},
	{ additionalProperties: false },
);

const listParameters = Type.Object(
	{
		scope: Type.Optional(
			StringEnum(["children", "descendants"] as const, {
				description:
					"children (default) lists direct children; descendants walks the complete tree.",
			}),
		),
	},
	{ additionalProperties: false },
);

const reportParameters = Type.Object(
	{
		output: Type.String({
			minLength: 1,
			maxLength: MAX_PARENT_NOTICE_BYTES,
			description:
				"Self-contained, actionable content for the direct parent, including relevant shared paths.",
		}),
	},
	{ additionalProperties: false },
);

export type ToolBinding = {
	getAuthority(): Authority;
	getToolNames?(): string[];
};

export type RuntimeAccess = SubagentRuntime | (() => SubagentRuntime);

function resolveRuntime(access: RuntimeAccess): SubagentRuntime {
	return typeof access === "function" ? access() : access;
}

function parentInvocation(
	binding: ToolBinding,
	toolCallId: string,
	ctx: Parameters<ToolDefinition["execute"]>[4],
): ParentInvocation {
	return {
		authority: binding.getAuthority(),
		sessionManager: ctx.sessionManager as ParentInvocation["sessionManager"],
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		toolNames: binding.getToolNames?.() ?? [],
		toolCallId,
		cwd: ctx.cwd,
	};
}

function delegationTool(
	runtime: RuntimeAccess,
	binding: ToolBinding,
	context: ChildContextMode,
): ToolDefinition {
	const name = context === "fresh" ? "subagent" : "subagent_fork";
	const contextWording =
		context === "fresh"
			? "It has a separate context and cannot see this conversation, so give it a complete standalone prompt."
			: "It inherits all completed turns in this conversation, but not the current in-flight turn; state only the new task-specific information.";
	return defineTool({
		name,
		label: context === "fresh" ? "Subagent" : "Subagent Fork",
		description:
			`Delegate work to a Pi SDK child session. ${contextWording} ` +
			"The child runs in the background by default and remains available by durable id. Set run_in_background false only when the next action depends on its result.",
		promptSnippet:
			context === "fresh"
				? "Delegate a self-contained task to a fresh child session"
				: "Delegate a task to a child seeded with completed parent turns",
		promptGuidelines: [
			`Use ${name} in the background by default; set run_in_background to false only when your next action depends on the result.`,
			`Start independent ${name} delegations together and continue useful work while they run.`,
		],
		parameters: delegationParameters(context),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const result = await resolveRuntime(runtime).start({
				description: params.description,
				prompt: params.prompt,
				context,
				runInBackground: params.run_in_background ?? true,
				parent: parentInvocation(binding, toolCallId, ctx),
				signal,
			});
			if (result.kind === "continuable") {
				return {
					content: [
						{ type: "text", text: `started subagent ${result.subagentId}` },
					],
					details: result,
				};
			}
			if (result.outcome.stopReason !== "completed") {
				const partial = result.outcome.output
					? `\nPartial output before the run ended:\n${truncateForParent(result.outcome.output)}`
					: "";
				throw new Error(
					`subagent run ended ${result.outcome.stopReason}${result.outcome.errorMessage ? `: ${result.outcome.errorMessage}` : ""}${partial}`,
				);
			}
			return {
				content: [{ type: "text", text: truncateForParent(result.outcome.output) }],
				details: result,
			};
		},
	});
}

function formatList(
	entries: AgentListEntry[],
	scope: "children" | "descendants",
): string {
	if (entries.length === 0) return "(no subagents)";
	return entries
		.map((entry) => {
			const at =
				scope === "descendants"
					? ` parent=${String(entry.parent)} depth=${String(entry.depth)}`
					: "";
			return entry.kind === "child"
				? `${entry.id} [${entry.status}]${at} — ${entry.label}`
				: `${entry.id} [diagnostic: ${entry.reason}]${at}`;
		})
		.join("\n");
}

/** Build the DSH-standard model-facing tools for a root or child authority. */
export function createSubagentToolDefinitions(
	runtime: RuntimeAccess,
	binding: ToolBinding,
	mode: "root" | ChildMode,
): ToolDefinition[] {
	const tools: ToolDefinition[] = [
		delegationTool(runtime, binding, "fresh"),
		delegationTool(runtime, binding, "fork"),
		defineTool({
			name: "send_message",
			label: "Send Message",
			description:
				"Send a message to a direct background child by durable id. It is a FIFO later turn: it cannot redirect the current turn and this call returns only acceptance, never the child's answer.",
			parameters: sendParameters,
			execute: async (_toolCallId, params) => {
				const messageId = resolveRuntime(runtime).sendMessage(
					binding.getAuthority(),
					params.subagent_id,
					params.message,
				);
				return {
					content: [
						{
							type: "text",
							text: `message queued as the next turn for subagent ${params.subagent_id}`,
						},
					],
					details: { messageId },
				};
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt Agent",
			description:
				"Request cancellation of a descendant's current turn. The agent identity, queued messages, and descendants remain; an idle or absent target is an accepted no-op.",
			parameters: interruptParameters,
			execute: async (_toolCallId, params) => ({
				content: [
					{
						type: "text",
						text: `interrupt requested for agent ${params.agent_id}`,
					},
				],
				details: {
					accepted: resolveRuntime(runtime).interrupt(
						binding.getAuthority(),
						params.agent_id,
					),
				},
			}),
		}),
		defineTool({
			name: "list_agents",
			label: "List Agents",
			description:
				"List durable continuable children by id and label. Use this for discovery, not polling: settlement notices arrive automatically. running means active now, idle means resident between turns, and ready means cold but resumable. descendants includes parent and depth; only depth-1 entries accept send_message.",
			parameters: listParameters,
			execute: async (_toolCallId, params) => {
				const scope = params.scope ?? "children";
				const entries = resolveRuntime(runtime).listAgents(binding.getAuthority(), scope);
				return {
					content: [{ type: "text", text: formatList(entries, scope) }],
					details: { scope, entries },
				};
			},
		}),
	];
	if (mode === "continuable") {
		tools.push(
			defineTool({
				name: "report",
				label: "Report",
				description:
					"Report selected self-contained content to the direct parent. Reporting does not end this turn, and only the direct parent receives it.",
				promptSnippet:
					"Report a self-contained result to the direct parent without ending the turn",
				promptGuidelines: [
					"Use report once before finishing with a self-contained result, and earlier when a finding changes what the direct parent should do next.",
				],
				parameters: reportParameters,
				execute: async (_toolCallId, params) => {
					const messageId = resolveRuntime(runtime).report(
						binding.getAuthority(),
						params.output,
					);
					return {
						content: [
							{
								type: "text",
								text: `report accepted by the agent that started you as message ${messageId}`,
							},
						],
						details: { messageId },
					};
				},
			}),
		);
	}
	return tools;
}
