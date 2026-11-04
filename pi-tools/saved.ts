import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { getAgentDir, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

/**
 * Runs a program outside a codemode call, for pi-watch's program watches: pi-tools claims the request and answers with
 * the program's result as text. Extensions load their own copies of shared modules, so they meet on Pi's event bus.
 */
export const RUN_PROGRAM = "pi-tools:run-program";
export interface ProgramRun { ctx: ExtensionToolContext; code: string; signal: AbortSignal; claim(): void; done(text: string): void }

/**
 * Saved tools: programs an agent kept because they worked, called from later programs as tools.NAME(args). A folder's
 * are in its .pi/tools, and those for every folder in ~/.pi/agent/tools, one NAME.js each:
 *
 *   // Totals by category for one month of the ledger.
 *   // args: {month: "YYYY-MM", client?: string}
 *   const book = await tools.read({path: folder + "/ledger.xlsx"});
 *   ...
 *   return totals;
 *
 * The leading comment lines describe it; an "args:" line gives its arguments. The body runs inside the calling program
 * with args, tools and folder (the folder the tool belongs to), and what it returns is the call's result.
 */
export interface SavedTool { name: string; description: string; args: string; file: string; folder: string; source: string }

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Larger files are left out: a saved tool is a program, not data. */
const MAX_BYTES = 256 * 1024;
export const sharedTools = () => join(getAgentDir(), "tools");
export const toolsFolder = (folder: string) => join(folder, ".pi", "tools");
/** The folder a tools folder belongs to: the one holding its .pi, or the shared folder itself. */
export const owner = (tools: string) => tools === sharedTools() ? tools : dirname(dirname(tools));
/** A listing's first line; its folder is the tools folder. */
export const SAVED_HEADER = /^Saved tools for (?:files under .+|every folder) \(from (.+)\):$/gm;

export function parseSaved(file: string, source: string): SavedTool {
	const description: string[] = [];
	let args = "";
	for (const line of source.split(/\r?\n/)) {
		const comment = /^\s*\/\/\s?(.*)$/.exec(line);
		if (!comment) { if (line.trim()) break; continue; }
		const given = /^args:\s*(.*)$/i.exec(comment[1]!.trim());
		if (given) args = given[1]!; else if (!comment[1]!.startsWith("@options:")) description.push(comment[1]!.trim());
	}
	const tools = dirname(file);
	return { name: basename(file, ".js"), description: description.join(" ").trim(), args, file, folder: owner(tools), source };
}

/** The saved tools in one tools folder, by name. */
export function savedIn(tools: string): SavedTool[] {
	let names: string[];
	try { names = readdirSync(tools).filter(name => name.endsWith(".js") && NAME.test(name.slice(0, -3))).sort(); } catch { return []; }
	return names.flatMap(name => {
		const file = join(tools, name);
		try {
			if (statSync(file).size > MAX_BYTES) return [];
			return [parseSaved(file, readFileSync(file, "utf8"))];
		} catch { return []; }
	});
}

/** The folder and those above it, nearest first. */
export function ancestors(folder: string): string[] {
	const folders: string[] = [];
	for (let at = folder; ; at = dirname(at)) { folders.push(at); if (at === parse(at).root) break; }
	return folders;
}

type Entry = { type: string; message?: { role?: string; content?: unknown } };
/** The tools folders listed to the agent since the last compaction, latest first. */
export function listedFolders(branch: readonly Entry[]): string[] {
	let listed: string[] = [];
	for (const entry of branch) {
		if (entry.type === "compaction") { listed = []; continue; }
		if (entry.type !== "message" || entry.message?.role !== "toolResult" || !Array.isArray(entry.message.content)) continue;
		for (const part of entry.message.content as { type: string; text?: string }[])
			if (part.type === "text" && part.text?.includes("Saved tools for ")) for (const match of part.text.matchAll(SAVED_HEADER)) listed.push(match[1]!);
	}
	return [...new Set(listed.reverse())];
}

/**
 * The saved tools a program can call: those of the conversation's folder and the folders above it, nearest first, then
 * of the folders listed to the agent, then those for every folder. A name is taken by the first; an operation's name
 * can't be.
 */
export function visibleSaved(cwd: string, branch: readonly Entry[], operations: ReadonlySet<string>): SavedTool[] {
	const folders = [...new Set([...ancestors(cwd).map(toolsFolder), ...listedFolders(branch), sharedTools()])].filter(folder => existsSync(folder));
	const taken = new Set(operations), found: SavedTool[] = [];
	for (const folder of folders) for (const tool of savedIn(folder)) if (!taken.has(tool.name)) { taken.add(tool.name); found.push(tool); }
	return found;
}

/** Whether the body compiles as a program's async function; QuickJS accepts the same syntax. */
export function syntaxError(source: string): string | undefined {
	const AsyncFunction = (async () => {}).constructor as new (...parameters: string[]) => unknown;
	try { new AsyncFunction("args", "tools", "folder", source); return undefined; }
	catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** A tools folder's listing for the agent, or nothing when it has no saved tools. */
export function listing(tools: string, operations: ReadonlySet<string>): string | undefined {
	const saved = savedIn(tools);
	if (!saved.length) return undefined;
	const whose = tools === sharedTools() ? "every folder" : `files under ${owner(tools)}`;
	return [`Saved tools for ${whose} (from ${tools}):`, ...saved.map(tool => `- tools.${tool.name}(${tool.args || "{}"}): ${tool.description || "(no description)"}`
		+ (operations.has(tool.name) ? " [not callable: an operation has this name]" : "") + (syntaxError(tool.source) ? " [has a syntax error]" : ""))].join("\n");
}
