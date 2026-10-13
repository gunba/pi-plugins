import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	Authority,
	ChildMode,
	ParentInvocation,
	SubagentRuntime,
} from "./subagent-runtime.ts";
import { parseForkTurns } from "./task-names.ts";

function spawnParameters() {
	return Type.Object(
		{
			task_name: Type.String({
				minLength: 1, pattern: "^[a-z0-9_]+$",
				description: "Unique name under this agent, using lowercase letters, digits and underscores; root is reserved.",
			}),
			message: Type.String({ minLength: 1, description: "The task for the new agent." }),
			fork_turns: Type.Optional(Type.String({
				description: "all (default) inherits completed parent context; none starts fresh; a positive integer string keeps that many recent retained instruction turns. The in-flight turn is excluded.",
			})),
			model: Type.Optional(Type.String({
				minLength: 1,
				description: "Exact provider/model id. Omit to inherit the parent model. Requires user approval once for this conversation.",
			})),
			reasoning_effort: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
				description: "Thinking effort supported by the selected model. Omit to inherit parent effort, adjusted to model capabilities. Requires user approval once for this conversation.",
			})),
		},
		{ additionalProperties: false },
	);
}

const sendParameters = Type.Object({
	target: Type.String({ minLength: 1, description: "Canonical task path, descendant-relative path or native agent ID." }),
	message: Type.String({ minLength: 1, description: "Message to the target agent." }),
}, { additionalProperties: false });

const interruptParameters = Type.Object({
	target: Type.String({ minLength: 1, description: "Task path or native agent ID. Cannot target the root or yourself." }),
}, { additionalProperties: false });

const listParameters = Type.Object({
	path_prefix: Type.Optional(Type.String({ description: "Limit discovery to this task path and its descendants. Omit for the registered tree." })),
}, { additionalProperties: false });

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
		projectTrusted: ctx.isProjectTrusted(),
	};
}

/**
 * Subagent tools are loaded with tool_search when needed rather than declared in every request; most
 * conversations never start one. Loading one group member brings the others, through the shared namespace.
 */
const SUBAGENTS = { exposure: "deferred" as const, namespace: { name: "subagents", description: "Start subagents and message, follow up, wait for, list or interrupt them." } };

function spawnTool(runtime: RuntimeAccess, binding: ToolBinding): ToolDefinition {
	return defineTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		...SUBAGENTS,
		description: "Start a background subagent. It inherits this conversation's context unless fork_turns is \"none\" or a turn count. Returns its task path and ID; its result arrives later as a message.",
		promptSnippet: "Start a subagent",
		promptGuidelines: [
			"Subagents report back by themselves when they finish; keep working rather than polling.",
			"A model or reasoning override asks Jordan once per conversation; if he declines, inherit this conversation's settings.",
		],
		parameters: spawnParameters(),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const turns = parseForkTurns(params.fork_turns);
			const owner = resolveRuntime(runtime);
			const result = await owner.start({
				taskName: params.task_name,
				description: params.task_name,
				prompt: params.message,
				context: turns === "none" ? "fresh" : "fork",
				...(typeof turns === "number" ? { forkTurns: turns } : {}),
				runInBackground: true,
				parent: parentInvocation(binding, toolCallId, ctx),
				model: params.model,
				thinkingLevel: params.reasoning_effort,
				signal,
			});
			if (result.kind !== "continuable") throw Error("Agent creation did not return a durable identity");
			const value = { task_name: owner.agentPath(result.subagentId), agent_id: result.subagentId };
			return { content: [{ type: "text", text: JSON.stringify(value) }], details: result, structuredContent: value };
		},
	});
}

type ToolJson = NonNullable<Awaited<ReturnType<ToolDefinition["execute"]>>["structuredContent"]>;

function response<T extends ToolJson>(value: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, structuredContent: value };
}

/** Model-facing tools share the owning root's registered native tree. */
export function createSubagentToolDefinitions(
	runtime: RuntimeAccess,
	binding: ToolBinding,
	_mode: "root" | ChildMode,
): ToolDefinition[] {
	return [
		spawnTool(runtime, binding),
		defineTool({
			name: "send_message",
			label: "Send Message",
			...SUBAGENTS,
			description: "Message a parent, sibling or child subagent. It arrives at a safe point and does not start an idle agent; use followup_task for that.",
			parameters: sendParameters,
			execute: async (_id, params) => response({
				message_id: resolveRuntime(runtime).sendMessage(binding.getAuthority(), params.target, params.message),
			}),
		}),
		defineTool({
			name: "followup_task",
			label: "Follow-up Task",
			...SUBAGENTS,
			description: "Give a subagent more work. A busy one gets it at its next safe point; an idle one starts a turn. Returns acceptance, not the answer.",
			parameters: sendParameters,
			execute: async (_id, params) => {
				const owner = resolveRuntime(runtime);
				const caller = binding.getAuthority();
				return response({ message_id: owner.followupTask(caller, params.target, params.message) });
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt Agent",
			...SUBAGENTS,
			description: "Stop a subagent's current turn. It keeps its identity, queued work and children.",
			parameters: interruptParameters,
			execute: async (_id, params) => {
				const owner = resolveRuntime(runtime);
				const caller = binding.getAuthority();
				const target = owner.resolveTarget(caller, params.target);
				const previous_status = owner.agentStatus(target);
				owner.interrupt(caller, target);
				return response({ previous_status });
			},
		}),
		defineTool({
			name: "list_agents",
			label: "List Agents",
			...SUBAGENTS,
			description: "List this conversation's subagent tree: running (working), idle (loaded) or ready (saved, resumable).",
			parameters: listParameters,
			execute: async (_id, params) => response({
				agents: resolveRuntime(runtime).listNamedAgents(binding.getAuthority(), params.path_prefix),
			}),
		}),
	];
}
