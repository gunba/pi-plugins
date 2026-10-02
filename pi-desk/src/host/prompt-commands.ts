import type { AgentSession, ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { PromptCommandInfo } from "../shared/prompt-commands.ts";

export function promptCommands(session: AgentSession, resources: ResourceLoader): PromptCommandInfo[] {
	const commands = new Map<string, PromptCommandInfo>();
	const add = (command: PromptCommandInfo) => { if (!commands.has(command.name)) commands.set(command.name, command); };
	for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) {
		add({ name: command.name, description: command.description ?? "", kind: "extension" });
	}
	for (const prompt of session.promptTemplates) add({ name: prompt.name, description: prompt.description, kind: "template" });
	for (const skill of resources.getSkills().skills) add({ name: `skill:${skill.name}`, description: skill.description, kind: "skill" });
	return [...commands.values()];
}
