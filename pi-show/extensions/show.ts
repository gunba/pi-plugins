import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChangeTracker, READ_ONLY, type CallChanges } from "./changes.ts";
import { diffOffice, officeKind, previewOffice, readOffice, unlistedCells } from "./documents.ts";
import { lineDiff } from "./sequence-diff.ts";
import type { DocumentChange, Shown, ShownItem } from "./types.ts";

export type { DocumentChange, Shown, ShownItem };


const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT_LIMIT = 2 * 1024 * 1024, OFFICE_LIMIT = 64 * 1024 * 1024;
const COMMAND_TOOLS = new Set(["bash", "exec_command", "powershell", "codemode", "patch_and_run"]);
const EXTENSION = String.raw`\.(?:xlsx|xlsm|docx|docm|pptx|pptm)`;
const DOCUMENT_PATH = new RegExp(String.raw`"([^"\n]+?${EXTENSION})"|'([^'\n]+?${EXTENSION})'|([^\s"'\x60|;&<>(),]+?${EXTENSION})(?![\w.])`, "gi");
const SCRIPT_PATH = /(?:"([^"\n]+?\.(?:py|js|mjs|cjs|ts|ps1|sh|r|jl))"|'([^'\n]+?\.(?:py|js|mjs|cjs|ts|ps1|sh|r|jl))'|([^\s"'`|;&<>()]+?\.(?:py|js|mjs|cjs|ts|ps1|sh|r|jl)))(?![\w.])/gi;

const expand = (path: string) => path === "~" ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path.replace(/^\$HOME(?=[\\/])/, homedir());
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;

/** Office files a command or script names, resolved against the folder it runs in (after any leading cd). */
export function mentionedDocuments(text: string, cwd: string, readScript: (path: string) => string | undefined = path => {
	try { return statSync(path).size <= 256 * 1024 ? readFileSync(path, "utf8") : undefined; } catch { return; }
}): string[] {
	const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/.exec(text)?.[1]?.replace(/^["']|["']$/g, "");
	const base = cd ? resolve(cwd, expand(cd)) : cwd, found = new Set<string>();
	const collect = (source: string, folder: string) => {
		for (const match of source.matchAll(DOCUMENT_PATH)) if (found.size < 24) found.add(resolve(folder, expand(match[1] ?? match[2] ?? match[3]!)));
	};
	collect(text, base);
	for (const match of text.matchAll(SCRIPT_PATH)) {
		const script = resolve(base, expand(match[1] ?? match[2] ?? match[3]!)), source = readScript(script);
		if (source) collect(source, base);
	}
	return [...found];
}

type Version = { exists: boolean; size?: number; mtimeMs?: number; data?: Buffer };
function version(path: string, limit: number): Version {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return { exists: false };
		return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ...(stat.size <= limit ? { data: readFileSync(path) } : {}) };
	} catch { return { exists: false }; }
}
const textual = (data: Buffer) => !data.subarray(0, 8192).includes(0);

/** The first version of each file the agent touched in a conversation, so later changes can be shown against it. */
class Baselines {
	private directory: string;
	private index: Record<string, string | null>;
	constructor(directory: string) {
		this.directory = directory;
		try { this.index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")); } catch { this.index = {}; }
	}
	remember(path: string, before: Version): void {
		if (path in this.index || before.exists && !before.data) return;
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		if (before.data) { const id = sha(before.data); writeFileSync(join(this.directory, id), before.data, { mode: 0o600 }); this.index[path] = id; }
		else this.index[path] = null;
		writeFileSync(join(this.directory, "index.json"), JSON.stringify(this.index), { mode: 0o600 });
	}
	/** Undefined when untracked; null when the file did not exist at first. */
	first(path: string): Buffer | null | undefined {
		const id = this.index[path];
		if (id === undefined) return;
		if (id === null) return null;
		try { return readFileSync(join(this.directory, id)); } catch { return; }
	}
}

/** Changes between two versions of an Office file, or a summary of a new one. */
export function documentChange(path: string, before: Buffer | null, after: Buffer): DocumentChange | undefined {
	const kind = officeKind(path);
	if (!kind) return;
	const now = readOffice(after, kind);
	if (!before) {
		const preview = previewOffice(now);
		const summary = now.kind === "xlsx" ? `New workbook: ${now.sheets.length} sheet${now.sheets.length === 1 ? "" : "s"}`
			: now.kind === "docx" ? `New document: ${now.paragraphs.filter(text => text.trim()).length} paragraphs` : `New deck: ${now.slides.length} slides`;
		return { path, kind, created: true, summary, preview };
	}
	const changes = diffOffice(readOffice(before, kind), now);
	return changes && { path, kind, summary: changes.summary, changes };
}

// Declared in every request, so kept short.
const SHOW_PARAMETERS = Type.Object({
	title: Type.String(),
	note: Type.Optional(Type.String({ description: "Markdown" })),
	items: Type.Optional(Type.Array(Type.Object({
		file: Type.Optional(Type.String()),
		focus: Type.Optional(Type.String({ description: "Sheet!range, text to start at, or lines 40-80" })),
		changes: Type.Optional(Type.Array(Type.Object({ where: Type.String(), before: Type.Optional(Type.String()), after: Type.Optional(Type.String()) }))),
	}))),
});

/** Waits for a promise for at most `ms`; the work carries on after that, the caller does not wait for it. */
const bounded = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
	Promise.race([promise, new Promise<undefined>(done => { (setTimeout(done, ms) as unknown as { unref?: () => void }).unref?.(); })]);

export default function show(pi: ExtensionAPI) {
	const pending = new Map<string, Map<string, Version>>();
	const tracker = new ChangeTracker(join(getAgentDir(), "changes"), getAgentDir()), tracked = new Map<string, Promise<void>>();
	let baselines: Baselines | undefined, session = "";
	const store = (ctx: ExtensionContext) => {
		const id = ctx.sessionManager.getSessionId();
		if (!baselines || id !== session) { session = id; baselines = new Baselines(join(getAgentDir(), "show", id)); }
		return baselines;
	};

	pi.on("session_start", () => {
		// Baselines are kept for a month after a conversation last changed a file.
		const root = join(getAgentDir(), "show");
		try {
			for (const name of readdirSync(root)) {
				const path = join(root, name);
				if (Date.now() - statSync(path).mtimeMs > 30 * 86_400_000) rmSync(path, { recursive: true, force: true });
			}
		} catch { /* Nothing kept yet. */ }
		tracker.prune();
	});
	pi.on("session_shutdown", () => tracker.close());

	pi.on("tool_call", async (event, ctx) => {
		if (event.parentToolCallId) return;
		const input = event.input as Record<string, unknown>, paths: string[] = [];
		// Every call that may write is bracketed by snapshots of the folders the conversation works in.
		if (!READ_ONLY.has(event.toolName)) {
			const text = [input.command, input.cmd, input.code, input.input, input.chars, input.patch, input.path].filter(value => typeof value === "string").join("\n");
			const workdir = [input.workdir, input.cwd].find(value => typeof value === "string") as string | undefined;
			const started = tracker.start(event.toolCallId, text, ctx.cwd, ctx.sessionManager.getSessionId(), workdir).catch(() => undefined);
			tracked.set(event.toolCallId, started);
			// A first snapshot of a large folder may take a while; the call does not wait for it.
			await bounded(started, 3000);
		}
		if ((event.toolName === "write" || event.toolName === "edit") && typeof input.path === "string") paths.push(resolve(ctx.cwd, expand(input.path)));
		else if (COMMAND_TOOLS.has(event.toolName)) {
			const text = [input.command, input.cmd, input.code, input.input].filter(value => typeof value === "string").join("\n");
			if (/\.(?:xlsx|xlsm|docx|docm|pptx|pptm|py|js|mjs|cjs|ts|ps1|sh|r|jl)\b/i.test(text)) paths.push(...mentionedDocuments(text, ctx.cwd));
		}
		if (!paths.length) return;
		const before = new Map<string, Version>(), base = store(ctx);
		for (const path of paths) {
			const current = version(path, officeKind(path) ? OFFICE_LIMIT : TEXT_LIMIT);
			if (current.data && !officeKind(path) && !textual(current.data)) continue;
			before.set(path, current);
			try { base.remember(path, current); } catch { /* Showing changes later is optional. */ }
		}
		if (before.size) pending.set(event.toolCallId, before);
	});

	pi.on("tool_result", async (event, ctx) => {
		const started = tracked.get(event.toolCallId);
		tracked.delete(event.toolCallId);
		let changes: CallChanges | undefined;
		if (started) {
			const input = event.input ?? {};
			// Edits and writes report their own file; the snapshot reports anything else the call changed.
			const own = ["edit", "write"].includes(event.toolName) && typeof input.path === "string" ? [resolve(ctx.cwd, expand(input.path))]
				: Array.isArray((event.details as { changes?: unknown } | undefined)?.changes) ? ((event.details as { changes: { path?: unknown }[] }).changes)
					.flatMap(change => typeof change.path === "string" ? [resolve(ctx.cwd, change.path)] : []) : [];
			await bounded(started, 3000);
			changes = await bounded(tracker.finish(event.toolCallId, own).catch(() => undefined), 10_000);
		}
		const before = pending.get(event.toolCallId) ?? new Map<string, Version>();
		pending.delete(event.toolCallId);
		const documentChanges: DocumentChange[] = [];
		let written: { path: string; diff: NonNullable<ShownItem["diff"]>; created: boolean } | undefined;
		for (const [path, old] of before) {
			const office = !!officeKind(path), now = version(path, office ? OFFICE_LIMIT : TEXT_LIMIT);
			if (!now.exists || !now.data || old.exists && old.size === now.size && old.mtimeMs === now.mtimeMs && (!old.data || old.data.equals(now.data))) continue;
			if (old.exists && !old.data) continue;
			try {
				if (office) { const change = documentChange(path, old.data ?? null, now.data); if (change) documentChanges.push(change); }
				else if (event.toolName === "write" && textual(now.data)) {
					const diff = lineDiff(old.data?.toString("utf8") ?? "", now.data.toString("utf8"));
					if (diff) written = { path, diff, created: !old.exists };
				}
			} catch { /* A file that cannot be read as its type is left to the agent to describe. */ }
		}
		for (const document of changes?.documents ?? []) {
			if (documentChanges.some(change => change.path === document.path)) continue;
			try { const change = documentChange(document.path, document.before, document.after); if (change) documentChanges.push(change); } catch { /* Left to the agent to describe. */ }
		}
		const files = changes?.files.filter(file => file.path !== written?.path) ?? [];
		if (!documentChanges.length && !written && !files.length && !changes?.fromGit && !changes?.more) return;
		const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
		return { details: { ...details, ...(documentChanges.length ? { documentChanges } : {}),
			...(files.length ? { files } : {}), ...(changes?.fromGit ? { filesFromGit: changes.fromGit } : {}), ...(changes?.more ? { filesMore: changes.more.slice(0, 200) } : {}),
			...(written ? { diff: written.diff.text, path: written.path, added: written.diff.added, removed: written.diff.removed, ...(written.created ? { created: true } : {}) } : {}) } };
	});

	pi.registerTool({
		name: "show",
		label: "Show",
		description: "At key moments, show Jordan a result, work to review or what you changed in a file he uses; not routine steps. "
			+ "Desk renders files and computes your changes to them; use changes only for what files cannot show.",
		promptSnippet: "Show Jordan results and changes",
		parameters: SHOW_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const base = store(ctx), notes: string[] = [];
			const items = (params.items ?? []).slice(0, 12).map((item): ShownItem => {
				const shown: ShownItem = {};
				if (item.changes?.length) shown.described = item.changes.slice(0, 100).map(change => ({ where: clip(change.where, 300),
					...(change.before !== undefined ? { before: clip(change.before, 2000) } : {}), ...(change.after !== undefined ? { after: clip(change.after, 2000) } : {}) }));
				if (!item.file) return shown;
				const path = resolve(ctx.cwd, expand(item.file)), kind = officeKind(path);
				shown.path = path;
				const current = version(path, kind ? OFFICE_LIMIT : IMAGE.test(path) ? 0 : TEXT_LIMIT);
				if (!current.exists) { shown.missing = true; notes.push(`${item.file} was not found.`); return shown; }
				try {
					if (IMAGE.test(path)) shown.kind = "image";
					else if (kind && current.data) {
						shown.kind = "office";
						const first = base.first(path);
						if (first !== undefined) shown.changes = (first === null ? undefined : diffOffice(readOffice(first, kind), readOffice(current.data, kind)));
						if (!shown.changes || item.focus) shown.preview = previewOffice(readOffice(current.data, kind), item.focus);
						if (shown.changes?.kind === "xlsx" && shown.described) {
							const missed = unlistedCells(shown.changes, shown.described.map(change => change.where));
							if (missed.length) {
								shown.unlisted = { count: missed.length, examples: missed.slice(0, 5).map(cell => `${cell.sheet}!${cell.cell}`) };
								notes.push(`${basename(path)}: Desk found ${missed.length} changed cell${missed.length === 1 ? "" : "s"} you did not list (${shown.unlisted.examples.join(", ")}${missed.length > 5 ? ", …" : ""}).`);
							}
						}
					} else if (current.data && textual(current.data)) {
						shown.kind = "text";
						const text = current.data.toString("utf8"), first = base.first(path);
						const diff = first !== undefined ? lineDiff(first?.toString("utf8") ?? "", text) : undefined;
						if (diff && !item.focus) shown.diff = diff;
						else {
							const lines = text.split(/\r?\n/), range = /^(?:L)?(\d+)(?:\s*[-:]\s*L?(\d+))?$/i.exec(item.focus?.trim() ?? "");
							const start = range ? Math.max(1, Number(range[1])) : Math.max(1, lines.findIndex(line => item.focus && line.includes(item.focus)) + 1);
							const end = range?.[2] ? Math.min(Number(range[2]), start + 199) : start + 59;
							shown.excerpt = { firstLine: start, text: lines.slice(start - 1, end).join("\n").slice(0, 16_000), truncated: end < lines.length };
						}
					} else shown.kind = "file";
				} catch (error) {
					shown.kind = "file"; notes.push(`${basename(path)} could not be read as ${extname(path)}: ${error instanceof Error ? error.message : String(error)}`);
				}
				return shown;
			});
			const result: Shown = { title: clip(params.title, 200), ...(params.note ? { note: clip(params.note, 20_000) } : {}), items };
			return { content: [{ type: "text", text: [`Shown to Jordan in Desk: ${result.title}.`, ...notes].join("\n") }], details: { show: result } };
		},
	});
}

