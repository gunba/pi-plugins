/** Labels observed skill-file reads; this does not claim the model followed the skill. */
export function readSkills(tool: string, args: unknown): string[] {
	if (typeof args === "string") {
		try { args = JSON.parse(args); } catch { return []; }
	}
	if (!args || typeof args !== "object") return [];
	const input = args as Record<string, unknown>;
	const paths = tool === "read" ? [input.path]
		: tool === "inspect_files" && Array.isArray(input.requests)
			? input.requests.slice(0, 20).map(item => item && typeof item === "object" ? item.path : undefined) : [];
	return [...new Set(paths.flatMap(path => {
		if (typeof path !== "string") return [];
		const parts = path.replaceAll("\\", "/").split("/");
		if (parts.at(-1) !== "SKILL.md") return [];
		const directory = parts.at(-2);
		return [directory && directory !== "." && directory !== ".." ? directory.slice(0, 160) : "SKILL.md"];
	}))];
}
