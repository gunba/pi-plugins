import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import {
	dirname,
	extname,
	isAbsolute,
	relative,
	resolve,
	toNamespacedPath,
} from "node:path";
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolRenderResultOptions,
	convertToPng,
	generateDiffString,
	renderDiff,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	normalizeProviderImageMessages,
	prepareNativeImageContent,
} from "./image-content.ts";
import { describeImageForTextModel } from "./image-description.ts";
import {
	type ImageGenerationDetails,
	type ImageGenerationParams,
	executeImageGeneration,
	prepareImageGenerationArguments,
} from "./image-generation.ts";
import { MAX_LOCAL_IMAGE_BYTES, readLocalImageFile } from "./image-limits.ts";
import {
	CODEX_COMPAT_TOOL_NAMES,
	type ToolActivationState,
	syncCodexCompatTools,
} from "./model-tools.ts";
import { repairSessionImageFile } from "./session-image-repair.ts";
import { extractShellApplyPatch } from "./shell-apply-patch.ts";
import {
	type ExecCommandDetails,
	createExecRuntimeOwner,
	executeManagedExecCommand,
	executeWriteStdin,
	prepareExecCommandArguments,
	prepareWriteStdinArguments,
	shutdownExecSessions,
	startExecSessionRuntime,
} from "./shell-runtime.ts";
import {
	prepareApplyPatchArguments,
	prepareViewImageArguments,
} from "./tool-arguments.ts";
import {
	formatApplyPatchCall,
	formatExecCommandCall,
	formatWriteStdinCall,
	liveOutputPreview,
	resultText,
	summarizeApplyPatchResult,
	summarizeExecResult,
} from "./tool-rendering.ts";
import codexUsage from "./usage.ts";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const EXTENSION_NAME = "pi-codex-compat";

const BLOCKED_HTTP_PATTERNS = [
	/\bfetch\s*\(/,
	/\brequests\.get\s*\(/,
	/\brequests\.post\s*\(/,
	/\bhttp\.get\s*\(/,
	/\bhttp\.request\s*\(/,
	/\burllib\.request/,
	/\bInvoke-WebRequest\b/,
];

type AddFileHunk = { type: "add"; path: string; contents: string };
type DeleteFileHunk = { type: "delete"; path: string };
type UpdateFileHunk = {
	type: "update";
	path: string;
	movePath?: string;
	chunks: UpdateFileChunk[];
};
type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

type UpdateFileChunk = {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
};

type ParsedPatch = {
	hunks: Hunk[];
	workdir?: string;
};

type PatchParseMode = "started" | "add" | "delete" | "update" | "ended";
type ApplyPatchDetails = {
	changes: ChangeRecord[];
	exitCode: 0 | 1;
	wallTimeSeconds: number;
	error?: string;
};

type FileState = { exists: boolean; content?: string };
type ChangeRecord = {
	action: "added" | "deleted" | "updated" | "moved";
	path: string;
	movePath?: string;
	diff: string;
};
type MoveRecord = { path: string; movePath: string };

class PatchApplicationError extends Error {
	readonly changes: ChangeRecord[];

	constructor(message: string, changes: ChangeRecord[]) {
		super(message);
		this.name = "PatchApplicationError";
		this.changes = changes;
	}
}

type ViewImageParams = { path: string };
type ViewImageDetails = {
	path: string;
	mediaType: string;
	bytes: number;
	describedBy?: string;
	error?: string;
};

function normalizePathArgument(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function resolveToolPath(baseDir: string, path: string): string {
	const normalized = normalizePathArgument(path);
	if (!normalized) throw new Error("path cannot be empty");
	return isAbsolute(normalized)
		? resolve(normalized)
		: resolve(baseDir, normalized);
}

function displayPathFromCwd(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath;
}

function displayPath(ctx: ExtensionContext, absolutePath: string): string {
	return displayPathFromCwd(ctx.cwd, absolutePath);
}

function interceptedPatchWorkdir(
	cwd: string,
	execWorkdir: string | undefined,
	shellWorkdir: string | undefined,
): string | undefined {
	const outer = execWorkdir ? resolveToolPath(cwd, execWorkdir) : cwd;
	if (shellWorkdir) return resolveToolPath(outer, shellWorkdir);
	return execWorkdir ? outer : undefined;
}

function stripQuotedContent(command: string): string {
	return command
		.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "")
		.replace(/'[^']*'/g, "''")
		.replace(/"[^"]*"/g, '""');
}

function isSafeCurlWget(segment: string): boolean {
	const s = segment.trim();
	const isCurl = /\bcurl\b/i.test(s);
	const isWget = /\bwget\b/i.test(s);
	if (!isCurl && !isWget) return true;

	const hasFileOutput = isCurl
		? /\s(-o|--output)\s/.test(s) || /\s>\s*/.test(s) || /\s>>\s*/.test(s)
		: /\s(-O|--output-document)\s/.test(s) ||
			/\s>\s*/.test(s) ||
			/\s>>\s*/.test(s);
	if (!hasFileOutput) return false;
	if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(s))
		return false;
	if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(s))
		return false;
	if (/\s(-v|--verbose|--trace)\b/.test(s)) return false;
	return isCurl
		? /\s-[a-zA-Z]*s|--silent/.test(s)
		: /\s-[a-zA-Z]*q|--quiet/.test(s);
}

function unsafeHttpReason(command: string): string | undefined {
	const stripped = stripQuotedContent(command);
	if (BLOCKED_HTTP_PATTERNS.some((pattern) => pattern.test(stripped))) {
		return "Use context-mode tools such as ctx_execute, ctx_fetch_and_index, or fetch_content instead of inline HTTP clients. Raw fetch/requests/http output floods the context window.";
	}
	if (/(^|\s|&&|\||;)(curl|wget)\s/i.test(stripped)) {
		const segments = stripped.split(/\s*(?:&&|\|\||;)\s*/);
		if (segments.some((segment) => !isSafeCurlWget(segment))) {
			return "Use context-mode tools such as ctx_execute, ctx_fetch_and_index, or fetch_content instead of raw curl/wget output. For an escape hatch, write silent output to a file, e.g. `curl -s -o /tmp/x.json URL`.";
		}
	}
	return undefined;
}

function unwrapPatchInput(input: string): { input: string; workdir?: string } {
	const shell = extractShellApplyPatch(input);
	if (shell) return shell;
	const trimmed = input.trim();

	const lines = splitPatchLines(trimmed);
	if (lines.length >= 4) {
		const first = lines[0];
		const last = lines[lines.length - 1];
		if (
			(first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
			last === "EOF"
		) {
			return { input: lines.slice(1, -1).join("\n") };
		}
	}
	return { input: trimmed };
}

function splitPatchLines(input: string): string[] {
	if (input.length === 0) return [];
	return input
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function parsePatch(input: string): ParsedPatch {
	const unwrapped = unwrapPatchInput(input);
	const lines = splitPatchLines(unwrapped.input.trim());
	if (lines.length === 0 || lines[0].trim() !== BEGIN_PATCH_MARKER) {
		throw new Error(
			"invalid patch: The first line of the patch must be '*** Begin Patch'",
		);
	}

	const hunks: Hunk[] = [];
	let mode = "started" as PatchParseMode;
	let currentUpdateLine = 0;

	const lastUpdate = (): UpdateFileHunk | undefined => {
		const last = hunks[hunks.length - 1];
		return last?.type === "update" ? last : undefined;
	};

	const ensureUpdateHunkIsNotEmpty = (line: string, lineNumber: number) => {
		const update = lastUpdate();
		if (!update || mode !== "update") return;
		if (update.chunks.length === 0) {
			throw new Error(
				`invalid hunk at line ${currentUpdateLine}, Update file hunk for path '${update.path}' is empty`,
			);
		}
		const lastChunk = update.chunks[update.chunks.length - 1];
		if (lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
			const message =
				line === END_PATCH_MARKER
					? "Update hunk does not contain any lines"
					: `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;
			throw new Error(`invalid hunk at line ${lineNumber}, ${message}`);
		}
	};

	const handleHeaders = (line: string, lineNumber: number): boolean => {
		if (line === END_PATCH_MARKER) {
			ensureUpdateHunkIsNotEmpty(line, lineNumber);
			mode = "ended";
			return true;
		}
		if (line.startsWith(ADD_FILE_MARKER)) {
			ensureUpdateHunkIsNotEmpty(line, lineNumber);
			hunks.push({
				type: "add",
				path: line.slice(ADD_FILE_MARKER.length),
				contents: "",
			});
			mode = "add";
			return true;
		}
		if (line.startsWith(DELETE_FILE_MARKER)) {
			ensureUpdateHunkIsNotEmpty(line, lineNumber);
			hunks.push({
				type: "delete",
				path: line.slice(DELETE_FILE_MARKER.length),
			});
			mode = "delete";
			return true;
		}
		if (line.startsWith(UPDATE_FILE_MARKER)) {
			ensureUpdateHunkIsNotEmpty(line, lineNumber);
			hunks.push({
				type: "update",
				path: line.slice(UPDATE_FILE_MARKER.length),
				chunks: [],
			});
			currentUpdateLine = lineNumber;
			mode = "update";
			return true;
		}
		return false;
	};

	for (let index = 1; index < lines.length; index++) {
		const lineNumber = index + 1;
		const line = lines[index];
		const trimmed = line.trim();

		if (mode === "ended") {
			if (trimmed.length === 0) continue;
			throw new Error(
				"invalid patch: The last line of the patch must be '*** End Patch'",
			);
		}

		if (mode === "started") {
			if (trimmed.startsWith("*** Environment ID:")) {
				throw new Error(
					"invalid patch: Environment ID is unsupported because Pi extensions cannot route apply_patch to attached environments",
				);
			}
			if (handleHeaders(trimmed, lineNumber)) continue;
			throw new Error(
				`invalid hunk at line ${lineNumber}, '${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
			);
		}

		if (mode === "add") {
			if (handleHeaders(trimmed, lineNumber)) continue;
			const hunk = hunks[hunks.length - 1];
			if (hunk?.type === "add" && line.startsWith("+")) {
				hunk.contents += `${line.slice(1)}\n`;
				continue;
			}
			throw new Error(
				`invalid hunk at line ${lineNumber}, '${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
			);
		}

		if (mode === "delete") {
			if (handleHeaders(trimmed, lineNumber)) continue;
			throw new Error(
				`invalid hunk at line ${lineNumber}, '${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
			);
		}

		const update = lastUpdate();
		if (!update)
			throw new Error(
				`invalid hunk at line ${lineNumber}, unexpected update line`,
			);
		const updateLine = line.trimEnd();
		if (handleHeaders(updateLine, lineNumber)) continue;

		const lastChunk = update.chunks[update.chunks.length - 1];
		if (lastChunk?.isEndOfFile) {
			if (updateLine.length === 0) continue;
			if (
				updateLine !== EMPTY_CHANGE_CONTEXT_MARKER &&
				!updateLine.startsWith(CHANGE_CONTEXT_MARKER)
			) {
				throw new Error(
					`invalid hunk at line ${lineNumber}, Expected update hunk to start with a @@ context marker, got: '${line}'`,
				);
			}
		}

		if (
			update.chunks.length === 0 &&
			update.movePath === undefined &&
			updateLine.startsWith(MOVE_TO_MARKER)
		) {
			update.movePath = updateLine.slice(MOVE_TO_MARKER.length);
			continue;
		}

		if (
			(updateLine === EMPTY_CHANGE_CONTEXT_MARKER ||
				updateLine.startsWith(CHANGE_CONTEXT_MARKER)) &&
			lastChunk &&
			lastChunk.oldLines.length === 0 &&
			lastChunk.newLines.length === 0
		) {
			throw new Error(
				`invalid hunk at line ${lineNumber}, Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
			);
		}

		if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
			update.chunks.push({ oldLines: [], newLines: [], isEndOfFile: false });
			continue;
		}
		if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
			update.chunks.push({
				changeContext: updateLine.slice(CHANGE_CONTEXT_MARKER.length),
				oldLines: [],
				newLines: [],
				isEndOfFile: false,
			});
			continue;
		}
		if (updateLine === EOF_MARKER) {
			if (
				!lastChunk ||
				(lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0)
			) {
				throw new Error(
					`invalid hunk at line ${lineNumber}, Update hunk does not contain any lines`,
				);
			}
			lastChunk.isEndOfFile = true;
			continue;
		}

		if (line.length === 0) {
			const chunk = ensureUpdateChunk(update);
			chunk.oldLines.push("");
			chunk.newLines.push("");
			continue;
		}
		if (line.startsWith(" ")) {
			const chunk = ensureUpdateChunk(update);
			chunk.oldLines.push(line.slice(1));
			chunk.newLines.push(line.slice(1));
			continue;
		}
		if (line.startsWith("+")) {
			ensureUpdateChunk(update).newLines.push(line.slice(1));
			continue;
		}
		if (line.startsWith("-")) {
			ensureUpdateChunk(update).oldLines.push(line.slice(1));
			continue;
		}
		if (
			lastChunk &&
			(lastChunk.oldLines.length > 0 || lastChunk.newLines.length > 0)
		) {
			throw new Error(
				`invalid hunk at line ${lineNumber}, Expected update hunk to start with a @@ context marker, got: '${line}'`,
			);
		}
		throw new Error(
			`invalid hunk at line ${lineNumber}, Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
		);
	}

	if (mode !== "ended")
		throw new Error(
			"invalid patch: The last line of the patch must be '*** End Patch'",
		);
	if (hunks.length === 0) throw new Error("No files were modified.");
	return { hunks, workdir: unwrapped.workdir };
}

function ensureUpdateChunk(update: UpdateFileHunk): UpdateFileChunk {
	let chunk = update.chunks[update.chunks.length - 1];
	if (!chunk) {
		chunk = { oldLines: [], newLines: [], isEndOfFile: false };
		update.chunks.push(chunk);
	}
	return chunk;
}

function normalizeLooseLine(value: string): string {
	return value
		.trim()
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(
			/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g,
			" ",
		);
}

function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;
	const searchStart =
		eof && lines.length >= pattern.length
			? lines.length - pattern.length
			: start;
	const lastStart = lines.length - pattern.length;

	const passes: Array<(a: string, b: string) => boolean> = [
		(a, b) => a === b,
		(a, b) => a.trimEnd() === b.trimEnd(),
		(a, b) => a.trim() === b.trim(),
		(a, b) => normalizeLooseLine(a) === normalizeLooseLine(b),
	];

	for (const equal of passes) {
		for (let index = searchStart; index <= lastStart; index++) {
			let ok = true;
			for (let offset = 0; offset < pattern.length; offset++) {
				if (!equal(lines[index + offset], pattern[offset])) {
					ok = false;
					break;
				}
			}
			if (ok) return index;
		}
	}
	return undefined;
}

function preferredLineEnding(contents: string): "\n" | "\r\n" {
	let crlf = 0;
	let bareLf = 0;
	for (let index = 0; index < contents.length; index++) {
		if (contents[index] !== "\n") continue;
		if (contents[index - 1] === "\r") crlf += 1;
		else bareLf += 1;
	}
	return crlf > bareLf ? "\r\n" : "\n";
}

function deriveNewContents(
	originalContents: string,
	chunks: UpdateFileChunk[],
	path: string,
): string {
	const lineEnding = preferredLineEnding(originalContents);
	const originalLines = originalContents
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (originalLines[originalLines.length - 1] === "") originalLines.pop();

	const replacements: Array<{
		start: number;
		oldLength: number;
		newLines: string[];
		ordinal: number;
	}> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const found = seekSequence(
				originalLines,
				[chunk.changeContext],
				lineIndex,
				false,
			);
			if (found === undefined)
				throw new Error(
					`Failed to find context '${chunk.changeContext}' in ${path}`,
				);
			lineIndex = found + 1;
		}

		if (chunk.oldLines.length === 0) {
			replacements.push({
				start: originalLines.length,
				oldLength: 0,
				newLines: [...chunk.newLines],
				ordinal: replacements.length,
			});
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let found = seekSequence(
			originalLines,
			pattern,
			lineIndex,
			chunk.isEndOfFile,
		);
		if (found === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			newLines =
				newLines[newLines.length - 1] === "" ? newLines.slice(0, -1) : newLines;
			found = seekSequence(
				originalLines,
				pattern,
				lineIndex,
				chunk.isEndOfFile,
			);
		}
		if (found === undefined) {
			throw new Error(
				`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
			);
		}
		replacements.push({
			start: found,
			oldLength: pattern.length,
			newLines: [...newLines],
			ordinal: replacements.length,
		});
		lineIndex = found + pattern.length;
	}

	const nextLines = [...originalLines];
	for (const replacement of replacements.sort(
		(a, b) => b.start - a.start || b.ordinal - a.ordinal,
	)) {
		nextLines.splice(
			replacement.start,
			replacement.oldLength,
			...replacement.newLines,
		);
	}
	if (nextLines[nextLines.length - 1] !== "") nextLines.push("");
	return nextLines.join(lineEnding);
}

async function readOptionalFile(path: string): Promise<FileState> {
	try {
		return { exists: true, content: await readFile(path, "utf8") };
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			(error as { code?: unknown }).code === "ENOENT"
		) {
			return { exists: false };
		}
		throw error;
	}
}

function stateEquals(a: FileState, b: FileState): boolean {
	return a.exists === b.exists && a.content === b.content;
}

async function restoreOriginals(
	originals: Map<string, FileState>,
): Promise<Array<{ path: string; error: string }>> {
	const failures: Array<{ path: string; error: string }> = [];
	for (const [path, state] of originals) {
		try {
			if (state.exists) {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, state.content ?? "", "utf8");
			} else {
				await rm(path, { force: true });
			}
		} catch (error) {
			failures.push({
				path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return failures;
}

async function ensureParentDirectory(
	path: string,
	createdDirectories: Set<string>,
): Promise<void> {
	const target = dirname(path);
	const firstCreated = await mkdir(target, { recursive: true });
	if (!firstCreated) return;
	const boundary = toNamespacedPath(resolve(firstCreated));
	let current = resolve(target);
	while (true) {
		createdDirectories.add(current);
		if (toNamespacedPath(current) === boundary) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

async function removeCreatedDirectories(
	createdDirectories: Set<string>,
): Promise<Array<{ path: string; error: string }>> {
	const failures: Array<{ path: string; error: string }> = [];
	for (const path of [...createdDirectories].sort(
		(a, b) => b.length - a.length,
	)) {
		try {
			await rmdir(path);
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				(error as { code?: unknown }).code === "ENOENT"
			) {
				continue;
			}
			failures.push({
				path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return failures;
}

function collectHunkPaths(baseDir: string, hunks: Hunk[]): string[] {
	const paths: string[] = [];
	for (const hunk of hunks) {
		paths.push(resolveToolPath(baseDir, hunk.path));
		if (hunk.type === "update" && hunk.movePath)
			paths.push(resolveToolPath(baseDir, hunk.movePath));
	}
	return paths;
}

async function withMutationQueues<T>(
	paths: string[],
	fn: () => Promise<T>,
): Promise<T> {
	const unique = [...new Set(paths.map((path) => resolve(path)))].sort((a, b) =>
		a.localeCompare(b),
	);
	let run = fn;
	for (let index = unique.length - 1; index >= 0; index--) {
		const path = unique[index];
		const previous = run;
		run = () => withFileMutationQueue(path, previous);
	}
	return run();
}

function effectiveMoveChange(
	originals: Map<string, FileState>,
	finalStates: Map<string, FileState>,
	move: MoveRecord,
): ChangeRecord | undefined {
	const sourceOriginal = originals.get(move.path);
	const sourceFinal = finalStates.get(move.path);
	const destinationOriginal = originals.get(move.movePath);
	const destinationFinal = finalStates.get(move.movePath);
	if (
		!sourceOriginal?.exists ||
		sourceFinal?.exists !== false ||
		destinationOriginal?.exists ||
		!destinationFinal?.exists
	) {
		return undefined;
	}
	return {
		action: "moved",
		path: move.path,
		movePath: move.movePath,
		diff: generateDiffString(
			sourceOriginal.content ?? "",
			destinationFinal.content ?? "",
		).diff,
	};
}

function collectEffectiveChanges(
	originals: Map<string, FileState>,
	finalStates: Array<[string, FileState]>,
	moves: MoveRecord[],
): ChangeRecord[] {
	const remaining = new Map(finalStates);
	const changes: ChangeRecord[] = [];

	for (const move of moves) {
		const change = effectiveMoveChange(originals, remaining, move);
		if (!change) continue;
		changes.push(change);
		remaining.delete(move.path);
		remaining.delete(move.movePath);
	}

	for (const [path, state] of remaining) {
		const original = originals.get(path) ?? { exists: false };
		let action: ChangeRecord["action"];
		if (!original.exists) action = "added";
		else if (!state.exists) action = "deleted";
		else action = "updated";
		changes.push({
			action,
			path,
			diff: generateDiffString(
				original.exists ? (original.content ?? "") : "",
				state.exists ? (state.content ?? "") : "",
			).diff,
		});
	}
	return changes;
}

async function applyParsedPatch(
	ctx: ExtensionContext,
	parsed: ParsedPatch,
	requestedWorkdir?: string,
): Promise<{ changes: ChangeRecord[]; baseDir: string }> {
	const outerBaseDir = requestedWorkdir
		? resolveToolPath(ctx.cwd, requestedWorkdir)
		: ctx.cwd;
	const baseDir = parsed.workdir
		? resolveToolPath(outerBaseDir, parsed.workdir)
		: outerBaseDir;
	const queuePaths = collectHunkPaths(baseDir, parsed.hunks);

	return withMutationQueues(queuePaths, async () => {
		const originals = new Map<string, FileState>();
		const states = new Map<string, FileState>();
		const moves: MoveRecord[] = [];
		const createdDirectories = new Set<string>();

		const load = async (path: string): Promise<FileState> => {
			const absolute = resolve(path);
			const existing = states.get(absolute);
			if (existing) return existing;
			const original = await readOptionalFile(absolute);
			const state = { ...original };
			originals.set(absolute, { ...original });
			states.set(absolute, state);
			return state;
		};

		const setState = async (path: string, state: FileState) => {
			const absolute = resolve(path);
			if (!originals.has(absolute))
				originals.set(absolute, await readOptionalFile(absolute));
			states.set(absolute, { ...state });
		};

		for (const hunk of parsed.hunks) {
			const sourcePath = resolveToolPath(baseDir, hunk.path);
			if (hunk.type === "add") {
				await setState(sourcePath, { exists: true, content: hunk.contents });
				continue;
			}

			const source = await load(sourcePath);
			if (!source.exists) throw new Error(`Failed to read file ${hunk.path}`);

			if (hunk.type === "delete") {
				await setState(sourcePath, { exists: false });
				continue;
			}

			const newContent = deriveNewContents(
				source.content ?? "",
				hunk.chunks,
				hunk.path,
			);
			if (hunk.movePath) {
				const destPath = resolveToolPath(baseDir, hunk.movePath);
				await setState(destPath, { exists: true, content: newContent });
				if (destPath !== sourcePath)
					await setState(sourcePath, { exists: false });
				moves.push({ path: sourcePath, movePath: destPath });
			} else {
				await setState(sourcePath, { exists: true, content: newContent });
			}
		}

		const finalStates = [...states].filter(([path, state]) => {
			const original = originals.get(path);
			return original ? !stateEquals(original, state) : true;
		});

		const changes = collectEffectiveChanges(originals, finalStates, moves);

		try {
			for (const [path, state] of finalStates) {
				if (state.exists) {
					await ensureParentDirectory(path, createdDirectories);
					await writeFile(path, state.content ?? "", "utf8");
				} else {
					await rm(path, { force: true });
				}
			}
		} catch (error) {
			const originalMessage =
				error instanceof Error ? error.message : String(error);
			const restoreFailures = await restoreOriginals(originals);
			const directoryFailures =
				await removeCreatedDirectories(createdDirectories);
			const residualStates: Array<[string, FileState]> = [];
			const verificationFailures: Array<{ path: string; error: string }> = [];
			for (const [path, original] of originals) {
				try {
					const current = await readOptionalFile(path);
					if (!stateEquals(original, current))
						residualStates.push([path, current]);
				} catch (readError) {
					verificationFailures.push({
						path,
						error: `could not verify rollback: ${readError instanceof Error ? readError.message : String(readError)}`,
					});
				}
			}
			const residualChanges = collectEffectiveChanges(
				originals,
				residualStates,
				moves,
			);
			const residualPaths = new Set(residualStates.map(([path]) => path));
			const unverifiablePaths = new Set(
				verificationFailures.map(({ path }) => path),
			);
			const rollbackFailures = [
				...restoreFailures.filter(
					({ path }) => residualPaths.has(path) || unverifiablePaths.has(path),
				),
				...directoryFailures,
				...verificationFailures,
			];
			const rollbackMessage = rollbackFailures.length
				? `; rollback errors: ${rollbackFailures
						.map(
							({ path, error: rollbackError }) => `${path}: ${rollbackError}`,
						)
						.join("; ")}`
				: "";
			throw new PatchApplicationError(
				`${originalMessage}${rollbackMessage}`,
				residualChanges,
			);
		}

		return {
			changes,
			baseDir,
		};
	});
}

function applyPatchSuccessOutput(
	ctx: ExtensionContext,
	hunks: Hunk[],
	baseDir: string,
): string {
	const groups: Record<"A" | "M" | "D", string[]> = { A: [], M: [], D: [] };
	for (const hunk of hunks) {
		const code = hunk.type === "add" ? "A" : hunk.type === "delete" ? "D" : "M";
		const path = displayPath(ctx, resolveToolPath(baseDir, hunk.path));
		groups[code].push(path);
	}
	return [
		"Success. Updated the following files:",
		...groups.A.map((path) => `A ${path}`),
		...groups.M.map((path) => `M ${path}`),
		...groups.D.map((path) => `D ${path}`),
	].join("\n");
}

function formatApplyPatchModelOutput(
	exitCode: 0 | 1,
	wallTimeSeconds: number,
	output: string,
): string {
	const roundedSeconds = Math.round(wallTimeSeconds * 10) / 10;
	return [
		`Exit code: ${exitCode}`,
		`Wall time: ${roundedSeconds} seconds`,
		"Output:",
		output,
	].join("\n");
}

async function executeApplyPatch(
	input: string,
	workdir: string | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ApplyPatchDetails>> {
	const startedAt = process.hrtime.bigint();
	const elapsedSeconds = () =>
		Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
	try {
		const parsed = parsePatch(input);
		const result = await applyParsedPatch(ctx, parsed, workdir);
		const wallTimeSeconds = elapsedSeconds();
		return {
			content: [
				{
					type: "text",
					text: formatApplyPatchModelOutput(
						0,
						wallTimeSeconds,
						applyPatchSuccessOutput(ctx, parsed.hunks, result.baseDir),
					),
				},
			],
			details: { changes: result.changes, exitCode: 0, wallTimeSeconds },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const changes = error instanceof PatchApplicationError ? error.changes : [];
		const wallTimeSeconds = elapsedSeconds();
		return {
			content: [
				{
					type: "text",
					text: formatApplyPatchModelOutput(
						1,
						wallTimeSeconds,
						`apply_patch verification failed: ${message}`,
					),
				},
			],
			details: {
				changes,
				exitCode: 1,
				wallTimeSeconds,
				error: message,
			},
		};
	}
}

function mediaTypeForPath(path: string): string | undefined {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".bmp":
			return "image/bmp";
		default:
			return undefined;
	}
}

function viewImageFailure(
	path: string,
	mediaType: string,
	bytes: number,
	message: string,
): AgentToolResult<ViewImageDetails> {
	return {
		content: [{ type: "text", text: `view_image failed: ${message}` }],
		details: { path, mediaType, bytes, error: message },
	};
}

async function executeViewImage(
	params: ViewImageParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<ViewImageDetails>> {
	let absolutePath: string;
	try {
		absolutePath = resolveToolPath(ctx.cwd, params.path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return viewImageFailure(
			params.path,
			"application/octet-stream",
			0,
			message,
		);
	}
	const mediaType = mediaTypeForPath(absolutePath);
	if (!mediaType) {
		return viewImageFailure(
			absolutePath,
			"application/octet-stream",
			0,
			`unsupported image extension for ${displayPath(ctx, absolutePath)}`,
		);
	}
	let bytes: Buffer;
	try {
		bytes = await readLocalImageFile(
			absolutePath,
			displayPath(ctx, absolutePath),
			MAX_LOCAL_IMAGE_BYTES,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return viewImageFailure(absolutePath, mediaType, 0, message);
	}
	let image: Awaited<ReturnType<typeof prepareNativeImageContent>>;
	try {
		image = await prepareNativeImageContent(
			{ data: bytes.toString("base64"), mimeType: mediaType },
			convertToPng,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return viewImageFailure(
			absolutePath,
			mediaType,
			bytes.length,
			`could not process ${displayPath(ctx, absolutePath)}: ${message}`,
		);
	}

	if (!ctx.model?.input?.includes("image")) {
		try {
			const described = await describeImageForTextModel(
				image,
				displayPath(ctx, absolutePath),
				signal,
				ctx,
			);
			return {
				content: [
					{
						type: "text",
						text: `Image description (${described.model}):\n${described.description}`,
					},
				],
				details: {
					path: absolutePath,
					mediaType: image.mimeType,
					bytes: bytes.length,
					describedBy: described.model,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return viewImageFailure(
				absolutePath,
				image.mimeType,
				bytes.length,
				message,
			);
		}
	}
	return {
		content: [
			{ type: "text", text: `Viewed image: ${displayPath(ctx, absolutePath)}` },
			image,
		],
		details: {
			path: absolutePath,
			mediaType: image.mimeType,
			bytes: bytes.length,
		},
	};
}

type ApplyPatchRenderContext = {
	cwd: string;
	isError: boolean;
	lastComponent: unknown;
};

function renderApplyPatchResult(
	result: AgentToolResult<ApplyPatchDetails>,
	{ expanded }: ToolRenderResultOptions,
	theme: Theme,
	context: ApplyPatchRenderContext,
): Text {
	const details = result.details;
	const raw = resultText(result);
	const summary = summarizeApplyPatchResult(details);
	let display: string;

	if (context.isError || details.error) {
		display = (raw || summary)
			.split("\n")
			.map((line) => theme.fg("error", line))
			.join("\n");
	} else if (!expanded) {
		display = theme.fg("success", `✓ ${summary}`);
	} else {
		const sections: string[] = [];
		for (const change of details.changes) {
			const sourcePath = displayPathFromCwd(context.cwd, change.path);
			const targetPath = change.movePath
				? displayPathFromCwd(context.cwd, change.movePath)
				: undefined;
			const heading = targetPath
				? `moved ${sourcePath} -> ${targetPath}`
				: `${change.action} ${sourcePath}`;
			sections.push(theme.fg("toolTitle", theme.bold(heading)));
			if (change.diff) {
				sections.push(
					renderDiff(change.diff, { filePath: change.movePath ?? change.path }),
				);
			}
		}
		display = sections.join("\n") || theme.fg("toolOutput", raw || summary);
	}

	const text =
		(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(display);
	return text;
}

type ImageRenderContext<TArgs> = {
	args?: TArgs;
	cwd: string;
	isError: boolean;
	lastComponent: unknown;
};

function renderViewImageResult(
	result: AgentToolResult<ViewImageDetails>,
	{ expanded }: ToolRenderResultOptions,
	theme: Theme,
	context: ImageRenderContext<ViewImageParams>,
): Text {
	const raw = resultText(result);
	const details = result.details;
	const path =
		typeof details?.path === "string"
			? displayPathFromCwd(context.cwd, details.path)
			: (context.args?.path ?? "image");
	let display: string;
	if (context.isError || details.error) {
		display = raw
			.split("\n")
			.map((line) => theme.fg("error", line))
			.join("\n");
	} else {
		const heading = theme.fg("success", "• Viewed Image");
		const lines = [heading, theme.fg("muted", `  ${path}`)];
		if (expanded && details.describedBy && raw) {
			lines.push(theme.fg("toolOutput", raw));
		}
		display = lines.join("\n");
	}
	const text =
		(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(display);
	return text;
}

function imageGenerationCallLabel(args: ImageGenerationParams): string {
	const operation =
		(args.referenced_image_paths?.length ?? 0) > 0 ||
		args.num_last_images_to_include !== undefined
			? "Edit Image"
			: "Generate Image";
	const prompt =
		typeof args.prompt === "string" ? args.prompt.trim().split("\n", 1)[0] : "";
	return prompt ? `${operation}: ${prompt}` : operation;
}

function renderImageGenerationResult(
	result: AgentToolResult<ImageGenerationDetails>,
	{ expanded }: ToolRenderResultOptions,
	theme: Theme,
	context: ImageRenderContext<ImageGenerationParams>,
): Text {
	const raw = resultText(result);
	const details = result.details;
	let display: string;
	if (context.isError) {
		display = [
			theme.fg("error", "✗ Image generation failed"),
			theme.fg("error", raw),
		]
			.filter(Boolean)
			.join("\n");
	} else {
		const lines = [
			theme.fg("success", "• Generated Image:"),
			theme.fg("muted", `  ${displayPathFromCwd(context.cwd, details.path)}`),
		];
		if (expanded && details.revisedPrompt) {
			lines.push(
				theme.fg("toolOutput", `Revised prompt: ${details.revisedPrompt}`),
			);
		}
		display = lines.join("\n");
	}
	const text =
		(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(display);
	return text;
}

function registerSessionImageRepairCommand(pi: ExtensionAPI): void {
	pi.registerCommand("repair-session-images", {
		description:
			"Back up and permanently normalize legacy image blocks in the current session",
		handler: async (args, ctx) => {
			const option = args.trim();
			if (option && option !== "--yes") {
				ctx.ui.notify("Usage: /repair-session-images [--yes]", "warning");
				return;
			}

			await ctx.waitForIdle();
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) {
				ctx.ui.notify(
					"The current session is not persisted to a file.",
					"warning",
				);
				return;
			}

			try {
				const result = await repairSessionImageFile(
					sessionPath,
					convertToPng,
					async ({ changedEntries, changedBlocks }) => {
						if (option === "--yes") return true;
						if (!ctx.hasUI) return false;
						return ctx.ui.confirm(
							"Repair session images?",
							`Normalize ${changedBlocks} image block(s) in ${changedEntries} session entr${changedEntries === 1 ? "y" : "ies"}. The original file will be backed up first.`,
						);
					},
				);

				if (result.changedEntries === 0) {
					ctx.ui.notify(
						"No legacy or provider-incompatible image blocks found.",
						"info",
					);
					return;
				}
				if (!result.applied) {
					ctx.ui.notify("Session image repair cancelled.", "info");
					return;
				}
				ctx.ui.notify(
					`Repaired ${result.changedBlocks} image block(s). Backup: ${result.backupPath}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Session image repair failed: ${message}`, "error");
			}
		},
	});
}

export default function codexCompat(pi: ExtensionAPI): void {
	codexUsage(pi);
	const fallbackExecRuntimeOwner = createExecRuntimeOwner();
	const execRuntimeOwners = new Map<
		string,
		ReturnType<typeof createExecRuntimeOwner>
	>();
	const execRuntimeOwnerFor = (
		ctx: Pick<ExtensionContext, "sessionManager">,
	) => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) return fallbackExecRuntimeOwner;
		let owner = execRuntimeOwners.get(sessionId);
		if (!owner) {
			owner = createExecRuntimeOwner();
			execRuntimeOwners.set(sessionId, owner);
		}
		return owner;
	};
	let toolActivationState: ToolActivationState = {
		enabled: false,
	};
	const syncTools = (
		model: ExtensionContext["model"],
		ctx: Pick<ExtensionContext, "modelRegistry">,
	) => {
		const result = syncCodexCompatTools(
			pi.getActiveTools(),
			model,
			toolActivationState,
			{
				imageGenerationAuthenticated: Boolean(
					model && ctx.modelRegistry.hasConfiguredAuth(model),
				),
			},
		);
		toolActivationState = result.state;
		if (result.activeTools.join("\0") !== pi.getActiveTools().join("\0")) {
			pi.setActiveTools(result.activeTools);
		}
	};

	// Older pi-codex-compat releases persisted Anthropic wire-format image
	// blocks in session history. Normalize them before provider serialization so
	// existing sessions, including resumable subagents, remain usable.
	pi.on("context", async (event) => {
		const messages = await normalizeProviderImageMessages(
			event.messages,
			convertToPng,
		);
		if (messages !== event.messages) return { messages };
	});
	pi.on("tool_result", (event) => {
		if (event.isError || !CODEX_COMPAT_TOOL_NAMES.includes(event.toolName)) {
			return;
		}
		if (!event.details || typeof event.details !== "object") return;
		const details = event.details as { error?: unknown; aborted?: unknown };
		if (typeof details.error === "string" || details.aborted === true) {
			return { isError: true };
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const owner = execRuntimeOwners.get(sessionId);
		if (!owner) return;
		await shutdownExecSessions(owner);
		execRuntimeOwners.delete(sessionId);
	});
	pi.on("session_start", async (_event, ctx) => {
		await startExecSessionRuntime(execRuntimeOwnerFor(ctx));
		syncTools(ctx.model, ctx);
	});
	pi.on("model_select", (event, ctx) => syncTools(event.model, ctx));
	registerSessionImageRepairCommand(pi);

	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description:
			"Use the apply_patch tool to edit files. Pass the complete Codex patch envelope in the input field.",
		promptSnippet:
			"Apply Codex-style file patches using the apply_patch patch envelope",
		promptGuidelines: [
			"Use apply_patch for manual file edits when a Codex-style patch is natural; pass the whole patch body as the `input` string.",
			"apply_patch input must use the Codex envelope: `*** Begin Patch`, one or more Add/Delete/Update File sections, and `*** End Patch`.",
			"apply_patch supports `*** Move to:` and heredoc bodies copied from structurally valid `apply_patch <<'PATCH'` shell snippets.",
			"Do not use apply_patch for generated outputs or broad mechanical rewrites where a script or formatter is the clearer tool.",
			"When context-mode tools such as ctx_execute or ctx_execute_file are active, keep using them for large-output analysis; apply_patch is only for committing file mutations.",
		],
		parameters: Type.Object(
			{
				input: Type.String({
					description:
						"Codex apply_patch patch text. Include the full *** Begin Patch / *** End Patch envelope.",
				}),
				workdir: Type.Optional(
					Type.String({
						description:
							"Base directory for relative patch paths. Defaults to the Pi session cwd.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		prepareArguments: prepareApplyPatchArguments,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeApplyPatch(params.input, params.workdir, ctx);
		},
		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold(formatApplyPatchCall(args))),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderApplyPatchResult(
				result as AgentToolResult<ApplyPatchDetails>,
				options,
				theme,
				context,
			);
		},
	});

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description:
			"Runs a command with plain pipes, returning output or a session ID for ongoing polling. tty defaults to false; tty:true is rejected because PTY/ConPTY allocation belongs to the Codex core runtime and is unavailable inside this extension.",
		promptSnippet:
			"Run commands in managed sessions with the Codex Unified Exec contract",
		promptGuidelines: [
			"Use exec_command when a Codex-style tool call would use `exec_command`; always set `workdir` when operating inside a repository.",
			"exec_command accepts `cmd`, optional `workdir`, `tty`, `shell`, `login`, `yield_time_ms`, and `max_output_tokens`.",
			"exec_command uses plain pipes. `tty:false` is the default; `tty:true` is rejected rather than pretending a pipe is a PTY.",
			"exec_command initially waits 10,000ms and clamps the wait to 250–30,000ms (2,000–30,000ms on Windows). A command still running after that wait returns a session ID.",
			"exec_command intercepts `apply_patch <<'PATCH'` heredocs and routes them to apply_patch instead of executing a shell binary.",
			"Use write_stdin with the returned `session_id` to poll or to send an exact Ctrl-C character to a non-TTY session; other non-empty input is rejected.",
			"Do not use exec_command for raw HTTP clients that would dump output into context; use context-mode tools such as ctx_execute, ctx_fetch_and_index, or fetch_content.",
		],
		parameters: Type.Object(
			{
				cmd: Type.String({
					description: "Shell command to execute.",
				}),
				workdir: Type.Optional(
					Type.String({
						description:
							"Working directory for the command. Defaults to the turn cwd.",
					}),
				),
				tty: Type.Optional(
					Type.Boolean({
						description:
							"Requests PTY allocation. False or omitted uses plain pipes; true is rejected by this extension because PTY/ConPTY support belongs to Codex core.",
					}),
				),
				yield_time_ms: Type.Optional(
					Type.Integer({
						description:
							"Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms (2000-30000 ms on Windows).",
						minimum: 0,
					}),
				),
				max_output_tokens: Type.Optional(
					Type.Integer({
						description:
							"Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
						minimum: 0,
					}),
				),
				shell: Type.Optional(
					Type.String({
						description:
							"Shell binary to launch. Defaults to the user's default shell.",
					}),
				),
				login: Type.Optional(
					Type.Boolean({
						description:
							"True runs with login shell semantics; false disables them. Defaults to true.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		prepareArguments: prepareExecCommandArguments,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const interceptedPatch = extractShellApplyPatch(params.cmd);
			if (interceptedPatch) {
				return executeApplyPatch(
					interceptedPatch.input,
					interceptedPatchWorkdir(
						ctx.cwd,
						params.workdir,
						interceptedPatch.workdir,
					),
					ctx,
				);
			}

			const blockReason = unsafeHttpReason(params.cmd);
			if (blockReason) {
				return {
					content: [
						{
							type: "text",
							text: `exec_command blocked by ${EXTENSION_NAME}: ${blockReason}`,
						},
					],
					details: { error: blockReason },
				} as AgentToolResult<{ error: string }>;
			}

			const workdir = params.workdir
				? resolveToolPath(ctx.cwd, params.workdir)
				: ctx.cwd;
			return executeManagedExecCommand(
				{ ...params, workdir },
				signal,
				ctx,
				onUpdate,
				execRuntimeOwnerFor(ctx),
			);
		},
		renderCall(args, theme, context) {
			const interceptedPatch =
				typeof args.cmd === "string"
					? extractShellApplyPatch(args.cmd)
					: undefined;
			const label = interceptedPatch
				? formatApplyPatchCall({
						input: interceptedPatch.input,
						workdir: interceptedPatchWorkdir(
							context.cwd,
							typeof args.workdir === "string" ? args.workdir : undefined,
							interceptedPatch.workdir,
						),
					})
				: formatExecCommandCall(args);
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(label)));
			return text;
		},
		renderResult(result, options, theme, context) {
			const cmd = (context.args as { cmd?: unknown } | undefined)?.cmd;
			if (typeof cmd === "string" && extractShellApplyPatch(cmd)) {
				return renderApplyPatchResult(
					result as AgentToolResult<ApplyPatchDetails>,
					options,
					theme,
					context,
				);
			}
			const raw = resultText(result);
			const details = result.details as ExecCommandDetails | undefined;
			const failed =
				context.isError ||
				Boolean(
					details?.error ||
						details?.aborted ||
						details?.signal ||
						(details?.exit_code !== undefined && details.exit_code !== 0),
				);
			let display: string;
			let color: "accent" | "error" | "success" | "toolOutput";
			if (options.isPartial) {
				display = liveOutputPreview(raw);
				color = "toolOutput";
			} else if (failed) {
				display = raw || summarizeExecResult(details);
				color = "error";
			} else if (options.expanded) {
				display = raw;
				color = "toolOutput";
			} else {
				display = `${details?.running ? "↳" : "✓"} ${summarizeExecResult(details)}`;
				color = details?.running ? "accent" : "success";
			}
			const styled = display
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(styled);
			return text;
		},
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description:
			"Writes characters to an existing unified exec session and returns recent output. In this plain-pipe fallback, only empty polling or an exact U+0003 interrupt is accepted.",
		promptSnippet:
			"Poll a Unified Exec session or send an exact Ctrl-C interrupt",
		promptGuidelines: [
			"Use write_stdin only with a `session_id` returned by exec_command.",
			"Use write_stdin with omitted or empty `chars` to poll without writing; empty polls default to 5,000ms.",
			"Non-TTY exec_command sessions accept only an exact U+0003 Ctrl-C input. Other non-empty `chars` values are rejected because stdin is closed.",
			"On Unix, exact Ctrl-C targets the process group with SIGINT. On Windows, it requests `taskkill /T` tree termination because an extension cannot emit a truthful console Ctrl-C event.",
			"Do not rapidly poll shell sessions at one-second intervals. Prefer the empty-poll default and increase `yield_time_ms` for repeated waits.",
		],
		parameters: Type.Object(
			{
				session_id: Type.Integer({
					description: "Identifier of the running unified exec session.",
					minimum: 1,
				}),
				chars: Type.Optional(
					Type.String({
						description:
							"Empty or omitted polls without writing. Exact U+0003 requests interruption; all other non-empty input is rejected for plain-pipe sessions.",
					}),
				),
				yield_time_ms: Type.Optional(
					Type.Integer({
						description:
							"Wait before yielding output. Exact interrupt requests default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
						minimum: 0,
					}),
				),
				max_output_tokens: Type.Optional(
					Type.Integer({
						description:
							"Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
						minimum: 0,
					}),
				),
			},
			{ additionalProperties: false },
		),
		prepareArguments: prepareWriteStdinArguments,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeWriteStdin(
				params,
				signal,
				onUpdate,
				execRuntimeOwnerFor(ctx),
			);
		},
		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold(formatWriteStdinCall(args))),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const raw = resultText(result);
			const details = result.details as ExecCommandDetails | undefined;
			const failed =
				context.isError ||
				Boolean(
					details?.error ||
						details?.aborted ||
						details?.signal ||
						(details?.exit_code !== undefined && details.exit_code !== 0),
				);
			let display: string;
			let color: "accent" | "error" | "success" | "toolOutput";
			if (options.isPartial) {
				display = liveOutputPreview(raw);
				color = "toolOutput";
			} else if (failed) {
				display = raw || summarizeExecResult(details);
				color = "error";
			} else if (options.expanded) {
				display = raw;
				color = "toolOutput";
			} else {
				display = `${details?.running ? "↳" : "✓"} ${summarizeExecResult(details)}`;
				color = details?.running ? "accent" : "success";
			}
			const styled = display
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(styled);
			return text;
		},
	});

	pi.registerTool({
		name: "view_image",
		label: "view_image",
		description:
			"View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
		promptSnippet: "Inspect a local PNG/JPEG/GIF/WebP/BMP image",
		promptGuidelines: [
			"Use view_image when visual inspection of an existing local image is needed.",
			"view_image accepts a local filesystem `path`; do not use it for remote URLs.",
			"On a text-only Codex model, view_image delegates visual inspection to an authenticated image-capable model and returns its concise description.",
		],
		parameters: Type.Object(
			{
				path: Type.String({ description: "Path to a local image file." }),
			},
			{ additionalProperties: false },
		),
		prepareArguments: prepareViewImageArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeViewImage(params, ctx, signal);
		},
		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold(`View Image: ${args.path}`)),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderViewImageResult(
				result as AgentToolResult<ViewImageDetails>,
				options,
				theme,
				context,
			);
		},
	});

	pi.registerTool({
		name: "image_gen",
		label: "image_gen",
		description:
			"Generate images from descriptions or edit existing images from precise instructions, using up to five local or recent conversation references with OpenAI gpt-image-2.",
		promptSnippet:
			"Generate or edit images with gpt-image-2, including local and recent conversation references",
		promptGuidelines: [
			"Use image_gen when the user requests a new image or asks to edit an existing image.",
			"For a new image, call image_gen with only `prompt`.",
			"For edits, use image_gen `referenced_image_paths` when every target has a local path; inspect unseen local images with view_image first.",
			"Use image_gen `num_last_images_to_include` only when a target has no local path, choosing the smallest recent-image count that includes every target, up to 5.",
			"Never provide both image_gen `referenced_image_paths` and `num_last_images_to_include`; ask the user to attach missing images when neither mechanism can include every target.",
			"Directly generate the image without reconfirmation or clarification unless required images must be attached again.",
			"Always use image_gen for image editing unless the user explicitly requests otherwise. Do not use Python for image editing unless specifically instructed.",
		],
		parameters: Type.Object(
			{
				prompt: Type.String({
					description:
						"Detailed generation prompt or precise editing instructions.",
				}),
				referenced_image_paths: Type.Optional(
					Type.Array(
						Type.String({
							description:
								"Local image path, absolute or relative to the session cwd.",
						}),
						{
							description: "Local images to edit, in prompt-reference order.",
							minItems: 1,
							maxItems: 5,
						},
					),
				),
				num_last_images_to_include: Type.Optional(
					Type.Integer({
						description:
							"Number of most recent conversation images to edit when a target has no local path.",
						minimum: 1,
						maximum: 5,
					}),
				),
			},
			{ additionalProperties: false },
		),
		prepareArguments: prepareImageGenerationArguments,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			return executeImageGeneration(toolCallId, params, signal, ctx, {
				convertImage: convertToPng,
				withFileMutationQueue,
			});
		},
		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold(imageGenerationCallLabel(args))),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderImageGenerationResult(
				result as AgentToolResult<ImageGenerationDetails>,
				options,
				theme,
				context,
			);
		},
	});
}
