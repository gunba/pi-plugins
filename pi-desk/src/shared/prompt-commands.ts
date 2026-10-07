export interface PromptCommandInfo {
	name: string;
	description: string;
	kind: "extension" | "template" | "skill" | "builtin" | "desk";
	argumentHint?: string;
	execution?: "read" | "control";
	unavailable?: string;
}

/** A path is not a command name; native Pi owns dispatch of the original text. */
export function promptCommandName(text: string): string | undefined {
	return /^\/([^\s/\\]+)(?:\s|$)/.exec(text)?.[1];
}

export function commandMatches(commands: PromptCommandInfo[], text: string): PromptCommandInfo[] {
	const query = /^\/([\w:.-]*)$/.exec(text)?.[1];
	if (query === undefined) return [];
	return commands.filter(command => command.name.toLowerCase().startsWith(query.toLowerCase()))
		.sort((a, b) => Number(b.name === query) - Number(a.name === query) || a.name.localeCompare(b.name));
}
