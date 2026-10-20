import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "../shared/protocol.ts";

/** A tool description's first sentence, at most 200 characters. */
function summary(description: string): string {
	if (!description) return description;
	const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(description.trim())?.[0] ?? description.trim();
	return first.length > 200 ? `${first.slice(0, 197)}…` : first;
}
/** Registration, selection and callable exposure are distinct native states. */
export function toolInventory(session: AgentSession, choices: Record<string, boolean> = {}): Pick<SessionSnapshot, "tools" | "toolDefaults"> {
	const selected = new Set(session.getActiveToolNames()), callable = new Set(session.getCallableToolNames());
	const declared = new Set(session.agent.state.tools.map(tool => tool.name));
	const computer = session.settingsManager.getGlobalSettings().defaultTools;
	const project = session.settingsManager.getProjectSettings().defaultTools;
	return {
		toolDefaults: { computer, project, resolved: session.settingsManager.getDefaultTools() },
		tools: session.getAllTools().map(tool => {
			const definition = session.getToolDefinition(tool.name);
			// The first sentence, which Settings shows: whole descriptions were a fifth of every conversation's entry.
			return { name: tool.name, description: summary(tool.description), active: selected.has(tool.name),
				exposure: tool.exposure ?? "direct", callable: callable.has(tool.name), declared: declared.has(tool.name),
				defaultActive: definition?.defaultActive, source: tool.sourceInfo?.path,
				conversationChoice: choices[tool.name] };
		}),
	};
}
