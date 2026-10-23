import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createReadToolDefinition, detectSupportedImageMimeTypeFromFile, getAgentDir, SettingsManager,
  type ExtensionAPI, type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ArtifactStore, boundedText } from "./artifacts.ts";
import { cutText, type Kept, MAX_CHARS, OUTPUT_CHARS, READ_CHARS } from "./text.ts";
import { acquireArtifactAccess } from "./ownership.ts";
import { capAnthropicImages } from "./image-budget.ts";
import { imageRejections, withoutUnreadableImages } from "./image-check.ts";
import { SUPERSEDED, withoutSuperseded } from "./superseded.ts";
import { editHint, gitRoot, missingPath, missingPathHint } from "./repair.ts";

const readSchema = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  full: Type.Optional(Type.Boolean({ description: `Request a larger preview, up to ${MAX_CHARS} characters; excess remains retrievable.` })),
}, { additionalProperties: false });

export function outputArtifactStore(): ArtifactStore {
  return new ArtifactStore(join(getAgentDir(), "tool-output"));
}

/**
 * The most an image read sends, within the model's own limits (Pi's are 2000 pixels a side and 4.5 MB). Every
 * request resends every image in the conversation, and full-size screenshots pushed conversations past
 * Anthropic's 32 MB request limit.
 */
const IMAGE_BYTES = 1.5 * 1024 * 1024;

/** The context the native reader sees: Pi resizes to the model's image limits, so the cap goes into them. */
function imageCapped(ctx: ExtensionToolContext): ExtensionToolContext {
  const model = ctx.model, images = model?.inputLimits?.images;
  if (!model) return ctx;
  const resize = { ...images?.resize, maxBytes: Math.min(images?.resize?.maxBytes ?? IMAGE_BYTES, IMAGE_BYTES) };
  return Object.create(ctx, { model: { value: { ...model, inputLimits: { ...model.inputLimits, images: { ...images, resize } } } } });
}

/**
 * Which part of its output each of Pi's own tools keeps when it cuts it: bash and PowerShell the last 50 KB, grep,
 * find and ls the first 50 KB, codemode (its max_output_tokens) and MCP tools (20 KB) the start and end. Their longer
 * results are cut to OUTPUT_CHARS in the same place, so the two cuts act as one.
 */
const PI_CUTS: Record<string, Kept> = { bash: "end", powershell: "end", grep: "start", find: "start", ls: "start", codemode: "start and end" };
const piCut = (tool: string): Kept | undefined => PI_CUTS[tool] ?? (tool.startsWith("mcp__") ? "start and end" : undefined);

/** Use the native reader for path resolution, image processing, errors and cancellation. */
export async function readSnapshot(id: string, params: Static<typeof readSchema>, signal: AbortSignal | undefined,
  ctx: ExtensionToolContext, store: ArtifactStore, budget = params.full ? MAX_CHARS : READ_CHARS) {
  let snapshot: Buffer | undefined;
  let image = false;
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
  const native = createReadToolDefinition(ctx.cwd, {
    autoResizeImages: settings.getImageAutoResize(),
    resizeOptions: { maxBytes: IMAGE_BYTES },
    operations: {
      access: path => access(path, constants.R_OK),
      readFile: async path => {
        const value = await readFile(path, { signal });
        snapshot = value;
        return value;
      },
      detectImageMimeType: async path => {
        const mime = await detectSupportedImageMimeTypeFromFile(path);
        image = !!mime;
        return mime;
      },
    },
  });
  let result;
  try { result = await native.execute(id, params, signal, undefined, imageCapped(ctx)); }
  catch (error) {
    // Reading past the end is an answer, not a failure: there is nothing more.
    const past = /Offset (\d+) is beyond end of file \((\d+) lines? total\)/.exec(error instanceof Error ? error.message : String(error));
    if (!past) throw error;
    return { content: [{ type: "text" as const, text: `[The file has ${past[2]} lines; offset ${past[1]} is past the end. Nothing more to read.]` }],
      details: { sourcePath: params.path, firstLine: Number(past[1]), lastLine: Number(past[2]), capturedChars: 0 } };
  }
  signal?.throwIfAborted();
  if (image || snapshot === undefined) return result;
  const lines = snapshot.toString("utf8").split("\n");
  const start = (params.offset ?? 1) - 1;
  const end = params.limit === undefined ? lines.length : Math.min(lines.length, start + params.limit);
  const selected = lines.slice(start, end).join("\n");
  const bounded = await boundedText(store, selected, budget);
  if (end < lines.length) bounded.content[0]!.text += `\n\n[${lines.length - end} more source lines. Use read offset=${end + 1}. The artifact, if present, contains only the requested range.]`;
  return { ...bounded, details: { ...bounded.details, sourcePath: params.path, firstLine: start + 1, lastLine: end, capturedChars: selected.length } };
}

/** Safe to install explicitly in SDK children; does not discover unrelated extensions. */
export default function outputBudget(pi: ExtensionAPI): void {
  pi.on("session_start", async () => { await acquireArtifactAccess(outputArtifactStore().directory); });
  // Folders the conversation works in, from files it read or changed: where a mistyped relative path is likely to be.
  const roots: string[] = [];
  pi.on("tool_result", async (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    if (!event.isError) {
      if (["read", "edit", "write"].includes(event.toolName) && typeof input.path === "string") {
        const folder = dirname(resolve(ctx.cwd, input.path)), root = gitRoot(folder) ?? folder;
        if (!roots.includes(root)) { roots.unshift(root); roots.length = Math.min(roots.length, 12); }
      }
      return;
    }
    const error = event.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    let hint: string | undefined;
    try {
      const path = ["read", "grep", "ls", "find", "edit", "write"].includes(event.toolName) ? missingPath(event.toolName, error, input) : undefined;
      hint = path ? await missingPathHint(path, ctx.cwd, roots) : undefined;
      if (!hint && event.toolName === "edit") hint = editHint(error, input, ctx.cwd);
    } catch { hint = undefined; }
    if (hint) return { content: [...event.content, { type: "text" as const, text: `\n${hint}` }] };
  });
  pi.registerTool({
    name: "read", label: "read", parameters: readSchema,
    description: `Read text or images with native path/image handling. Text previews are limited to ${READ_CHARS} characters; complete requested text ranges are archived when truncated. Use offset/limit for source lines, full=true for up to ${MAX_CHARS} characters, or read_artifact for the immutable captured remainder.`,
    promptSnippet: "Read file contents",
    execute: (id, params, signal, _update, ctx) => readSnapshot(id, params, signal, ctx, outputArtifactStore()),
  });

  pi.registerTool({
    name: "read_artifact", label: "read_artifact",
    description: "Read or search an immutable local tool-output artifact. Offsets count UTF-16 characters, not lines. Follow next_offset until null for complete coverage. query performs literal, case-sensitive line search; offsets then refer to the search results.",
    parameters: Type.Object({
      artifact: Type.String({ pattern: "^sha256-[a-f0-9]{64}$" }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      length: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CHARS })),
      query: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const store = outputArtifactStore();
      signal?.throwIfAborted();
      const result = params.query === undefined
        ? await store.readPage(params.artifact, params.offset ?? 0, params.length ?? OUTPUT_CHARS)
        : await store.searchPage(params.artifact, params.query, params.offset ?? 0, params.length ?? OUTPUT_CHARS);
      signal?.throwIfAborted();
      return {
        content: [{ type: "text" as const, text: `${result.text}\n\n[${params.query === undefined ? "Artifact" : "Search results"}: ${result.total_chars} characters; next_offset=${result.next_offset ?? "null"}]` }],
        details: { outputBudgeted: true, artifact: params.artifact, ...result, text: undefined },
      };
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    const details = event.details as { fullOutputPath?: unknown; outputBudgeted?: boolean } | undefined;
    if (details?.outputBudgeted) return;
    const keep = piCut(event.toolName);
    // Only Pi's own spill files are followed, never a path a tool or server put in its payload.
    const full = keep && typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
    const text = event.content.map(block => block.type === "text" ? block.text : "").join("\n");
    const cut = event.content.every(block => block.type === "text") && text.length > OUTPUT_CHARS;
    if (!cut && !full) return;
    ctx.signal?.throwIfAborted();
    const store = outputArtifactStore();
    let complete: string | undefined;
    if (full) try { complete = await store.putFile(full); } catch { /* Reported below; Pi's own notice names the file. */ }
    const result: { content: typeof event.content; details: Record<string, unknown> } = { content: [...event.content],
      details: complete ? { full_output_artifact: complete } : {} };
    if (cut && keep) {
      const uncut = complete ?? await store.put(text);
      result.content = [{ type: "text", text: `${cutText(text, keep, OUTPUT_CHARS)}\n\n[Cut to its ${keep}, ${OUTPUT_CHARS} of ${text.length} characters. ${complete ? "Complete output" : "Uncut text"}: ${uncut}; use read_artifact.]` }];
      result.details = { ...result.details, outputBudgeted: true, ...(complete ? {} : { outputArtifact: uncut }) };
    } else if (cut) {
      const bounded = await boundedText(store, text);
      result.content = bounded.content; result.details = { ...result.details, ...bounded.details };
    } else if (complete) result.content.push({ type: "text", text: `[Complete output: ${complete}; use read_artifact.]` });
    if (full && !complete) result.content.push({ type: "text", text: `[Could not archive the complete output; it is in ${full} until Pi deletes it.]` });
    // Preserve native details (including complete-output paths), errors and nested usage.
    const plainDetails = details == null || (typeof details === "object" && !Array.isArray(details)
      && [Object.prototype, null].includes(Object.getPrototypeOf(details)));
    return plainDetails
      ? { content: result.content, details: { ...details, ...result.details } }
      : { content: result.content };
  });

  // context_with_system: only message content changes, so prompt and tool changes stay where they are.
  pi.on("context_with_system", (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    let messages = withoutSuperseded(event.messages, branch, ctx.model, ctx.cwd, stubs => pi.appendEntry(SUPERSEDED, { stubs })) ?? event.messages;
    messages = withoutUnreadableImages(messages, imageRejections(branch)) ?? messages;
    if (messages !== event.messages) return { messages };
  });
  // Budgets apply only when a result is created. Earlier results are never rewritten later: replacing them
  // mid-conversation changed the prompt prefix and broke warm caches (first-turn misses rose from ~2% to 6–10%).
  capAnthropicImages(pi);
}
