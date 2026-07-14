import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
	convertToPng,
	createBashToolDefinition,
	generateDiffString,
	renderDiff,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolRenderResultOptions,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	normalizeProviderImageMessages,
	prepareNativeImageContent,
} from "./image-content.ts";
import { describeImageForTextModel } from "./image-description.ts";
import { executeImageGeneration } from "./image-generation.ts";
import {
	syncCodexCompatTools,
	type ToolActivationState,
} from "./model-tools.ts";
import { repairSessionImageFile } from "./session-image-repair.ts";
import codexUsage from "./usage.ts";
import {
	executeManagedShellCommand,
	executeWriteStdin,
	shutdownShellSessions,
	type ShellCommandDetails,
	type ShellCommandParams,
} from "./shell-runtime.ts";
import {
	formatApplyPatchCall,
	formatShellCommandCall,
	formatWriteStdinCall,
	liveOutputPreview,
	resultText,
	summarizeApplyPatchResult,
	summarizeShellResult,
} from "./tool-rendering.ts";
import {
	prepareApplyPatchArguments,
	prepareShellCommandArguments,
	prepareViewImageArguments,
} from "./tool-arguments.ts";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";
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
	environmentId?: string;
	workdir?: string;
};

type PatchParseMode = "started" | "add" | "delete" | "update" | "ended";
type ApplyPatchDetails = {
	changes: ChangeRecord[];
	environmentId?: string;
	error?: string;
};
type PiToolResult<T> = AgentToolResult<T> & { isError?: boolean };

type FileState = { exists: boolean; content?: string };
type ChangeRecord = {
	action: "added" | "deleted" | "updated" | "moved";
	path: string;
	movePath?: string;
	diff: string;
};
type MoveRecord = { path: string; movePath: string };

type ViewImageParams = { path: string };
type ViewImageDetails = {
	path: string;
	mediaType: string;
	bytes: number;
	describedBy?: string;
};

const MAX_VIEW_IMAGE_BYTES = 20 * 1024 * 1024;

function normalizePathArgument(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function resolveToolPath(baseDir: string, path: string): string {
	const normalized = normalizePathArgument(path.trim());
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

function unquoteShellWord(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function extractShellApplyPatch(
	command: string,
): { input: string; workdir?: string } | undefined {
	const trimmed = command.trim();
	const match = trimmed.match(
		/^(?:(?:cd\s+(.+?)\s*&&\s*)?apply_?patch\s+<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*\n)([\s\S]*?)\n\s*\2\s*$/,
	);
	if (!match) return undefined;
	return {
		input: match[3],
		workdir: match[1] ? unquoteShellWord(match[1]) : undefined,
	};
}

function unwrapPatchInput(input: string): { input: string; workdir?: string } {
	const trimmed = input.trim();
	const shell = extractShellApplyPatch(trimmed);
	if (shell) return shell;

	const lines = splitPatchLines(trimmed);
	if (lines.length >= 4) {
		const first = lines[0];
		const last = lines[lines.length - 1];
		if (
			(first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
			last.endsWith("EOF")
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
	let environmentId: string | undefined;

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
		if (mode === "started" && line.startsWith(ENVIRONMENT_ID_MARKER)) {
			if (environmentId !== undefined)
				throw new Error(
					"invalid patch: apply_patch environment_id cannot be specified more than once",
				);
			const id = line.slice(ENVIRONMENT_ID_MARKER.length).trim();
			if (!id)
				throw new Error(
					"invalid patch: apply_patch environment_id cannot be empty",
				);
			environmentId = id;
			return true;
		}
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
	return { hunks, environmentId, workdir: unwrapped.workdir };
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

function deriveNewContents(
	originalContents: string,
	chunks: UpdateFileChunk[],
	path: string,
): string {
	const originalLines = originalContents.split("\n");
	if (originalLines[originalLines.length - 1] === "") originalLines.pop();

	const replacements: Array<{
		start: number;
		oldLength: number;
		newLines: string[];
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
		});
		lineIndex = found + pattern.length;
	}

	const nextLines = [...originalLines];
	for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
		nextLines.splice(
			replacement.start,
			replacement.oldLength,
			...replacement.newLines,
		);
	}
	if (nextLines[nextLines.length - 1] !== "") nextLines.push("");
	return nextLines.join("\n");
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
): Promise<void> {
	for (const [path, state] of originals) {
		if (state.exists) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, state.content ?? "", "utf8");
		} else {
			await rm(path, { force: true });
		}
	}
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
	const requestedBaseDir = requestedWorkdir ?? parsed.workdir;
	const baseDir = requestedBaseDir
		? resolveToolPath(ctx.cwd, requestedBaseDir)
		: ctx.cwd;
	const queuePaths = collectHunkPaths(baseDir, parsed.hunks);

	return withMutationQueues(queuePaths, async () => {
		const originals = new Map<string, FileState>();
		const states = new Map<string, FileState>();
		const moves: MoveRecord[] = [];

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
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, state.content ?? "", "utf8");
				} else {
					await rm(path, { force: true });
				}
			}
		} catch (error) {
			await restoreOriginals(originals);
			throw error;
		}

		return {
			changes,
			baseDir,
		};
	});
}

function formatApplyPatchResult(
	ctx: ExtensionContext,
	changes: ChangeRecord[],
	environmentId?: string,
): string {
	const seen = new Set<string>();
	const lines = ["Applied patch."];
	if (environmentId) lines.push(`Environment ID: ${environmentId}`);
	for (const change of changes) {
		const key = `${change.action}:${change.path}:${change.movePath ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const path = displayPath(ctx, change.path);
		if (change.action === "moved" && change.movePath) {
			lines.push(`- moved ${path} -> ${displayPath(ctx, change.movePath)}`);
		} else {
			lines.push(`- ${change.action} ${path}`);
		}
	}
	return lines.join("\n");
}

async function executeApplyPatch(
	input: string,
	workdir: string | undefined,
	ctx: ExtensionContext,
): Promise<PiToolResult<ApplyPatchDetails>> {
	try {
		const parsed = parsePatch(input);
		const result = await applyParsedPatch(ctx, parsed, workdir);
		return {
			content: [
				{
					type: "text",
					text: formatApplyPatchResult(
						ctx,
						result.changes,
						parsed.environmentId,
					),
				},
			],
			details: { changes: result.changes, environmentId: parsed.environmentId },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `apply_patch failed: ${message}` }],
			details: { changes: [], error: message },
			isError: true,
		};
	}
}

function timeoutSeconds(params: ShellCommandParams): number | undefined {
	const raw =
		params.timeout_ms ??
		(params.timeout !== undefined ? params.timeout * 1000 : undefined);
	if (raw === undefined) return undefined;
	if (!Number.isFinite(raw) || raw <= 0) return undefined;
	return Math.ceil(raw / 1000);
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

async function executeViewImage(
	params: ViewImageParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<PiToolResult<ViewImageDetails>> {
	const absolutePath = resolveToolPath(ctx.cwd, params.path);
	const mediaType = mediaTypeForPath(absolutePath);
	if (!mediaType) {
		return {
			content: [
				{
					type: "text",
					text: `view_image failed: unsupported image extension for ${displayPath(ctx, absolutePath)}`,
				},
			],
			details: {
				path: absolutePath,
				mediaType: "application/octet-stream",
				bytes: 0,
			},
			isError: true,
		};
	}
	const bytes = await readFile(absolutePath);
	if (bytes.length > MAX_VIEW_IMAGE_BYTES) {
		return {
			content: [
				{
					type: "text",
					text: `view_image failed: ${displayPath(ctx, absolutePath)} is larger than ${MAX_VIEW_IMAGE_BYTES} bytes`,
				},
			],
			details: { path: absolutePath, mediaType, bytes: bytes.length },
			isError: true,
		};
	}
	let image;
	try {
		image = await prepareNativeImageContent(
			{ data: bytes.toString("base64"), mimeType: mediaType },
			convertToPng,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [
				{
					type: "text",
					text: `view_image failed: could not process ${displayPath(ctx, absolutePath)}: ${message}`,
				},
			],
			details: { path: absolutePath, mediaType, bytes: bytes.length },
			isError: true,
		};
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
			return {
				content: [
					{
						type: "text",
						text: `view_image failed: ${message}`,
					},
				],
				details: {
					path: absolutePath,
					mediaType: image.mimeType,
					bytes: bytes.length,
				},
				isError: true,
			};
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
		if (details.environmentId) {
			sections.push(
				theme.fg("muted", `Environment ID: ${details.environmentId}`),
			);
		}
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
	let toolActivationState: ToolActivationState = {
		enabled: false,
		previousToolNames: [],
	};
	const syncTools = (model: Parameters<typeof syncCodexCompatTools>[1]) => {
		const result = syncCodexCompatTools(
			pi.getActiveTools(),
			model,
			toolActivationState,
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

	pi.on("session_shutdown", async () => {
		await shutdownShellSessions();
	});
	pi.on("session_start", (_event, ctx) => syncTools(ctx.model));
	pi.on("model_select", (event) => syncTools(event.model));
	registerSessionImageRepairCommand(pi);

	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description:
			"Apply a Codex apply_patch patch to local files. The input string is the Codex patch envelope beginning with *** Begin Patch and ending with *** End Patch.",
		promptSnippet:
			"Apply Codex-style file patches using the apply_patch patch envelope",
		promptGuidelines: [
			"Use apply_patch for manual file edits when a Codex-style patch is natural; pass the whole patch body as the `input` string.",
			"apply_patch input must use the Codex envelope: `*** Begin Patch`, one or more Add/Delete/Update File sections, and `*** End Patch`.",
			"apply_patch supports `*** Move to:`, optional `*** Environment ID:`, and heredoc bodies copied from `apply_patch <<'PATCH'` shell snippets.",
			"Do not use apply_patch for generated outputs or broad mechanical rewrites where a script or formatter is the clearer tool.",
			"When context-mode tools such as ctx_execute or ctx_execute_file are active, keep using them for large-output analysis; apply_patch is only for committing file mutations.",
		],
		parameters: Type.Object({
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
		}),
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
		name: "shell_command",
		label: "shell_command",
		description:
			"Run a shell command with Codex-compatible parameter names. Prefer Pi/context-mode tools for large output. apply_patch heredocs are intercepted and applied by the apply_patch tool. Long-running commands can return a session_id for write_stdin.",
		promptSnippet:
			"Run shell commands with Codex-compatible shell_command(command, workdir, timeout_ms)",
		promptGuidelines: [
			"Use shell_command when a Codex-style tool call would use `shell_command`; always set `workdir` when operating inside a repository.",
			"shell_command accepts `command`, optional `workdir`, `timeout_ms`, `login`, `shell`, `yield_time_ms`, and `max_output_tokens`.",
			"shell_command intercepts `apply_patch <<'PATCH'` heredocs and routes them to apply_patch instead of executing a shell binary.",
			"Use shell_command with `yield_time_ms` for long-running commands; use write_stdin with the returned `session_id` to send input or poll output.",
			"Do not use shell_command for raw HTTP clients that would dump output into context; use context-mode tools such as ctx_execute, ctx_fetch_and_index, or fetch_content.",
		],
		parameters: Type.Object({
			command: Type.String({
				description: "Shell script to run in the user's default shell.",
			}),
			workdir: Type.Optional(
				Type.String({
					description:
						"Working directory for the command. Defaults to the Pi session cwd.",
				}),
			),
			timeout_ms: Type.Optional(
				Type.Number({
					description: "Maximum command runtime in milliseconds.",
				}),
			),
			shell: Type.Optional(
				Type.String({
					description:
						"Shell executable to use. Defaults to Pi's configured shell resolution.",
				}),
			),
			login: Type.Optional(
				Type.Boolean({
					description:
						"Run the shell with login shell semantics when supported.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description:
						"Return after this many milliseconds if the command is still running, with a session_id.",
				}),
			),
			max_output_tokens: Type.Optional(
				Type.Number({
					description:
						"Approximate maximum output tokens to return, preserving the tail.",
				}),
			),
		}),
		prepareArguments: prepareShellCommandArguments,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const interceptedPatch = extractShellApplyPatch(params.command);
			if (interceptedPatch) {
				return executeApplyPatch(
					interceptedPatch.input,
					interceptedPatch.workdir ?? params.workdir,
					ctx,
				);
			}

			const blockReason = unsafeHttpReason(params.command);
			if (blockReason) {
				return {
					content: [
						{
							type: "text",
							text: `shell_command blocked by ${EXTENSION_NAME}: ${blockReason}`,
						},
					],
					details: { error: blockReason },
					isError: true,
				} as PiToolResult<{ error: string }>;
			}

			if (
				params.login === true ||
				params.shell ||
				params.yield_time_ms !== undefined ||
				params.max_output_tokens !== undefined
			) {
				const workdir = params.workdir
					? resolveToolPath(ctx.cwd, params.workdir)
					: ctx.cwd;
				return executeManagedShellCommand(
					{ ...params, workdir },
					signal,
					ctx,
					onUpdate,
				);
			}

			const workdir = params.workdir
				? resolveToolPath(ctx.cwd, params.workdir)
				: ctx.cwd;
			const bashTool = createBashToolDefinition(workdir);
			return bashTool.execute(
				toolCallId,
				{ command: params.command, timeout: timeoutSeconds(params) },
				signal,
				onUpdate as Parameters<typeof bashTool.execute>[3],
				ctx,
			);
		},
		renderCall(args, theme, context) {
			const interceptedPatch =
				typeof args.command === "string"
					? extractShellApplyPatch(args.command)
					: undefined;
			const label = interceptedPatch
				? formatApplyPatchCall({
						input: interceptedPatch.input,
						workdir: interceptedPatch.workdir ?? args.workdir,
					})
				: formatShellCommandCall(args);
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(label)));
			return text;
		},
		renderResult(result, options, theme, context) {
			const command = (context.args as { command?: unknown } | undefined)
				?.command;
			if (typeof command === "string" && extractShellApplyPatch(command)) {
				return renderApplyPatchResult(
					result as AgentToolResult<ApplyPatchDetails>,
					options,
					theme,
					context,
				);
			}
			const raw = resultText(result);
			const details = result.details as ShellCommandDetails | undefined;
			const failed =
				context.isError ||
				Boolean(
					details?.error ||
						details?.timed_out ||
						details?.aborted ||
						details?.interrupted ||
						(details?.exit_code !== undefined &&
							details.exit_code !== null &&
							details.exit_code !== 0),
				);
			let display: string;
			let color: "accent" | "error" | "success" | "toolOutput";
			if (options.isPartial) {
				display = liveOutputPreview(raw);
				color = "toolOutput";
			} else if (failed) {
				display = raw || summarizeShellResult(details);
				color = "error";
			} else if (options.expanded) {
				display = raw;
				color = "toolOutput";
			} else {
				display = `${details?.running ? "↳" : "✓"} ${summarizeShellResult(details)}`;
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
			"Write to or poll a running shell_command session returned with a session_id.",
		promptSnippet:
			"Send input to, or poll output from, a running shell_command session",
		promptGuidelines: [
			"Use write_stdin only with a `session_id` returned by shell_command.",
			'Use write_stdin with `chars: ""` to poll a running session without sending input.',
		],
		parameters: Type.Object({
			session_id: Type.Number({
				description: "Session ID returned by shell_command.",
			}),
			chars: Type.Optional(
				Type.String({
					description:
						"Characters to write to stdin. Use an empty string to poll only.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: "Milliseconds to wait for output before returning.",
				}),
			),
			max_output_tokens: Type.Optional(
				Type.Number({
					description:
						"Approximate maximum output tokens to return, preserving the tail.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			return executeWriteStdin(params, signal, onUpdate);
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
			const details = result.details as ShellCommandDetails | undefined;
			const failed =
				context.isError ||
				Boolean(
					details?.error ||
						details?.timed_out ||
						details?.aborted ||
						details?.interrupted ||
						(details?.exit_code !== undefined &&
							details.exit_code !== null &&
							details.exit_code !== 0),
				);
			let display: string;
			let color: "accent" | "error" | "success" | "toolOutput";
			if (options.isPartial) {
				display = liveOutputPreview(raw);
				color = "toolOutput";
			} else if (failed) {
				display = raw || summarizeShellResult(details);
				color = "error";
			} else if (options.expanded) {
				display = raw;
				color = "toolOutput";
			} else {
				display = `${details?.running ? "↳" : "✓"} ${summarizeShellResult(details)}`;
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
			"View a local image file by returning it to the model as image content.",
		promptSnippet: "Inspect a local PNG/JPEG/GIF/WebP/BMP image",
		promptGuidelines: [
			"Use view_image when visual inspection of an existing local image is needed.",
			"view_image accepts a local filesystem `path`; do not use it for remote URLs.",
			"On a text-only Codex model, view_image delegates visual inspection to an authenticated image-capable model and returns its concise description.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to a local image file." }),
		}),
		prepareArguments: prepareViewImageArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeViewImage(params, ctx, signal);
		},
	});

	pi.registerTool({
		name: "image_gen",
		label: "image_gen",
		description:
			"Generate a new image from a prompt or edit up to five local or recent conversation images with OpenAI gpt-image-2.",
		promptSnippet:
			"Generate or edit images with gpt-image-2, including local and recent conversation references",
		promptGuidelines: [
			"Use image_gen when the user requests a new image or asks to edit an existing image.",
			"For a new image, call image_gen with only `prompt`.",
			"For edits, use image_gen `referenced_image_paths` when every target has a local path; inspect unseen local images with view_image first.",
			"Use image_gen `num_last_images_to_include` only when a target has no local path, choosing the smallest recent-image count that includes every target, up to 5.",
			"Never provide both image_gen `referenced_image_paths` and `num_last_images_to_include`; ask the user to attach missing images when neither mechanism can include every target.",
		],
		parameters: Type.Object({
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
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			return executeImageGeneration(toolCallId, params, signal, ctx, {
				convertImage: convertToPng,
				withFileMutationQueue,
			});
		},
	});
}
