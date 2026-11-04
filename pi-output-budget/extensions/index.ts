import { open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createReadToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, SettingsManager, truncateHead,
  type ExtensionAPI, type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "./artifacts.ts";
import { acquireArtifactAccess } from "./ownership.ts";
import { capAnthropicImages } from "./image-budget.ts";
import { imageRejections, withoutUnreadableImages } from "./image-check.ts";
import { SUPERSEDED, withoutSuperseded } from "./superseded.ts";
import { editHint, gitRoot, missingPath, missingPathHint, selfKillHint } from "./repair.ts";
import type { Static } from "typebox";
import { documentOperations, READ_DOCUMENTS, ReadParameters } from "../../pi-show/extensions/document-read.ts";

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

/** Pi's tools cut their own output (read, bash and PowerShell, grep, find and ls at 2000 lines or 50 KB; codemode
 * and MCP tools at their own limits), so their results are left as Pi made them. */
const piTool = (tool: string) => ["read", "bash", "powershell", "grep", "find", "ls", "codemode"].includes(tool) || tool.startsWith("mcp__");

/**
 * Pi's read, with images capped at IMAGE_BYTES, and PDF and Office files read as text or a page as an image (pi-show).
 * Its text output is Pi's own: 2000 lines or 50 KB, then offset.
 */
export function readTool() {
  const definition = createReadToolDefinition(process.cwd());
  return { ...definition, description: `${definition.description} ${READ_DOCUMENTS}`, parameters: ReadParameters,
    async execute(id: string, { page, ...params }: Static<typeof ReadParameters>, signal: AbortSignal | undefined,
    update: Parameters<typeof definition.execute>[3], ctx: ExtensionToolContext) {
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
    const native = createReadToolDefinition(ctx.cwd, { autoResizeImages: settings.getImageAutoResize(), resizeOptions: { maxBytes: IMAGE_BYTES },
      operations: documentOperations(page) });
    try { return await native.execute(id, params, signal, update, imageCapped(ctx)); }
    catch (error) {
      // Reading past the end is an answer, not a failure: there is nothing more.
      const past = /Offset (\d+) is beyond end of file \((\d+) lines? total\)/.exec(error instanceof Error ? error.message : String(error));
      if (!past) throw error;
      return { content: [{ type: "text" as const, text: `[The file has ${past[2]} lines; offset ${past[1]} is past the end. Nothing more to read.]` }], details: undefined };
    }
  } };
}

/** How much of a long output the model sees: the lines most likely to matter, and where the whole is. */
const EXCERPT_LINES = 40, EXCERPT_BYTES = 3_000;

/**
 * A long output as the model reads it: a line saying how long it is and where the whole of it is, then its first or
 * last lines (a command's end holds its result and errors). The model reads or greps the file for anything else;
 * sending 50 KB of a long output cost about 12,000 tokens, kept in every later request.
 */
export function excerpt(text: string, path: string, from: "head" | "tail", size = Buffer.byteLength(text, "utf8"), complete = true): string {
	const lines = text.split("\n");
	let shown = from === "head" ? lines.slice(0, EXCERPT_LINES) : lines.slice(-EXCERPT_LINES);
	while (shown.length > 1 && Buffer.byteLength(shown.join("\n"), "utf8") > EXCERPT_BYTES) shown = from === "head" ? shown.slice(0, -1) : shown.slice(1);
	let body = shown.join("\n");
	if (Buffer.byteLength(body, "utf8") > EXCERPT_BYTES) {
		const bytes = Buffer.from(body, "utf8");
		body = (from === "head" ? bytes.subarray(0, EXCERPT_BYTES) : bytes.subarray(bytes.length - EXCERPT_BYTES)).toString("utf8").replace(/^\uFFFD|\uFFFD$/g, "");
	}
	const length = complete ? `${lines.length.toLocaleString("en")} ${lines.length === 1 ? "line" : "lines"}, ${formatSize(size)}` : formatSize(size);
	const which = from === "head" ? "first" : "last";
	return `[Output: ${length}. Below: its ${which} ${shown.length === 1 ? "line" : `${shown.length} lines`}. The whole output: ${path} (read or grep it for more).]\n${body}`;
}

/** The start or end of a saved output, without reading a very large file whole. */
async function excerptFile(path: string, from: "head" | "tail"): Promise<string> {
	const { size } = await stat(path);
	if (size <= 32 * 1024 * 1024) return excerpt(await readFile(path, "utf8"), path, from, size);
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, from === "head" ? 0 : size - buffer.length);
		const edge = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
		return excerpt((from === "head" ? edge.slice(0, -1) : edge.slice(1)).join("\n"), path, from, size, false);
	} finally { await handle.close(); }
}

/** A text result over Pi's limits (2000 lines or 50 KB), saved whole and returned as an excerpt. Undefined when it fits. */
export async function cutLikePi(text: string, store: ArtifactStore, from: "head" | "tail" = "head"): Promise<{ text: string; artifact: string } | undefined> {
	if (!truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).truncated) return;
	const artifact = await store.put(text);
	return { artifact, text: excerpt(text, store.path(artifact), from) };
}

/** Commands end with their result; other tools put what matters first. */
const tailFirst = (tool: string) => ["bash", "powershell"].includes(tool);

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
      const path = ["read", "grep", "ls", "find", "edit", "write"].includes(event.toolName) ? missingPath(error, input) : undefined;
      hint = path ? await missingPathHint(path, ctx.cwd, roots) : undefined;
      if (!hint && event.toolName === "edit") hint = editHint(error, input, ctx.cwd);
      if (!hint && event.toolName === "bash") hint = selfKillHint(error, input);
    } catch { hint = undefined; }
    if (hint) return { content: [...event.content, { type: "text" as const, text: `\n${hint}` }] };
  });
  pi.registerTool(readTool());

  pi.on("tool_result", async (event, ctx) => {
    const details = event.details as { fullOutputPath?: unknown; outputBudgeted?: boolean } | undefined;
    if (details?.outputBudgeted) return;
    const store = outputArtifactStore();
    // A call made from a codemode program returns to the program, not the model: it gets the whole result to select
    // from, and the program's own result is the one cut down.
    const nested = !!event.parentToolCallId;
    if (piTool(event.toolName)) {
      // Pi's own spill file is kept, so Desk can show the complete output after Pi deletes it; the result is Pi's.
      // Only that path is followed, never a path a tool or server put in its payload.
      if (typeof details?.fullOutputPath !== "string" || !details || Object.getPrototypeOf(details) !== Object.prototype) return;
      let artifact: string;
      try { artifact = await store.putFile(details.fullOutputPath); } catch { return; }
      if (nested) return { details: { ...details, full_output_artifact: artifact } };
      // Pi kept 50 KB of the output; the model gets an excerpt of the saved whole instead. Images stay as they are.
      let text: string | undefined;
      try { text = await excerptFile(store.path(artifact), tailFirst(event.toolName) ? "tail" : "head"); } catch { text = undefined; }
      const content = text === undefined ? undefined : [{ type: "text" as const, text }, ...event.content.filter(block => block.type !== "text")];
      return { ...(content ? { content } : {}), details: { ...details, full_output_artifact: artifact } };
    }
    if (nested || !event.content.every(block => block.type === "text")) return;
    ctx.signal?.throwIfAborted();
    const cut = await cutLikePi(event.content.map(block => block.type === "text" ? block.text : "").join("\n"), store);
    if (!cut) return;
    const content = [{ type: "text" as const, text: cut.text }];
    // Preserve native details, errors and nested usage.
    const plain = details == null || (typeof details === "object" && !Array.isArray(details) && [Object.prototype, null].includes(Object.getPrototypeOf(details)));
    return plain ? { content, details: { ...details, outputBudgeted: true, outputArtifact: cut.artifact } } : { content };
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
