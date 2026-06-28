import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  createBashToolDefinition,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
type UpdateFileHunk = { type: "update"; path: string; movePath?: string; chunks: UpdateFileChunk[] };
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
type ApplyPatchDetails = { changes: ChangeRecord[]; environmentId?: string; error?: string };
type PiToolResult<T> = AgentToolResult<T> & { isError?: boolean };

type FileState = { exists: boolean; content?: string };
type ChangeRecord = { action: "added" | "deleted" | "updated" | "moved"; path: string; movePath?: string };

type ApplyPatchParams = { input: string; workdir?: string };
type ShellCommandParams = {
  command: string;
  workdir?: string;
  timeout_ms?: number;
  timeout?: number;
  login?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function normalizePathArgument(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function resolveToolPath(baseDir: string, path: string): string {
  const normalized = normalizePathArgument(path.trim());
  if (!normalized) throw new Error("path cannot be empty");
  return isAbsolute(normalized) ? resolve(normalized) : resolve(baseDir, normalized);
}

function displayPath(ctx: ExtensionContext, absolutePath: string): string {
  const rel = relative(ctx.cwd, absolutePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath;
}

function prepareApplyPatchArguments(args: unknown): ApplyPatchParams {
  if (typeof args === "string") return { input: args };
  if (!isRecord(args)) return args as ApplyPatchParams;

  const command = args.command;
  if (Array.isArray(command)) {
    const commandName = command[0];
    const body = command[1];
    if ((commandName === "apply_patch" || commandName === "applypatch") && typeof body === "string") {
      return { input: body, workdir: firstString(args.workdir) };
    }
  }

  const input = firstString(args.input, args.patch, args.body, args.text);
  if (input !== undefined) return { input, workdir: firstString(args.workdir) };
  return args as ApplyPatchParams;
}

function prepareShellCommandArguments(args: unknown): ShellCommandParams {
  if (typeof args === "string") return { command: args };
  if (!isRecord(args)) return args as ShellCommandParams;
  const command = firstString(args.command, args.cmd, args.script);
  return command === undefined ? (args as ShellCommandParams) : { ...args, command } as ShellCommandParams;
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
    : /\s(-O|--output-document)\s/.test(s) || /\s>\s*/.test(s) || /\s>>\s*/.test(s);
  if (!hasFileOutput) return false;
  if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(s)) return false;
  if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(s)) return false;
  if (/\s(-v|--verbose|--trace)\b/.test(s)) return false;
  return isCurl ? /\s-[a-zA-Z]*s|--silent/.test(s) : /\s-[a-zA-Z]*q|--quiet/.test(s);
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
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractShellApplyPatch(command: string): { input: string; workdir?: string } | undefined {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:(?:cd\s+(.+?)\s*&&\s*)?apply_?patch\s+<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*\n)([\s\S]*?)\n\s*\2\s*$/);
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
    if ((first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith("EOF")) {
      return { input: lines.slice(1, -1).join("\n") };
    }
  }
  return { input: trimmed };
}

function splitPatchLines(input: string): string[] {
  if (input.length === 0) return [];
  return input.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function parsePatch(input: string): ParsedPatch {
  const unwrapped = unwrapPatchInput(input);
  const lines = splitPatchLines(unwrapped.input.trim());
  if (lines.length === 0 || lines[0].trim() !== BEGIN_PATCH_MARKER) {
    throw new Error("invalid patch: The first line of the patch must be '*** Begin Patch'");
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
      throw new Error(`invalid hunk at line ${currentUpdateLine}, Update file hunk for path '${update.path}' is empty`);
    }
    const lastChunk = update.chunks[update.chunks.length - 1];
    if (lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
      const message = line === END_PATCH_MARKER
        ? "Update hunk does not contain any lines"
        : `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;
      throw new Error(`invalid hunk at line ${lineNumber}, ${message}`);
    }
  };

  const handleHeaders = (line: string, lineNumber: number): boolean => {
    if (mode === "started" && line.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (environmentId !== undefined) throw new Error("invalid patch: apply_patch environment_id cannot be specified more than once");
      const id = line.slice(ENVIRONMENT_ID_MARKER.length).trim();
      if (!id) throw new Error("invalid patch: apply_patch environment_id cannot be empty");
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
      hunks.push({ type: "add", path: line.slice(ADD_FILE_MARKER.length), contents: "" });
      mode = "add";
      return true;
    }
    if (line.startsWith(DELETE_FILE_MARKER)) {
      ensureUpdateHunkIsNotEmpty(line, lineNumber);
      hunks.push({ type: "delete", path: line.slice(DELETE_FILE_MARKER.length) });
      mode = "delete";
      return true;
    }
    if (line.startsWith(UPDATE_FILE_MARKER)) {
      ensureUpdateHunkIsNotEmpty(line, lineNumber);
      hunks.push({ type: "update", path: line.slice(UPDATE_FILE_MARKER.length), chunks: [] });
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
      throw new Error("invalid patch: The last line of the patch must be '*** End Patch'");
    }

    if (mode === "started") {
      if (handleHeaders(trimmed, lineNumber)) continue;
      throw new Error(`invalid hunk at line ${lineNumber}, '${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`);
    }

    if (mode === "add") {
      if (handleHeaders(trimmed, lineNumber)) continue;
      const hunk = hunks[hunks.length - 1];
      if (hunk?.type === "add" && line.startsWith("+")) {
        hunk.contents += `${line.slice(1)}\n`;
        continue;
      }
      throw new Error(`invalid hunk at line ${lineNumber}, '${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`);
    }

    if (mode === "delete") {
      if (handleHeaders(trimmed, lineNumber)) continue;
      throw new Error(`invalid hunk at line ${lineNumber}, '${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`);
    }

    const update = lastUpdate();
    if (!update) throw new Error(`invalid hunk at line ${lineNumber}, unexpected update line`);
    const updateLine = line.trimEnd();
    if (handleHeaders(updateLine, lineNumber)) continue;

    const lastChunk = update.chunks[update.chunks.length - 1];
    if (lastChunk?.isEndOfFile) {
      if (updateLine.length === 0) continue;
      if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
        throw new Error(`invalid hunk at line ${lineNumber}, Expected update hunk to start with a @@ context marker, got: '${line}'`);
      }
    }

    if (update.chunks.length === 0 && update.movePath === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
      update.movePath = updateLine.slice(MOVE_TO_MARKER.length);
      continue;
    }

    if ((updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) && lastChunk && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
      throw new Error(`invalid hunk at line ${lineNumber}, Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
    }

    if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
      update.chunks.push({ oldLines: [], newLines: [], isEndOfFile: false });
      continue;
    }
    if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
      update.chunks.push({ changeContext: updateLine.slice(CHANGE_CONTEXT_MARKER.length), oldLines: [], newLines: [], isEndOfFile: false });
      continue;
    }
    if (updateLine === EOF_MARKER) {
      if (!lastChunk || (lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0)) {
        throw new Error(`invalid hunk at line ${lineNumber}, Update hunk does not contain any lines`);
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
    if (lastChunk && (lastChunk.oldLines.length > 0 || lastChunk.newLines.length > 0)) {
      throw new Error(`invalid hunk at line ${lineNumber}, Expected update hunk to start with a @@ context marker, got: '${line}'`);
    }
    throw new Error(`invalid hunk at line ${lineNumber}, Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
  }

  if (mode !== "ended") throw new Error("invalid patch: The last line of the patch must be '*** End Patch'");
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
  return value.trim().replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, " ");
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
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

function deriveNewContents(originalContents: string, chunks: UpdateFileChunk[], path: string): string {
  const originalLines = originalContents.split("\n");
  if (originalLines[originalLines.length - 1] === "") originalLines.pop();

  const replacements: Array<{ start: number; oldLength: number; newLines: string[] }> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const found = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (found === undefined) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
      lineIndex = found + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({ start: originalLines.length, oldLength: 0, newLines: [...chunk.newLines] });
      continue;
    }

    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === undefined && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      newLines = newLines[newLines.length - 1] === "" ? newLines.slice(0, -1) : newLines;
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === undefined) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push({ start: found, oldLength: pattern.length, newLines: [...newLines] });
    lineIndex = found + pattern.length;
  }

  const nextLines = [...originalLines];
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
  }
  if (nextLines[nextLines.length - 1] !== "") nextLines.push("");
  return nextLines.join("\n");
}

async function readOptionalFile(path: string): Promise<FileState> {
  try {
    return { exists: true, content: await readFile(path, "utf8") };
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

function stateEquals(a: FileState, b: FileState): boolean {
  return a.exists === b.exists && a.content === b.content;
}

async function restoreOriginals(originals: Map<string, FileState>): Promise<void> {
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
    if (hunk.type === "update" && hunk.movePath) paths.push(resolveToolPath(baseDir, hunk.movePath));
  }
  return paths;
}

async function withMutationQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const unique = [...new Set(paths.map((path) => resolve(path)))].sort();
  let run = fn;
  for (let index = unique.length - 1; index >= 0; index--) {
    const path = unique[index];
    const previous = run;
    run = () => withFileMutationQueue(path, previous);
  }
  return run();
}

async function applyParsedPatch(ctx: ExtensionContext, parsed: ParsedPatch, requestedWorkdir?: string): Promise<{ changes: ChangeRecord[]; baseDir: string }> {
  const requestedBaseDir = requestedWorkdir ?? parsed.workdir;
  const baseDir = requestedBaseDir ? resolveToolPath(ctx.cwd, requestedBaseDir) : ctx.cwd;
  const queuePaths = collectHunkPaths(baseDir, parsed.hunks);

  return withMutationQueues(queuePaths, async () => {
    const originals = new Map<string, FileState>();
    const states = new Map<string, FileState>();
    const changes: ChangeRecord[] = [];

    const load = async (path: string): Promise<FileState> => {
      const absolute = resolve(path);
      const existing = states.get(absolute);
      if (existing) return existing;
      const original = await readOptionalFile(absolute);
      originals.set(absolute, { ...original });
      states.set(absolute, { ...original });
      return states.get(absolute)!;
    };

    const setState = async (path: string, state: FileState) => {
      const absolute = resolve(path);
      if (!originals.has(absolute)) originals.set(absolute, await readOptionalFile(absolute));
      states.set(absolute, { ...state });
    };

    for (const hunk of parsed.hunks) {
      const sourcePath = resolveToolPath(baseDir, hunk.path);
      if (hunk.type === "add") {
        await setState(sourcePath, { exists: true, content: hunk.contents });
        changes.push({ action: "added", path: sourcePath });
        continue;
      }

      const source = await load(sourcePath);
      if (!source.exists) throw new Error(`Failed to read file ${hunk.path}`);

      if (hunk.type === "delete") {
        await setState(sourcePath, { exists: false });
        changes.push({ action: "deleted", path: sourcePath });
        continue;
      }

      const newContent = deriveNewContents(source.content ?? "", hunk.chunks, hunk.path);
      if (hunk.movePath) {
        const destPath = resolveToolPath(baseDir, hunk.movePath);
        await setState(destPath, { exists: true, content: newContent });
        if (destPath !== sourcePath) await setState(sourcePath, { exists: false });
        changes.push({ action: "moved", path: sourcePath, movePath: destPath });
      } else {
        await setState(sourcePath, { exists: true, content: newContent });
        changes.push({ action: "updated", path: sourcePath });
      }
    }

    const finalStates = [...states].filter(([path, state]) => {
      const original = originals.get(path);
      return original ? !stateEquals(original, state) : true;
    });

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

    return { changes, baseDir };
  });
}

function formatApplyPatchResult(ctx: ExtensionContext, changes: ChangeRecord[], environmentId?: string): string {
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

async function executeApplyPatch(input: string, workdir: string | undefined, ctx: ExtensionContext): Promise<PiToolResult<ApplyPatchDetails>> {
  try {
    const parsed = parsePatch(input);
    const result = await applyParsedPatch(ctx, parsed, workdir);
    return {
      content: [{ type: "text", text: formatApplyPatchResult(ctx, result.changes, parsed.environmentId) }],
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
  const raw = params.timeout_ms ?? (params.timeout !== undefined ? params.timeout * 1000 : undefined);
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.ceil(raw / 1000);
}

export default function codexCompat(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch",
    description: "Apply a Codex apply_patch patch to local files. The input string is the Codex patch envelope beginning with *** Begin Patch and ending with *** End Patch.",
    promptSnippet: "Apply Codex-style file patches using the apply_patch patch envelope",
    promptGuidelines: [
      "Use apply_patch for manual file edits when a Codex-style patch is natural; pass the whole patch body as the `input` string.",
      "apply_patch input must use the Codex envelope: `*** Begin Patch`, one or more Add/Delete/Update File sections, and `*** End Patch`.",
      "apply_patch supports `*** Move to:`, optional `*** Environment ID:`, and heredoc bodies copied from `apply_patch <<'PATCH'` shell snippets.",
      "Do not use apply_patch for generated outputs or broad mechanical rewrites where a script or formatter is the clearer tool.",
      "When context-mode tools such as ctx_execute or ctx_execute_file are active, keep using them for large-output analysis; apply_patch is only for committing file mutations.",
    ],
    parameters: Type.Object({
      input: Type.String({ description: "Codex apply_patch patch text. Include the full *** Begin Patch / *** End Patch envelope." }),
      workdir: Type.Optional(Type.String({ description: "Base directory for relative patch paths. Defaults to the Pi session cwd." })),
    }),
    prepareArguments: prepareApplyPatchArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeApplyPatch(params.input, params.workdir, ctx);
    },
  });

  pi.registerTool({
    name: "shell_command",
    label: "shell_command",
    description: "Run a shell command with Codex-compatible parameter names. Prefer Pi/context-mode tools for large output. apply_patch heredocs are intercepted and applied by the apply_patch tool.",
    promptSnippet: "Run shell commands with Codex-compatible shell_command(command, workdir, timeout_ms)",
    promptGuidelines: [
      "Use shell_command when a Codex-style tool call would use `shell_command`; always set `workdir` when operating inside a repository.",
      "shell_command accepts `command`, optional `workdir`, and optional `timeout_ms`; it maps to Pi's normal bash execution backend.",
      "shell_command intercepts `apply_patch <<'PATCH'` heredocs and routes them to apply_patch instead of executing a shell binary.",
      "Do not use shell_command for raw HTTP clients that would dump output into context; use context-mode tools such as ctx_execute, ctx_fetch_and_index, or fetch_content.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell script to run in the user's default shell." }),
      workdir: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the Pi session cwd." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Maximum command runtime in milliseconds." })),
      login: Type.Optional(Type.Boolean({ description: "Accepted for Codex compatibility; login shells are not enabled by this wrapper." })),
    }),
    prepareArguments: prepareShellCommandArguments,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (params.login === true) {
        return {
          content: [{ type: "text", text: "shell_command failed: login shell mode is not supported by this Pi compatibility wrapper; omit `login` or set it to false." }],
          details: { error: "login shell mode is not supported" },
          isError: true,
        } as PiToolResult<{ error: string }>;
      }

      const interceptedPatch = extractShellApplyPatch(params.command);
      if (interceptedPatch) {
        return executeApplyPatch(interceptedPatch.input, interceptedPatch.workdir ?? params.workdir, ctx);
      }

      const blockReason = unsafeHttpReason(params.command);
      if (blockReason) {
        return {
          content: [{ type: "text", text: `shell_command blocked by ${EXTENSION_NAME}: ${blockReason}` }],
          details: { error: blockReason },
          isError: true,
        } as PiToolResult<{ error: string }>;
      }

      const workdir = params.workdir ? resolveToolPath(ctx.cwd, params.workdir) : ctx.cwd;
      const bashTool = createBashToolDefinition(workdir);
      return bashTool.execute(
        toolCallId,
        { command: params.command, timeout: timeoutSeconds(params) },
        signal,
        onUpdate as Parameters<typeof bashTool.execute>[3],
        ctx,
      );
    },
  });
}
