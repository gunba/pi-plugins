import { promptCommandName, type PromptCommandInfo } from "../shared/prompt-commands.ts";

const commands = [
	{ name: "settings", description: "Open Desk settings; optionally specify a section.", kind: "desk" },
	{ name: "new", description: "Choose a directory for a new conversation.", kind: "desk" },
	{ name: "resume", description: "Choose a saved native Pi session to resume.", kind: "desk" },
	{ name: "name", description: "Rename this conversation; optionally supply its name.", kind: "desk" },
	{ name: "compact", description: "Compact native context; optionally supply summary instructions.", kind: "desk" },
	{ name: "reload", description: "Reload this conversation's native resources and extensions.", kind: "desk" },
	{ name: "fork", description: "/fork opens branch history. /fork <entry-id> [at|before] forks that entry.", kind: "desk" },
	{ name: "tree", description: "/tree opens native branch history.", kind: "desk" },
	{ name: "help", description: "Show the commands loaded for this conversation.", kind: "desk" },
] as const satisfies readonly PromptCommandInfo[];

/** Loaded native extensions and templates retain ownership of their command names. */
export function deskCommandCatalog(native: PromptCommandInfo[]): PromptCommandInfo[] {
	return [...native, ...commands.filter(command => !native.some(item => item.name === command.name))];
}
export function deskCommand(text: string, native: PromptCommandInfo[]) {
	const name = promptCommandName(text);
	if (!name || native.some(command => command.name === name)) return;
	const command = commands.find(command => command.name === name);
	return command && { name: command.name, args: text.slice(name.length + 1).trim() };
}
