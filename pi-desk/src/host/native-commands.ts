import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSessionRuntime, getPackageDir, resolveCliModel, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { PromptCommandInfo } from "../shared/prompt-commands.ts";

// Pi publishes this catalog to its terminal, but not through the SDK root export.
// Resolve it beside the actor's SDK entry, including production layouts with no root peers.
const { BUILTIN_SLASH_COMMANDS } = await import(new URL("./core/slash-commands.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
export const nativeBuiltins: readonly Pick<PromptCommandInfo, "name" | "description" | "argumentHint">[] = BUILTIN_SLASH_COMMANDS;

const pathArgument = (text: string) => {
	const value = text.trim();
	return value.length > 1 && ["\"", "'"].includes(value[0]) && value.at(-1) === value[0] ? value.slice(1, -1) : value;
};
const noArguments = (name: string, args: string) => { if (args.trim()) throw Error(`Use /${name} without arguments.`); };

const readers: Record<string, (session: AgentSession, args: string) => unknown> = {
	session: session => session.getSessionStats(),
	copy: session => session.getLastAssistantText() ?? "",
	changelog: () => readFileSync(join(getPackageDir(), "CHANGELOG.md"), "utf8").slice(0, 32_000),
};
const controls: Record<string, (session: AgentSession, runtime: AgentSessionRuntime, args: string) => Promise<unknown>> = {
	model: async (session, _runtime, args) => {
		const resolved = nativeModel(session, args);
		await session.setModel(resolved.model!, { persist: false });
		if (resolved.thinkingLevel) session.setThinkingLevel(resolved.thinkingLevel);
	},
	export: async (session, _runtime, args) => {
		const path = pathArgument(args) || undefined;
		return { path: path?.toLowerCase().endsWith(".jsonl") ? session.exportToJsonl(path) : await session.exportToHtml(path) };
	},
	clone: async (session, runtime, args) => {
		noArguments("clone", args);
		const leaf = session.sessionManager.getLeafId();
		if (!leaf) throw Error("Nothing to clone yet.");
		return runtime.fork(leaf, { position: "at" });
	},
	import: async (_session, runtime, args) => {
		const path = pathArgument(args);
		if (!path) throw Error("Use /import <JSONL path on this computer>.");
		return runtime.importFromJsonl(path);
	},
};

export function nativeModel(session: AgentSession, args: string) {
	const resolved = resolveCliModel({ cliModel: args, modelRuntime: session.modelRuntime });
	if (!resolved.model) throw Error(resolved.error ?? resolved.warning ?? "Choose a model.");
	return resolved;
}
export function nativeExecution(name: string): PromptCommandInfo["execution"] {
	return Object.hasOwn(readers, name) ? "read" : Object.hasOwn(controls, name) ? "control" : undefined;
}
export function readNativeCommand(session: AgentSession, name: string, args: string): unknown {
	if (!nativeBuiltins.some(command => command.name === name) || !Object.hasOwn(readers, name)) throw Error(`/${name} has no native read adapter.`);
	noArguments(name, args);
	return readers[name](session, args);
}
export async function runNativeCommand(session: AgentSession, runtime: AgentSessionRuntime, name: string, args: string): Promise<unknown> {
	if (!nativeBuiltins.some(command => command.name === name) || !Object.hasOwn(controls, name)) throw Error(`/${name} has no native action adapter.`);
	return controls[name](session, runtime, args);
}
