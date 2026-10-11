/** One line describing a tool call, from its arguments; empty when nothing useful can be said. */

type Args = Record<string, unknown>;
const LIMIT = 220;
const line = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, LIMIT);
const str = (value: unknown) => typeof value === "string" ? value : "";
const list = (values: string[], max = 3) => values.length > max ? `${values.slice(0, max).join(", ")} +${values.length - max}` : values.join(", ");
const counted = (names: string[]) => {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
};

/** Arguments are cut short for long calls, so read string fields from incomplete JSON too. */
function parse(serialized: string): Args {
	try { const value = JSON.parse(serialized); return value && typeof value === "object" ? value as Args : {}; }
	catch {
		const args: Args = {};
		for (const match of serialized.matchAll(/"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)/g)) {
			if (args[match[1]!] !== undefined) continue;
			try { args[match[1]!] = JSON.parse(`"${match[2]!.replace(/\\$/, "")}"`); } catch { /* Ends mid-escape. */ }
		}
		return args;
	}
}

/** The first line of code that does something, rather than options or comments. */
function firstStatement(code: string): string {
	return code.split("\n").map(text => text.trim()).find(text => text && !text.startsWith("//") && !text.startsWith("#") && !/^[{}()[\];,]+$/.test(text)) ?? "";
}

/** Shell commands often start by changing directory; the command after it says more. */
const shell = (command: string) => command.replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, "");

const READERS: Record<string, (args: Args) => string> = {
	bash: args => shell(str(args.command) || str(args.cmd)),
	exec_command: args => shell(str(args.cmd) || str(args.command)),
	codemode: args => {
		const code = str(args.code), calls = [...code.matchAll(/\btools\.([A-Za-z_][\w]*)\s*\(/g)].map(match => match[1]!);
		return calls.length ? counted(calls).join(", ") : firstStatement(code);
	},
	apply_patch: args => {
		const files = [...str(args.input).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map(match => `${match[1]} ${match[2]!.split(/[\\/]/).at(-1)}`);
		return list(files) || firstStatement(str(args.input));
	},
	grep: args => [str(args.pattern), str(args.path) && `in ${str(args.path)}`].filter(Boolean).join(" "),
	find: args => [str(args.pattern), str(args.path) && `in ${str(args.path)}`].filter(Boolean).join(" "),
	write_stdin: args => str(args.chars) ? `send ${JSON.stringify(str(args.chars)).slice(0, 40)}` : `wait for session ${String(args.session_id ?? "")}`.trim(),
	web_search: args => {
		const parts: string[] = [];
		const items = (key: string) => Array.isArray(args[key]) ? args[key] as Args[] : [];
		const queries = items("search_query").map(item => str(item.q)).filter(Boolean);
		if (queries.length) parts.push(list(queries.map(query => `“${query}”`), 2));
		const opened = items("open").map(item => str(item.ref_id)).filter(Boolean);
		if (opened.length) parts.push(`open ${list(opened, 2)}`);
		const found = items("find").map(item => str(item.pattern)).filter(Boolean);
		if (found.length) parts.push(`find ${list(found.map(pattern => `“${pattern}”`), 2)}`);
		if (Array.isArray(args.check)) parts.push(`check ${args.check.length} URL${args.check.length === 1 ? "" : "s"}`);
		return parts.join(" · ");
	},
	inspect_files: args => list((Array.isArray(args.requests) ? args.requests as Args[] : []).map(item => str(item.path).split(/[\\/]/).at(-1) ?? "").filter(Boolean)),
	todo_write: args => {
		if (!Array.isArray(args.todos)) return "";
		const todos = args.todos as Args[], current = todos.find(todo => todo.status === "in_progress");
		return current ? str(current.content) || str(current.activeForm) : `${todos.length} items`;
	},
	mcp: args => [str(args.server), str(args.tool) || str(args.search)].filter(Boolean).join(" · "),
	update_plan: args => [str(args.action), str(args.objective)].filter(Boolean).join(": "),
	update_goal: args => [str(args.action), str(args.objective) || str(args.blocked_reason)].filter(Boolean).join(": "),
	wait_agent: args => Array.isArray(args.ids) ? list(args.ids.map(String)) : "",
	wait_for_work: args => Array.isArray(args.targets) ? list(args.targets.map(String)) : "",
};
for (const name of ["party_send", "agent_send", "send_message", "followup_task"])
	READERS[name] = args => [str(args.to) || str(args.target) || str(args.subagent_id), str(args.message)].filter(Boolean).join(" ← ");
READERS.patch_and_run = READERS.apply_patch!;

/** Fields that usually say what a call is about, in order of preference. */
const KEYS = ["path", "cmd", "command", "code", "url", "expression", "query", "q", "pattern", "question", "objective", "task_name", "message", "prompt", "description", "name", "label", "action", "artifact", "to", "target", "input"];

export function toolArgumentPreview(name: string, serialized?: string): string {
	if (!serialized) return "";
	const args = parse(serialized);
	const specific = READERS[name]?.(args);
	if (specific) return line(specific);
	for (const key of KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return line(key === "code" || key === "input" ? firstStatement(value) : value);
	}
	const first = Object.values(args).find(value => typeof value === "string" && value.trim());
	return typeof first === "string" ? line(first) : "";
}

/** The heading or opening line of a reasoning summary, without Markdown emphasis. */
export function thinkingPreview(text: string): string {
	const first = text.split("\n").map(value => value.trim()).find(Boolean) ?? "";
	return line(first.replace(/^#+\s*/, "").replace(/\*\*|__|`/g, ""));
}
