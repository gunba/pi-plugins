import { lstat, readlink, realpath, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import {
	dirname,
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
	generateDiffString,
	renderDiff,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PATCH_GRAMMAR } from "./patch-grammar.ts";
import { displayPath, displayPathFromCwd, resolveToolPath } from "./paths.ts";
import { extractShellApplyPatch } from "./shell-apply-patch.ts";
import {
	type ExecCommandDetails,
	type ExecRuntimeOwner,
	type ExecRuntimeOwnerFor,
	executeManagedExecCommand,
} from "./shell-runtime.ts";
import {
	prepareApplyPatchArguments,
} from "./tool-arguments.ts";
import {
	formatApplyPatchCall,
	formatExecCommandCall,
	resultText,
	summarizeApplyPatchResult,
	summarizeExecResult,
} from "./tool-rendering.ts";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

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
export type ApplyPatchDetails = {
	changes: ChangeRecord[];
	exitCode: 0 | 1;
	wallTimeSeconds: number;
	error?: string;
};
type PatchAndRunDetails = Partial<ExecCommandDetails> & {
	patch: ApplyPatchDetails;
	skipped?: boolean;
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

// Resolve missing leaves through their existing parent too, so directory aliases
// and dangling leaf symlinks share staged state as well as lock ownership.
async function canonicalPath(path: string): Promise<string> {
	path = resolve(path);
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (entry?.isSymbolicLink())
		return canonicalPath(resolve(dirname(path), await readlink(path)));
	const parent = dirname(path);
	if (parent === path) throw new Error(`Cannot resolve filesystem root: ${path}`);
	return resolve(await canonicalPath(parent), relative(parent, path));
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
	signal?: AbortSignal,
): Promise<{ changes: ChangeRecord[]; baseDir: string }> {
	const outerBaseDir = requestedWorkdir
		? resolveToolPath(ctx.cwd, requestedWorkdir)
		: ctx.cwd;
	const baseDir = parsed.workdir
		? resolveToolPath(outerBaseDir, parsed.workdir)
		: outerBaseDir;
	const throwIfAborted = () => { if (signal?.aborted) throw new Error("Operation aborted"); };
	throwIfAborted();
	const identities = new Map(await Promise.all(
		collectHunkPaths(baseDir, parsed.hunks).map(async (path) =>
			[path, await canonicalPath(path)] as const),
	));
	const identity = (path: string) => identities.get(path)!;

	return withMutationQueues([...identities.values()], async () => {
		throwIfAborted();
		// Do not follow a changed alias using locks acquired for its old target.
		for (const [path, canonical] of identities) {
			if (await canonicalPath(path) !== canonical)
				throw new Error(`File identity changed while waiting: ${path}`);
		}
		throwIfAborted();
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
			const lexicalPath = resolveToolPath(baseDir, hunk.path);
			const sourcePath = identity(lexicalPath);
			if (hunk.type === "delete" || (hunk.type === "update" && hunk.movePath)) {
				const entry = await lstat(lexicalPath).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return undefined;
				});
				if (entry?.isSymbolicLink())
					throw new Error(`Cannot delete or move a symbolic-link entry with apply_patch: ${hunk.path}. Unlink the entry explicitly rather than deleting its target.`);
			}
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
				const destPath = identity(resolveToolPath(baseDir, hunk.movePath));
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
		const attempted = new Map<string, FileState>();

		try {
			throwIfAborted();
			for (const [path, state] of finalStates) {
				throwIfAborted();
				if (state.exists) {
					await ensureParentDirectory(path, createdDirectories);
					throwIfAborted();
					attempted.set(path, originals.get(path)!);
					await writeFile(path, state.content ?? "", "utf8");
				} else {
					attempted.set(path, originals.get(path)!);
					await rm(path, { force: true });
				}
				throwIfAborted();
			}
		} catch (error) {
			const originalMessage =
				error instanceof Error ? error.message : String(error);
			const restoreFailures = await restoreOriginals(attempted);
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

export async function executeApplyPatch(
	input: string,
	workdir: string | undefined,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<ApplyPatchDetails>> {
	const startedAt = process.hrtime.bigint();
	const elapsedSeconds = () =>
		Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
	try {
		const parsed = parsePatch(input);
		const result = await applyParsedPatch(ctx, parsed, workdir, signal);
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

async function executePatchAndRun(
	input: string,
	workdir: string | undefined,
	thenRun: { cmd: string; yield_time_ms?: number; max_output_tokens?: number },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	owner: ExecRuntimeOwner,
): Promise<AgentToolResult<PatchAndRunDetails>> {
	const patch = await executeApplyPatch(input, workdir, ctx, signal);
	const skipped = (reason: string): AgentToolResult<PatchAndRunDetails> => ({
		content: [...patch.content, { type: "text", text: `[then_run:skipped] ${reason}` }],
		details: { patch: patch.details, skipped: true, error: reason },
	});
	if (patch.details.exitCode !== 0) return skipped("Patch did not apply; command was not run.");

	// Another process may edit a target between patch completion and command launch.
	// This check does not lock external writers, but avoids knowingly validating
	// a different set of files from the ones this call just changed.
	try {
		const paths = [...new Set(patch.details.changes.flatMap(change =>
			change.movePath ? [change.path, change.movePath] : [change.path]))];
		const states = await Promise.all(paths.map(path => readOptionalFile(path)));
		await new Promise<void>(resolve => setImmediate(resolve));
		signal?.throwIfAborted();
		for (const [index, path] of paths.entries()) {
			if (!stateEquals(states[index]!, await readOptionalFile(path))) {
				return skipped(`Changed file before command launch: ${path}`);
			}
		}
	} catch (error) {
		return skipped(`Could not verify patched files: ${error instanceof Error ? error.message : String(error)}`);
	}

	try {
		const outerWorkdir = workdir ? resolveToolPath(ctx.cwd, workdir) : ctx.cwd;
		const patchWorkdir = parsePatch(input).workdir;
		const command = await executeManagedExecCommand({
			cmd: thenRun.cmd,
			workdir: patchWorkdir ? resolveToolPath(outerWorkdir, patchWorkdir) : outerWorkdir,
			yield_time_ms: thenRun.yield_time_ms ?? 30_000,
			max_output_tokens: thenRun.max_output_tokens,
		}, signal, ctx, undefined, owner);
		const exit = command.details.exit_code;
		const marker = command.details.running ? "running" : exit === 0 ? "succeeded" : "failed";
		return {
			content: [...patch.content, { type: "text", text: `[then_run:${marker}]\n${resultText(command)}` }],
			details: {
				...command.details,
				patch: patch.details,
				...(exit !== undefined && exit !== 0 ? { error: `Follow-up command exited ${exit}` } : {}),
			},
		};
	} catch (error) {
		return {
			content: [...patch.content, {
				type: "text",
				text: `[then_run:failed] ${error instanceof Error ? error.message : String(error)}. Patch remains applied.`,
			}],
			details: {
				patch: patch.details,
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

type ApplyPatchRenderContext = {
	cwd: string;
	isError: boolean;
	lastComponent: unknown;
};

export function renderApplyPatchResult(
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

export function registerPatchTools(pi: ExtensionAPI, execRuntimeOwnerFor: ExecRuntimeOwnerFor): void {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description:
			"Use the apply_patch tool to edit files. Pass the complete Codex patch envelope in the input field.",
		promptSnippet:
			"Apply Codex-style file patches using the apply_patch patch envelope",
		promptGuidelines: [
			"Grammar-mode patches use the session cwd; use absolute paths for other directories. JSON calls may set workdir.",
			"apply_patch input must use the Codex envelope: `*** Begin Patch`, one or more Add/Delete/Update File sections, and `*** End Patch`.",
			"apply_patch supports `*** Move to:` and heredoc bodies copied from structurally valid `apply_patch <<'PATCH'` shell snippets.",
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
		constrainedSampling: { type: "grammar", variants: { openai_lark: PATCH_GRAMMAR } },
		prepareArguments: prepareApplyPatchArguments,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeApplyPatch(params.input, params.workdir, ctx, signal);
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
		name: "patch_and_run",
		label: "patch_and_run",
		description:
			"Apply a Codex patch, then run one command only after the patch succeeds. A failed command does not roll back the patch.",
		promptSnippet: "Apply a patch and run its follow-up command in one call",
		promptGuidelines: [
			"Use patch_and_run when a specific command should immediately follow a patch; use apply_patch when no command is needed.",
			"If the command outlives the initial wait, use write_stdin with its session_id to collect the result.",
		],
		parameters: Type.Object({
			input: Type.String({ description: "Complete *** Begin Patch / *** End Patch envelope." }),
			workdir: Type.Optional(Type.String({ description: "Base directory for relative patch paths and the command." })),
			then_run: Type.Object({
				cmd: Type.String({ minLength: 1, description: "Command to run after the patch succeeds." }),
				yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Initial output wait in milliseconds (default 30000)." })),
				max_output_tokens: Type.Optional(Type.Integer({ minimum: 0, description: "Model-facing command output budget." })),
			}, { additionalProperties: false }),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executePatchAndRun(params.input, params.workdir, params.then_run, ctx, signal,
				execRuntimeOwnerFor(ctx));
		},
		renderCall(args, theme, context) {
			const label = `${formatApplyPatchCall(args)} → ${formatExecCommandCall({ cmd: args.then_run?.cmd })}`;
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(label)));
			return text;
		},
		renderResult(result, options, theme, context) {
			const details = result.details as PatchAndRunDetails;
			const raw = resultText(result);
			const failed = context.isError || Boolean(details.error || details.skipped ||
				(details.exit_code !== undefined && details.exit_code !== 0) || details.signal);
			const summary = `${summarizeApplyPatchResult(details.patch)} · ${
				details.skipped ? "command skipped" : summarizeExecResult(details)}`;
			const display = failed || options.expanded ? raw : `${details.running ? "↳" : "✓"} ${summary}`;
			const color = failed ? "error" : details.running ? "accent" : options.expanded ? "toolOutput" : "success";
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(display.split("\n").map(line => theme.fg(color, line)).join("\n"));
			return text;
		},
	});

}
