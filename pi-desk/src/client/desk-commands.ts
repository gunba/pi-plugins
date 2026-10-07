import { promptCommandName, type PromptCommandInfo } from "../shared/prompt-commands.ts";

export interface DeskCommandHandler {
	description: string;
	argumentHint?: string;
	execute(args: string): unknown | Promise<unknown>;
}
export type DeskCommandHandlers = Record<string, DeskCommandHandler>;

const gaps: Record<string, string> = {
	"scoped-models": "This configures terminal Ctrl+P cycling. Desk uses its direct model picker.",
	trust: "The persistent project-trust selector is not bridged. Native startup trust checks still apply.",
	share: "The GitHub upload and consent flow is not bridged. Export the session or use Pi’s terminal.",
	bug: "The native report and transcript-sharing consent flow is not bridged. Use Pi’s terminal.",
};

/** The native catalog and registered Desk handlers define the surface, not a second command list. */
export function deskCommandCatalog(native: PromptCommandInfo[], handlers: DeskCommandHandlers = {}): PromptCommandInfo[] {
	const commands = [...native, ...Object.entries(handlers).filter(([name]) => !native.some(command => command.name === name))
		.map(([name, handler]) => ({ name, description: handler.description, argumentHint: handler.argumentHint, kind: "desk" as const }))];
	return commands.map(command => command.kind === "builtin" && !command.execution && !Object.hasOwn(handlers, command.name)
		? { ...command, unavailable: gaps[command.name] ?? "This command needs Pi's terminal UI; no Desk adapter is available." } : command);
}
export function deskCommand(text: string, native: PromptCommandInfo[], handlers: DeskCommandHandlers = {}) {
	const name = promptCommandName(text);
	const command = name && deskCommandCatalog(native, handlers).find(command => command.name === name);
	if (!command || !["builtin", "desk"].includes(command.kind)) return;
	if (command.unavailable) throw Error(`/${command.name}: ${command.unavailable}`);
	return { name: command.name, args: text.slice(command.name.length + 1).trim() };
}
