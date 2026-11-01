import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { REQUEST_PREFIX } from "../../../pi-tools/index.ts";

/** Pi's own optional tools: on only where the user chose them, in context settings or Pi's default tools. */
const OPTIONAL_BUILTINS = new Set(["powershell", "grep", "find", "ls"]);
/** Pi's own tools a conversation starts with unless its settings choose otherwise. */
const BUILTINS = new Set(["read", "bash", "edit", "write"]);

/**
 * Pi resumes a conversation with the tools it last declared, which keeps its prompt cache; but a tool added to Desk
 * after the conversation began then never reaches it (GEPA Audit had no agent_discover or agent_send, so it could not
 * find other computers). Tools a new conversation would start with, and that this one has never declared, are switched
 * on: added tools keep the cached prompt. Tools it declared and later dropped, or that the user switched off in its
 * context settings, stay off; MCP tools keep their own selection.
 *
 * Every model has the same tools, so Pi's optional ones the user did not choose are switched off. Codex models were
 * once started with grep, find and ls, and Desk 0.5.171 to 0.5.181 switched all four on as new tools, adding up to
 * 700 tokens to every request and a PowerShell tool on Linux. Returns the tools switched on.
 */
/** Pi's own tools a new conversation starts with: its default tools, or the ones defaultTools names or adds and removes. */
function startingBuiltins(defaults: readonly string[]): Set<string> {
	const plain = defaults.filter(name => !/^[+-]/.test(name));
	const names = new Set(plain.length ? plain : BUILTINS);
	for (const name of defaults) if (name.startsWith("+")) names.add(name.slice(1)); else if (name.startsWith("-")) names.delete(name.slice(1));
	return names;
}
export function activateNewTools(session: AgentSession, choices: Record<string, boolean>): string[] {
	const declared = new Set<string>();
	for (const entry of session.sessionManager.getBranch()) {
		const message = entry.type === "message" ? entry.message as { role?: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] } : undefined;
		if (message?.role !== "system") continue;
		for (const tool of [...message.toolsAdded ?? [], ...message.toolsRemoved ?? []]) declared.add(tool.name);
	}
	// A new conversation has Pi's own starting tools.
	if (!declared.size) return [];
	const active = new Set(session.getActiveToolNames()), tools = session.getAllTools();
	const defaults = session.settingsManager.getDefaultTools() ?? [];
	// With the single codemode tool, every other tool is hidden from the model and called from programs, so Pi records
	// it as dropped and resumes without it: old conversations lost bash, edit and write. Hidden tools change nothing the
	// model sees, so all a new conversation would have are switched on, whatever was declared before.
	if (session.getToolDefinition("codemode")?.description?.startsWith(REQUEST_PREFIX)) {
		const starting = tools.filter(tool => (tool.exposure ?? "direct") === "direct" && !tool.name.startsWith("mcp__") && choices[tool.name] !== false
			&& (tool.sourceInfo?.source === "builtin" ? startingBuiltins(defaults).has(tool.name)
				: session.getToolDefinition(tool.name)?.defaultActive !== false)).map(tool => tool.name);
		const missing = starting.filter(name => !active.has(name));
		if (missing.length) session.setActiveToolsByName([...active, ...missing]);
		return missing;
	}
	const added = tools.filter(tool => (tool.exposure ?? "direct") === "direct" && tool.sourceInfo?.source !== "builtin").map(tool => tool.name)
		.filter(name => !active.has(name) && !declared.has(name) && choices[name] !== false && !name.startsWith("mcp__")
			&& session.getToolDefinition(name)?.defaultActive !== false);
	const unchosen = new Set(tools.filter(tool => OPTIONAL_BUILTINS.has(tool.name) && tool.sourceInfo?.source === "builtin" && active.has(tool.name)
		&& choices[tool.name] !== true && !defaults.includes(tool.name) && !defaults.includes(`+${tool.name}`)).map(tool => tool.name));
	if (added.length || unchosen.size) session.setActiveToolsByName([...active].filter(name => !unchosen.has(name)).concat(added));
	return added;
}
