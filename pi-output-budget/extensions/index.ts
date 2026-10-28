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
import { editHint, gitRoot, missingPath, missingPathHint } from "./repair.ts";

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

/** Pi's read, with images capped at IMAGE_BYTES. Its text output is Pi's own: 2000 lines or 50 KB, then offset. */
export function readTool() {
  const definition = createReadToolDefinition(process.cwd());
  return { ...definition, async execute(id: string, params: Parameters<typeof definition.execute>[1], signal: AbortSignal | undefined,
    update: Parameters<typeof definition.execute>[3], ctx: ExtensionToolContext) {
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
    const native = createReadToolDefinition(ctx.cwd, { autoResizeImages: settings.getImageAutoResize(), resizeOptions: { maxBytes: IMAGE_BYTES } });
    try { return await native.execute(id, params, signal, update, imageCapped(ctx)); }
    catch (error) {
      // Reading past the end is an answer, not a failure: there is nothing more.
      const past = /Offset (\d+) is beyond end of file \((\d+) lines? total\)/.exec(error instanceof Error ? error.message : String(error));
      if (!past) throw error;
      return { content: [{ type: "text" as const, text: `[The file has ${past[2]} lines; offset ${past[1]} is past the end. Nothing more to read.]` }], details: undefined };
    }
  } };
}

/**
 * A long text result of a tool that does not cut its own, cut where Pi's read cuts (its first 2000 lines or 50 KB),
 * with the complete text saved where the model can read the rest with read. Undefined when it fits.
 */
export async function cutLikePi(text: string, store: ArtifactStore): Promise<{ text: string; artifact: string } | undefined> {
  const cut = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!cut.truncated) return;
  const artifact = await store.put(text), path = store.path(artifact);
  if (cut.firstLineExceedsLimit) {
    const start = Buffer.from(text, "utf8").subarray(0, DEFAULT_MAX_BYTES).toString("utf8").replace(/\uFFFD$/, "");
    return { artifact, text: `${start}\n\n[Line 1 is ${formatSize(Buffer.byteLength(text.split("\n", 1)[0]!, "utf8"))}, over the ${formatSize(DEFAULT_MAX_BYTES)} limit; this is its start. Full output: ${path}]` };
  }
  const limit = cut.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
  return { artifact, text: `${cut.content}\n\n[Showing lines 1-${cut.outputLines} of ${cut.totalLines}${limit}. Full output: ${path}; read it with offset=${cut.outputLines + 1} to continue.]` };
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
      const path = ["read", "grep", "ls", "find", "edit", "write"].includes(event.toolName) ? missingPath(error, input) : undefined;
      hint = path ? await missingPathHint(path, ctx.cwd, roots) : undefined;
      if (!hint && event.toolName === "edit") hint = editHint(error, input, ctx.cwd);
    } catch { hint = undefined; }
    if (hint) return { content: [...event.content, { type: "text" as const, text: `\n${hint}` }] };
  });
  pi.registerTool(readTool());

  pi.on("tool_result", async (event, ctx) => {
    const details = event.details as { fullOutputPath?: unknown; outputBudgeted?: boolean } | undefined;
    if (details?.outputBudgeted) return;
    const store = outputArtifactStore();
    if (piTool(event.toolName)) {
      // Pi's own spill file is kept, so Desk can show the complete output after Pi deletes it; the result is Pi's.
      // Only that path is followed, never a path a tool or server put in its payload.
      if (typeof details?.fullOutputPath !== "string" || !details || Object.getPrototypeOf(details) !== Object.prototype) return;
      try { return { details: { ...details, full_output_artifact: await store.putFile(details.fullOutputPath) } }; }
      catch { return; }
    }
    if (!event.content.every(block => block.type === "text")) return;
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
