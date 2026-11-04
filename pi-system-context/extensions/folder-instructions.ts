import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ancestors, listing, SAVED_HEADER, sharedTools, syntaxError, toolsFolder } from "../../pi-tools/saved.ts";

/** The names Pi reads instructions from, in the order it prefers within one folder. */
const NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const FILE_TOOLS = new Set(["read", "edit", "write"]);
/** One folder's instructions are cut here; the agent can read the rest. */
const MAX_CHARS = 24_000;
const HEADER = /^Instructions for files under (.+) \(from (.+)\):$/gm;

const within = (folder: string, path: string) => { const step = relative(folder, path); return !step.startsWith("..") && !isAbsolute(step); };

/**
 * Pi loads instructions (AGENTS.md and the like) from the folder a conversation started in and the folders above it.
 * An agent that reads or edits a file elsewhere gets that folder's instructions, and its parents', once, with the
 * tool's result; inside a program they follow the program's output, so the data the program reads stays as it was.
 * They are tool output rather than system prompt, so the prompt cache is kept, and they are added again after a
 * compaction removes them.
 *
 * Saved tools (pi-tools/saved.ts) are listed the same way: a folder's with its instructions, and those of the
 * conversation's folder and for every folder with the conversation's first tool result. A saved tool written with a
 * syntax error is reported with the write.
 */
export default function folderInstructions(pi: ExtensionAPI): void {
	let loaded: Set<string> | undefined, startListed = false;
	const shown = new Set<string>(), shownTools = new Set<string>(), pending = new Map<string, string[]>();
	const forget = () => { shown.clear(); shownTools.clear(); startListed = false; };
	const rebuild = (ctx: ExtensionContext) => {
		forget(); pending.clear();
		for (const entry of ctx.sessionManager.getBranch() as { type: string; message?: { role?: string; content?: unknown } }[]) {
			if (entry.type === "compaction") { forget(); continue; }
			if (entry.type !== "message" || entry.message?.role !== "toolResult" || !Array.isArray(entry.message.content)) continue;
			for (const part of entry.message.content as { type: string; text?: string }[]) {
				if (part.type !== "text" || !part.text) continue;
				for (const match of part.text.matchAll(HEADER)) shown.add(match[2]!);
				for (const match of part.text.matchAll(SAVED_HEADER)) shownTools.add(match[1]!);
			}
		}
	};
	pi.on("session_start", (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", (_event, ctx) => rebuild(ctx));
	pi.on("session_compact", forget);
	/** The listings not yet in the conversation of these tools folders' saved tools. */
	const savedListings = (folders: string[]): string[] => {
		const operations = new Set(pi.getAllTools().map(tool => tool.name));
		return folders.flatMap(tools => {
			if (shownTools.has(tools)) return [];
			const text = listing(tools, operations);
			if (!text) return [];
			shownTools.add(tools);
			return [text];
		});
	};
	pi.on("before_agent_start", event => {
		const files = event.systemPromptOptions?.contextFiles;
		loaded = files ? new Set(files.map(file => resolve(file.path))) : undefined;
	});
	/** The instructions not yet in the conversation for the folders from the top of the disk down to the file's. */
	const instructions = (path: string, cwd: string): string[] => {
		if (!loaded) return [];
		const folders: string[] = [];
		for (let folder = dirname(path); ; folder = dirname(folder)) {
			// Pi loaded the conversation's own folder and those above it.
			if (!within(folder, cwd)) folders.unshift(folder);
			if (folder === parse(folder).root) break;
		}
		return folders.flatMap(folder => {
			const name = NAMES.find(item => existsSync(join(folder, item)));
			const file = name && join(folder, name);
			const tools = savedListings([toolsFolder(folder)]);
			if (!file || loaded!.has(file) || shown.has(file)) return tools;
			let text: string;
			try { text = readFileSync(file, "utf8"); } catch { return tools; }
			shown.add(file);
			const cut = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (cut at ${MAX_CHARS} characters; read the file for the rest)` : text;
			return [`Instructions for files under ${folder} (from ${file}):\n${cut.trim()}`, ...tools];
		});
	};
	pi.on("tool_result", (event, ctx) => {
		const extra = pending.get(event.toolCallId) ?? [];
		pending.delete(event.toolCallId);
		const input = event.input as { path?: unknown } | undefined;
		if (FILE_TOOLS.has(event.toolName) && !event.isError && typeof input?.path === "string" && input.path) {
			const given = input.path.replace(/^@/, "");
			const path = resolve(ctx.cwd, given === "~" || given.startsWith("~/") ? join(homedir(), given.slice(1)) : given);
			const found = instructions(path, ctx.cwd);
			// A saved tool just written or edited is checked, so its author hears of a syntax error before it is called.
			const folder = dirname(path);
			if (event.toolName !== "read" && path.endsWith(".js") && (folder === toolsFolder(dirname(dirname(folder))) || folder === sharedTools())) {
				let error: string | undefined;
				try { error = syntaxError(readFileSync(path, "utf8")); } catch { /* removed meanwhile */ }
				if (error) found.push(`Saved tool ${path} has a syntax error, so calls to it fail: ${error}`);
			}
			if (found.length && event.parentToolCallId) { pending.set(event.parentToolCallId, [...pending.get(event.parentToolCallId) ?? [], ...found]); return; }
			extra.push(...found);
		}
		// The conversation's first result lists the saved tools of its folder, those above it, and for every folder.
		if (!event.parentToolCallId && !startListed && loaded) {
			startListed = true;
			extra.push(...savedListings([...ancestors(ctx.cwd).map(toolsFolder), sharedTools()]));
		}
		if (!extra.length) return;
		return { content: [...event.content, ...extra.map(text => ({ type: "text" as const, text }))], structuredContent: event.structuredContent };
	});
}
