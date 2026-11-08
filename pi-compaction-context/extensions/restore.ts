import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionProjection } from "@earendil-works/pi-coding-agent";
import { PLAN_READ, planText } from "../../pi-plan/extensions/plan.ts";
import { WATCH_ENTRY, describeWatch, watchList, type WatchSpec } from "../../pi-watch/index.ts";

/**
 * What Claude Code puts back after a summary, so the conversation does not have to find it again: the files it
 * worked on most recently, the skills it loaded, its plan and the background work still running.
 */

type AgentMessage = SessionProjection["messages"][number];
type Entry = SessionBeforeCompactEvent["branchEntries"][number];

// Claude Code's limits: 5 files of up to 5,000 tokens each, and skills of up to 5,000 tokens each and 25,000 in
// all, at Pi's estimate of 4 characters a token.
const FILES = 5, FILE_CHARS = 20_000, SKILL_CHARS = 20_000, SKILLS_CHARS = 100_000;
const FILE_TOOLS = new Set(["read", "edit", "write"]);
// Instructions files are already in the system prompt.
const INSTRUCTIONS = new Set(["AGENTS.md", "CLAUDE.md"]);
const BINARY = /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|png|jpe?g|gif|webp|bmp|ico|tiff?|zip|gz|tgz|xz|7z|rar|jar|mp[34]|wav|flac|ogg|mov|avi|mkv|woff2?|ttf|otf|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|sqlite3?|db)$/i;

/** The read, edit and write calls in a message, in order, with those codemode programs made (Pi records them on the program's result). */
export function fileCalls(message: AgentMessage): { name: string; path: string }[] {
	const calls: { name: string; arguments: unknown }[] = message.role === "toolResult" ? (message as { nestedCalls?: { calls?: { name: string; arguments: unknown }[] } }).nestedCalls?.calls ?? []
		: message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part] : []) : [];
	return calls.flatMap(call => {
		const path = (call.arguments as { path?: unknown } | undefined)?.path;
		return FILE_TOOLS.has(call.name) && typeof path === "string" && path ? [{ name: call.name, path }] : [];
	});
}

/** A tool's path argument as an absolute path; Pi's tools accept a leading @ and ~. */
export function absolute(path: string, cwd: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	return bare === "~" ? homedir() : bare.startsWith("~/") ? resolve(homedir(), bare.slice(2)) : resolve(cwd, bare);
}

const size = (bytes: number) => bytes < 1_048_576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;

/** Text in a Markdown fence longer than any run of backticks in it. */
function fenced(text: string, language: string): string {
	const fence = "`".repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1);
	return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}`;
}

/** A file's current text, or a note that it is too large; undefined when it is gone, a folder or not text. */
function fileSection(path: string): string | undefined {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || BINARY.test(path)) return;
		const large = `### ${path}\nRead before the summary, but too large to include here (${size(stat.size)}). Read it again if you need it.`;
		if (stat.size > FILE_CHARS * 4) return large;
		const buffer = readFileSync(path);
		if (buffer.includes(0)) return;
		const text = buffer.toString("utf8");
		return text.length > FILE_CHARS ? large : `### ${path}\n${fenced(text, extname(path).slice(1))}`;
	} catch { return; }
}

export interface Restored { text: string; files: string[]; skills: string[]; plan: boolean; watches: number }

/**
 * Sections to follow the summary. Files and skills come from the newest calls first and are read again now; those in
 * the kept messages are already in context. Skills come only from calls since the previous compaction (including the
 * messages it kept, which stayed in context): that compaction put back the ones read before it, and a skill not read
 * again since is no longer part of the work. Otherwise a conversation that runs for months carries every skill it ever
 * read, up to the cap, in every request; the system prompt still lists them all. The plan is current; the watches are
 * those still running: as pi-watch lists them for the session when it runs in this process (Desk runs them outside it),
 * else as the branch records them.
 */
export function restore(pi: ExtensionAPI, cwd: string, branch: readonly Entry[], kept: readonly AgentMessage[], sessionId?: string): Restored {
	const seen = new Set(kept.flatMap(message => fileCalls(message).map(call => absolute(call.path, cwd))));
	const files: string[] = [], skills: string[] = [];
	const since = previousSegment(branch);
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		for (const call of fileCalls(entry.message).reverse()) {
			const path = absolute(call.path, cwd);
			if (seen.has(path)) continue;
			seen.add(path);
			if (basename(path) === "SKILL.md") { if (index >= since) skills.push(path); }
			else if (!INSTRUCTIONS.has(basename(path)) && files.length < FILES) files.push(path);
		}
	}
	const sections: string[] = [];
	const fileParts: string[] = [], restoredFiles: string[] = [];
	for (const path of files) {
		const part = fileSection(path);
		if (part) { fileParts.push(part); restoredFiles.push(path); }
	}
	if (fileParts.length) sections.push(`## Files from before the summary\nTheir current contents, read again after the summary was written.\n\n${fileParts.join("\n\n")}`);
	const probe: { plan?: Parameters<typeof planText>[0] | null } = {};
	pi.events?.emit(PLAN_READ, probe);
	const plan = !!probe.plan && probe.plan.phase !== "complete";
	if (plan) sections.push(`## Plan\n${planText(probe.plan!)}`);
	let used = 0;
	const skillParts: string[] = [], restoredSkills: string[] = [];
	for (const path of skills) {
		let body: string;
		try { body = readFileSync(path, "utf8").trim(); } catch { continue; }
		if (body.length > SKILL_CHARS) body = `${body.slice(0, SKILL_CHARS)}\n\n[Truncated here. Read the file for the rest.]`;
		if (used + body.length > SKILLS_CHARS) continue;
		used += body.length;
		restoredSkills.push(path);
		skillParts.push(`### Skill: ${basename(dirname(path))}\nPath: ${path}\n\n${body}`);
	}
	if (skillParts.length) sections.push(`## Skills loaded earlier\nThese skills were loaded earlier in this conversation, before the summary, not on the current turn. They are here so their guidance still applies; do not repeat their one-time setup steps.\n\n${skillParts.join("\n\n---\n\n")}`);
	const watches = (sessionId ? watchList(sessionId) : undefined) ?? recordedWatches(branch);
	if (watches.length) sections.push(`## Watches still running\nEach reports back on its own:\n${watches.map(item => `- ${item}`).join("\n")}`);
	return { text: sections.join("\n\n"), files: restoredFiles, skills: restoredSkills, plan, watches: watches.length };
}

/**
 * The index of the first branch entry in context since the previous compaction: the first message it kept, or the
 * compaction itself when the kept message is not on the branch; 0 when there was none.
 */
function previousSegment(branch: readonly Entry[]): number {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "compaction") continue;
		const kept = branch.findIndex(other => other.id === entry.firstKeptEntryId);
		return kept >= 0 && kept < index ? kept : index;
	}
	return 0;
}

/** The watches a branch's records leave running, as pi-watch lists them ("w3: `make`"). */
function recordedWatches(branch: readonly Entry[]): string[] {
	const watches = new Map<string, WatchSpec>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
		const record = entry.data as { op?: string; watch?: WatchSpec; id?: string } | undefined;
		if (record?.op === "start" && record.watch) watches.set(record.watch.id, record.watch);
		else if (record?.op === "end" && record.id) watches.delete(record.id);
	}
	return [...watches.values()].map(spec => `${spec.id}: ${describeWatch(spec)}`);
}
