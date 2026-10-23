import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Pi resumes a conversation with the tools it last declared, which keeps its prompt cache; but a tool added to Desk
 * after the conversation began then never reaches it (GEPA Audit had no agent_discover or agent_send, so it could not
 * find other computers). Tools a new conversation would start with, and that this one has never declared, are switched
 * on: added tools keep the cached prompt. Tools it declared and later dropped, or that the user switched off in its
 * context settings, stay off; MCP tools keep their own selection, and Pi's own optional tools (grep, find, ls,
 * powershell) its defaults: switched on as "new", they added some 700 tokens to every request and a PowerShell tool on Linux.
 */
export function activateNewTools(session: AgentSession, choices: Record<string, boolean>): string[] {
	const declared = new Set<string>();
	for (const entry of session.sessionManager.getBranch()) {
		const message = entry.type === "message" ? entry.message as { role?: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] } : undefined;
		if (message?.role !== "system") continue;
		for (const tool of [...message.toolsAdded ?? [], ...message.toolsRemoved ?? []]) declared.add(tool.name);
	}
	// A new conversation has Pi's own starting tools.
	if (!declared.size) return [];
	const active = new Set(session.getActiveToolNames());
	const added = session.getAllTools().filter(tool => (tool.exposure ?? "direct") === "direct" && tool.sourceInfo?.source !== "builtin").map(tool => tool.name)
		.filter(name => !active.has(name) && !declared.has(name) && choices[name] !== false && !name.startsWith("mcp__")
			&& session.getToolDefinition(name)?.defaultActive !== false);
	if (added.length) session.setActiveToolsByName([...active, ...added]);
	return added;
}
