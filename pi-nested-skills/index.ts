import type { BuildSystemPromptOptions, ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const EXTENSION_NAME = "pi-nested-skills";
const AVAILABLE_OPEN = "<available_skills>";
const AVAILABLE_CLOSE = "</available_skills>";

type FrontmatterValue = string | unknown[] | Record<string, unknown> | boolean | number | null | undefined;
type Frontmatter = Record<string, FrontmatterValue>;

type SkillInfo = {
	skill: Skill;
	frontmatter: Frontmatter;
	parents: string[];
	unresolvedParents: string[];
};

type NestedSkillGraph = {
	visible: SkillInfo[];
	byName: Map<string, SkillInfo>;
	childrenByParent: Map<string, SkillInfo[]>;
	roots: SkillInfo[];
	unresolved: SkillInfo[];
	relationCount: number;
};

type Mode = "defer" | "collapse" | "map" | "off";

const PARENT_KEYS = [
	"parent_skill",
	"parent_skills",
	"parentSkill",
	"parentSkills",
	"parent",
	"parents",
	"skill_parent",
	"skill_parents",
	"skillParent",
	"skillParents",
	"category_skill",
	"category_skills",
	"category",
	"categories",
	"tagged_with",
	"taggedWith",
	"skill_tags",
	"skillTags",
	"tags",
	"skills",
];

function modeFromEnv(): Mode {
	const raw = (process.env.PI_NESTED_SKILLS_MODE ?? "defer").trim().toLowerCase();
	if (["off", "false", "0", "no", "disabled"].includes(raw)) return "off";
	if (["map", "append", "annotate", "annotation"].includes(raw)) return "map";
	if (["collapse", "nested", "tree", "full"].includes(raw)) return "collapse";
	return "defer";
}

function normalizeSkillName(value: string): string | undefined {
	const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
	if (!trimmed) return undefined;
	return trimmed;
}

function splitScalar(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((part) => normalizeSkillName(part))
			.filter(Boolean) as string[];
	}

	if (trimmed.includes(",")) {
		return trimmed
			.split(",")
			.map((part) => normalizeSkillName(part))
			.filter(Boolean) as string[];
	}

	const single = normalizeSkillName(trimmed);
	return single ? [single] : [];
}

function addUnique(target: string[], values: string[]) {
	for (const value of values) {
		if (!target.includes(value)) target.push(value);
	}
}

function valuesFromUnknown(value: unknown): string[] {
	if (typeof value === "string") return splitScalar(value);
	if (Array.isArray(value)) {
		const result: string[] = [];
		for (const entry of value) addUnique(result, valuesFromUnknown(entry));
		return result;
	}
	return [];
}

function stripYamlComment(line: string): string {
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if ((char === "'" || char === '"') && line[i - 1] !== "\\") {
			quote = quote === char ? undefined : quote ?? char;
		}
		if (char === "#" && !quote && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
			return line.slice(0, i).trimEnd();
		}
	}
	return line;
}

function parseScalar(raw: string): string | string[] | boolean | number | null {
	const value = stripYamlComment(raw).trim();
	if (!value || value === "null" || value === "~") return null;
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	if (value.startsWith("[") && value.endsWith("]")) return splitScalar(value);
	return value.replace(/^['"]|['"]$/g, "");
}

function parseSimpleFrontmatter(raw: string): Frontmatter {
	const normalized = raw.replace(/^\uFEFF/, "");
	const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};

	const frontmatter: Frontmatter = {};
	const lines = match[1].split(/\r?\n/);
	let currentTopKey: string | undefined;
	let currentNestedKey: string | undefined;

	for (const originalLine of lines) {
		if (!originalLine.trim() || originalLine.trimStart().startsWith("#")) continue;
		const indent = originalLine.match(/^\s*/)?.[0].length ?? 0;
		const line = stripYamlComment(originalLine).trimEnd();
		if (!line.trim()) continue;

		const arrayItem = line.trim().match(/^-\s+(.+)$/);
		if (arrayItem && currentTopKey) {
			const targetContainer = frontmatter[currentTopKey];
			if (currentNestedKey && targetContainer && typeof targetContainer === "object" && !Array.isArray(targetContainer)) {
				const nested = targetContainer as Record<string, unknown>;
				const existing = nested[currentNestedKey];
				const next = parseScalar(arrayItem[1]);
				nested[currentNestedKey] = Array.isArray(existing) ? [...existing, next] : [next];
			} else {
				const existing = frontmatter[currentTopKey];
				const next = parseScalar(arrayItem[1]);
				frontmatter[currentTopKey] = Array.isArray(existing) ? [...existing, next] : [next];
			}
			continue;
		}

		const keyValue = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!keyValue) continue;

		const [, key, rawValue] = keyValue;
		if (indent === 0) {
			currentTopKey = key;
			currentNestedKey = undefined;
			frontmatter[key] = rawValue.trim() === "" ? {} : parseScalar(rawValue);
			continue;
		}

		if (!currentTopKey) continue;
		if (!frontmatter[currentTopKey] || typeof frontmatter[currentTopKey] !== "object" || Array.isArray(frontmatter[currentTopKey])) {
			frontmatter[currentTopKey] = {};
		}
		const container = frontmatter[currentTopKey] as Record<string, unknown>;
		container[key] = rawValue.trim() === "" ? [] : parseScalar(rawValue);
		currentNestedKey = key;
	}

	return frontmatter;
}

function readFrontmatter(filePath: string): Frontmatter {
	try {
		if (!existsSync(filePath)) return {};
		return parseSimpleFrontmatter(readFileSync(filePath, "utf8"));
	} catch {
		return {};
	}
}

function extractParentTags(frontmatter: Frontmatter): string[] {
	const values: string[] = [];
	const metadata = frontmatter.metadata && typeof frontmatter.metadata === "object" && !Array.isArray(frontmatter.metadata)
		? (frontmatter.metadata as Record<string, unknown>)
		: undefined;

	for (const key of PARENT_KEYS) {
		if (metadata && key in metadata) addUnique(values, valuesFromUnknown(metadata[key]));
		if (key in frontmatter) addUnique(values, valuesFromUnknown(frontmatter[key]));
	}

	return values;
}

function mergeSkills(primary: Skill[], fallback: Skill[]): Skill[] {
	const byName = new Map<string, Skill>();
	for (const skill of fallback) byName.set(skill.name, skill);
	for (const skill of primary) byName.set(skill.name, skill);
	return [...byName.values()];
}

function shouldRenderAsPromptRoot(info: SkillInfo, graph: NestedSkillGraph): boolean {
	return info.parents.length === 0 && (!info.skill.disableModelInvocation || childCount(graph, info.skill.name) > 0);
}

function buildGraph(skills: Skill[]): NestedSkillGraph {
	const byName = new Map<string, SkillInfo>();
	for (const skill of skills) {
		const frontmatter = readFrontmatter(skill.filePath);
		byName.set(skill.name, {
			skill,
			frontmatter,
			parents: [],
			unresolvedParents: [],
		});
	}

	for (const info of byName.values()) {
		const declared = extractParentTags(info.frontmatter).filter((name) => name !== info.skill.name);
		for (const parent of declared) {
			if (byName.has(parent)) info.parents.push(parent);
			else info.unresolvedParents.push(parent);
		}
	}

	const childrenByParent = new Map<string, SkillInfo[]>();
	let relationCount = 0;
	for (const info of byName.values()) {
		for (const parent of info.parents) {
			const children = childrenByParent.get(parent) ?? [];
			children.push(info);
			childrenByParent.set(parent, children);
			relationCount++;
		}
	}

	for (const children of childrenByParent.values()) {
		children.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
	}

	const roots = [...byName.values()]
		.filter((info) => info.parents.length === 0)
		.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
	const unresolved = [...byName.values()]
		.filter((info) => info.unresolvedParents.length > 0)
		.sort((a, b) => a.skill.name.localeCompare(b.skill.name));

	return {
		visible: [...byName.values()].sort((a, b) => a.skill.name.localeCompare(b.skill.name)),
		byName,
		childrenByParent,
		roots,
		unresolved,
		relationCount,
	};
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function renderSkill(info: SkillInfo, graph: NestedSkillGraph, depth = 1, ancestors = new Set<string>()): string[] {
	const indent = "  ".repeat(depth);
	const childIndent = "  ".repeat(depth + 1);
	const lines = [
		`${indent}<skill>`,
		`${childIndent}<name>${escapeXml(info.skill.name)}</name>`,
		`${childIndent}<description>${escapeXml(info.skill.description)}</description>`,
		`${childIndent}<location>${escapeXml(info.skill.filePath)}</location>`,
	];

	const children = graph.childrenByParent.get(info.skill.name) ?? [];
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(info.skill.name);
	const renderableChildren = children.filter((child) => !nextAncestors.has(child.skill.name));
	if (renderableChildren.length > 0) {
		lines.push(`${childIndent}<children>`);
		for (const child of renderableChildren) {
			lines.push(...renderSkill(child, graph, depth + 2, nextAncestors));
		}
		lines.push(`${childIndent}</children>`);
	}

	const cyclicChildren = children.filter((child) => nextAncestors.has(child.skill.name));
	if (cyclicChildren.length > 0) {
		lines.push(`${childIndent}<cycle-warning>${escapeXml(cyclicChildren.map((child) => child.skill.name).join(", "))}</cycle-warning>`);
	}

	lines.push(`${indent}</skill>`);
	return lines;
}

function childCount(graph: NestedSkillGraph, skillName: string): number {
	return graph.childrenByParent.get(skillName)?.length ?? 0;
}

function renderDeferredSkill(info: SkillInfo, graph: NestedSkillGraph, depth = 1): string[] {
	const indent = "  ".repeat(depth);
	const childIndent = "  ".repeat(depth + 1);
	const lines = [
		`${indent}<skill>`,
		`${childIndent}<name>${escapeXml(info.skill.name)}</name>`,
		`${childIndent}<description>${escapeXml(info.skill.description)}</description>`,
		`${childIndent}<location>${escapeXml(info.skill.filePath)}</location>`,
	];

	const children = graph.childrenByParent.get(info.skill.name) ?? [];
	if (children.length > 0) {
		lines.push(`${childIndent}<child_skills count="${children.length}">${escapeXml(children.map((child) => child.skill.name).join(", "))}</child_skills>`);
		lines.push(`${childIndent}<child_details>Call nested_skill_children with parent=${escapeXml(JSON.stringify(info.skill.name))} for child descriptions and SKILL.md paths.</child_details>`);
	}

	lines.push(`${indent}</skill>`);
	return lines;
}

function renderDeferredAvailableSkills(graph: NestedSkillGraph): string {
	const lines = [AVAILABLE_OPEN];
	const rendered = new Set<string>();

	for (const root of graph.roots) {
		if (!shouldRenderAsPromptRoot(root, graph)) continue;
		lines.push(...renderDeferredSkill(root, graph, 1));
		collectRendered(root, graph, rendered);
	}

	// If every skill in a component has a parent, that component may be cyclic. Keep one visible entry.
	for (const info of graph.visible) {
		if (rendered.has(info.skill.name)) continue;
		if (info.skill.disableModelInvocation && childCount(graph, info.skill.name) === 0) continue;
		lines.push(...renderDeferredSkill(info, graph, 1));
		collectRendered(info, graph, rendered);
	}

	lines.push(AVAILABLE_CLOSE);
	lines.push("");
	lines.push("Nested skill note: child skill names under a parent are shown in the initial prompt, but child descriptions and SKILL.md paths are deferred. Call nested_skill_children with a parent name when you need to choose or load a child skill. Child skills remain standalone /skill:name commands with their original SKILL.md files, so other Agent Skills clients that ignore metadata keep loading them normally.");
	return lines.join("\n");
}

function renderNestedAvailableSkills(graph: NestedSkillGraph): string {
	const lines = [AVAILABLE_OPEN];
	const rendered = new Set<string>();

	for (const root of graph.roots) {
		lines.push(...renderSkill(root, graph, 1));
		collectRendered(root, graph, rendered);
	}

	// If every skill in a component has a parent, that component may be cyclic. Keep it visible.
	for (const info of graph.visible) {
		if (rendered.has(info.skill.name)) continue;
		lines.push(...renderSkill(info, graph, 1));
		collectRendered(info, graph, rendered);
	}

	lines.push(AVAILABLE_CLOSE);
	lines.push("");
	lines.push("Nested skill note: skills may be grouped under parent skills when their Agent Skills frontmatter metadata tags name another loaded skill. These relationships are routing hints only. Every child remains a standalone skill with its own /skill:name command and SKILL.md path, so the same files continue to work in clients that ignore the metadata.");
	return lines.join("\n");
}

function collectRendered(info: SkillInfo, graph: NestedSkillGraph, rendered: Set<string>, ancestors = new Set<string>()) {
	if (ancestors.has(info.skill.name)) return;
	rendered.add(info.skill.name);
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(info.skill.name);
	for (const child of graph.childrenByParent.get(info.skill.name) ?? []) {
		collectRendered(child, graph, rendered, nextAncestors);
	}
}

function replaceAvailableSkillsBlock(prompt: string, replacement: string): string {
	const start = prompt.indexOf(AVAILABLE_OPEN);
	const closeStart = prompt.indexOf(AVAILABLE_CLOSE, start);
	if (start === -1 || closeStart === -1) {
		return `${prompt}\n\n${replacement}`;
	}
	const end = closeStart + AVAILABLE_CLOSE.length;
	return `${prompt.slice(0, start)}${replacement}${prompt.slice(end)}`;
}

function renderMap(graph: NestedSkillGraph): string {
	const lines = [
		"## Nested Skill Map",
		"Skills tagged with another loaded skill in frontmatter metadata are grouped here as routing hints. Child skills remain standalone and compatible with clients that ignore the metadata.",
		"",
	];

	for (const parent of [...graph.childrenByParent.keys()].sort()) {
		const children = graph.childrenByParent.get(parent) ?? [];
		lines.push(`- ${parent}: ${children.map((child) => child.skill.name).join(", ")}`);
	}

	return lines.join("\n");
}

function summariseGraph(graph: NestedSkillGraph): string {
	if (graph.relationCount === 0) {
		return "Nested skills: no loaded skills currently declare a parent skill tag.";
	}

	const groups = [...graph.childrenByParent.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([parent, children]) => `${parent} (${children.length}): ${children.map((child) => child.skill.name).join(", ")}`);

	const unresolved = graph.unresolved.length === 0
		? []
		: ["", "Unresolved tags:", ...graph.unresolved.map((info) => `- ${info.skill.name}: ${info.unresolvedParents.join(", ")}`)];

	return [
		`Nested skills: ${graph.relationCount} relationship(s) across ${graph.childrenByParent.size} parent skill(s).`,
		...groups,
		...unresolved,
	].join("\n");
}

function skillsFromCommands(pi: ExtensionAPI): Skill[] {
	return pi.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => {
			const frontmatter = readFrontmatter(command.sourceInfo.path);
			const name = typeof frontmatter.name === "string" ? frontmatter.name : command.name.replace(/^skill:/, "");
			const description = typeof frontmatter.description === "string" ? frontmatter.description : command.description ?? "";
			return {
				name,
				description,
				filePath: command.sourceInfo.path,
				baseDir: command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path),
				sourceInfo: command.sourceInfo,
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			};
		});
}

function collectChildren(graph: NestedSkillGraph, parent: string, recursive: boolean, ancestors = new Set<string>()): SkillInfo[] {
	if (ancestors.has(parent)) return [];
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(parent);
	const direct = graph.childrenByParent.get(parent) ?? [];
	if (!recursive) return direct;

	const result: SkillInfo[] = [];
	for (const child of direct) {
		result.push(child);
		result.push(...collectChildren(graph, child.skill.name, true, nextAncestors));
	}
	return result;
}

function escapeMarkdown(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function renderChildToolResult(parent: string | undefined, graph: NestedSkillGraph, recursive: boolean): string {
	if (!parent) {
		const lines = ["## Nested skill groups", ""];
		for (const [name, children] of [...graph.childrenByParent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			lines.push(`- **${escapeMarkdown(name)}** (${children.length}): ${children.map((child) => child.skill.name).join(", ")}`);
		}
		lines.push("", "Call `nested_skill_children` with a `parent` name to get child descriptions and SKILL.md paths.");
		return lines.join("\n");
	}

	const parentInfo = graph.byName.get(parent);
	if (!parentInfo) {
		return `No loaded skill named ${JSON.stringify(parent)}. Call nested_skill_children without a parent to list available parent skill groups.`;
	}

	const children = collectChildren(graph, parent, recursive);
	if (children.length === 0) {
		return `Skill ${JSON.stringify(parent)} has no nested child skills.`;
	}

	const lines = [`## ${escapeMarkdown(parent)} child skills (${children.length})`, ""];
	for (const child of children) {
		lines.push(`- **${escapeMarkdown(child.skill.name)}**: ${escapeMarkdown(child.skill.description)}`);
		lines.push(`  - SKILL.md: \`${child.skill.filePath}\``);
		const nestedCount = childCount(graph, child.skill.name);
		if (nestedCount > 0) lines.push(`  - Nested children: ${nestedCount}`);
	}
	lines.push("", "To use one of these skills, read its SKILL.md path above. The files remain standard Agent Skills; this tool only changes Pi's prompt routing.");
	return lines.join("\n");
}

const nestedSkillChildrenSchema = {
	type: "object",
	properties: {
		parent: {
			type: "string",
			description: "Parent skill name to inspect. Omit to list parent skill groups that have hidden child skills.",
		},
		recursive: {
			type: "boolean",
			description: "Include descendants below direct children. Default false.",
		},
	},
	additionalProperties: false,
};

function schemaHelp(): string {
	return [
		"Nested skill frontmatter schema (portable Agent Skills metadata):",
		"",
		"---",
		"name: rd-core",
		"description: Draft an R&D Tax Incentive Core Activity narrative...",
		"metadata:",
		"  parent_skill: rdtax",
		"---",
		"",
		"Multiple parents are also supported:",
		"",
		"metadata:",
		"  parent_skills:",
		"    - rdtax",
		"    - rsm-branding",
		"",
		"Aliases accepted under metadata: parent, parents, tags, skills, category, categories, skill_tags, tagged_with.",
		"Only values that exactly match another loaded skill name create a parent-child relationship; other tags are ignored by the nesting graph.",
		"Clients that do not implement this plugin should ignore metadata and continue loading the skill normally.",
	].join("\n");
}

export default function nestedSkills(pi: ExtensionAPI) {
	let lastGraph: NestedSkillGraph | undefined;
	let lastMode: Mode = modeFromEnv();

	pi.on("before_agent_start", async (event) => {
		lastMode = modeFromEnv();
		if (lastMode === "off") return;

		const graph = buildGraph(mergeSkills(event.systemPromptOptions.skills ?? [], skillsFromCommands(pi)));
		lastGraph = graph;
		if (graph.relationCount === 0) return;

		if (lastMode === "map") {
			return { systemPrompt: `${event.systemPrompt}\n\n${renderMap(graph)}` };
		}

		const replacement = lastMode === "collapse"
			? renderNestedAvailableSkills(graph)
			: renderDeferredAvailableSkills(graph);

		return {
			systemPrompt: replaceAvailableSkillsBlock(event.systemPrompt, replacement),
		};
	});

	pi.registerTool({
		name: "nested_skill_children",
		label: "Nested Skill Children",
		description: "Return compact Markdown details for nested child skills. The initial Pi prompt shows child names only; use this after selecting a parent/category skill to retrieve child descriptions and SKILL.md locations on demand.",
		parameters: nestedSkillChildrenSchema,
		async execute(_toolCallId, params) {
			const graph = buildGraph(skillsFromCommands(pi));
			lastGraph = graph;
			const parent = typeof params.parent === "string" && params.parent.trim() ? params.parent.trim() : undefined;
			const recursive = params.recursive === true;
			return {
				content: [{ type: "text", text: renderChildToolResult(parent, graph, recursive) }],
				details: { parent, recursive, relationCount: graph.relationCount },
			};
		},
	});

	pi.registerCommand("pi-nested-skills", {
		description: "Show nested skill grouping status and the portable frontmatter schema",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "schema" || command === "help") {
				ctx.ui.notify(schemaHelp(), "info");
				return;
			}

			if (!lastGraph) {
				lastGraph = buildGraph(skillsFromCommands(pi));
			}

			const lines = [
				`${EXTENSION_NAME} mode: ${lastMode}`,
				summariseGraph(lastGraph),
				"",
				"Commands: /pi-nested-skills status | schema",
				"Set PI_NESTED_SKILLS_MODE=defer (default), collapse, map, or off before launching Pi to change prompt behaviour.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
