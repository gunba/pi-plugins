import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "../shared/protocol.ts";

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
			return { name: tool.name, description: tool.description, active: selected.has(tool.name),
				exposure: tool.exposure ?? "direct", callable: callable.has(tool.name), declared: declared.has(tool.name),
				defaultActive: definition?.defaultActive, source: tool.sourceInfo?.path,
				conversationChoice: choices[tool.name] };
		}),
	};
}
