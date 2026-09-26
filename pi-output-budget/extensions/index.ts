import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createReadToolDefinition, detectSupportedImageMimeTypeFromFile, getAgentDir, SettingsManager,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ArtifactStore, boundedText } from "./artifacts.ts";
import { literalMatches, MAX_CHARS, OUTPUT_CHARS, page, READ_CHARS } from "./text.ts";
import { acquireArtifactAccess } from "./ownership.ts";

const readSchema = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  full: Type.Optional(Type.Boolean({ description: `Request a larger preview, up to ${MAX_CHARS} characters; excess remains retrievable.` })),
}, { additionalProperties: false });

const ARTIFACT_ID = /^sha256-[a-f0-9]{64}$/;
const FULL_REPLAYS = 2;
type MessageEntry = Extract<ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number], { type: "message" }>;
type AgentMessage = MessageEntry["message"];

function archivedResultId(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult" || message.isError ||
    message.content.length === 0 || message.content.some(block => block.type !== "text")) return;
  const details = message.details;
  if (!details || typeof details !== "object" || !("outputBudgeted" in details) ||
    details.outputBudgeted !== true || !("outputArtifact" in details)) return;
  const id = details.outputArtifact;
  return typeof id === "string" && ARTIFACT_ID.test(id) ? id : undefined;
}

function replayKey(toolCallId: string, id: string): string {
  return `${toolCallId}\0${id}`;
}

export function archivedReplayCandidates(messages: AgentMessage[]): Set<string> {
  const eligible = new Set<string>();
  let assistantsAfter = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant") { assistantsAfter++; continue; }
    if (assistantsAfter < FULL_REPLAYS || message.role !== "toolResult") continue;
    const id = archivedResultId(message);
    if (id) eligible.add(replayKey(message.toolCallId, id));
  }
  return eligible;
}

export async function slimArchivedResults(
  messages: AgentMessage[],
  store: ArtifactStore,
  checked: Set<string>,
  eligible: Set<string>,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  let projected: AgentMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "toolResult") continue;
    const id = archivedResultId(message);
    if (!id || !eligible.has(replayKey(message.toolCallId, id))) continue;
    if (!checked.has(id)) {
      signal?.throwIfAborted();
      try {
        const entry = await lstat(store.path(id));
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
      } catch { continue; }
      checked.add(id);
    }
    projected ??= [...messages];
    projected[index] = {
      ...message,
      content: [{
        type: "text",
        text: `[Earlier tool result archived as ${id}. Use read_artifact({artifact:"${id}",offset:0}) to retrieve the captured text; follow next_offset for the rest.]`,
      }],
    };
  }
  return projected ?? messages;
}

export function outputArtifactStore(): ArtifactStore {
  return new ArtifactStore(join(getAgentDir(), "tool-output"));
}

/** Use the native reader for path resolution, image processing, errors and cancellation. */
export async function readSnapshot(id: string, params: Static<typeof readSchema>, signal: AbortSignal | undefined,
  ctx: ExtensionContext, store: ArtifactStore, budget = params.full ? MAX_CHARS : READ_CHARS) {
  let snapshot: Buffer | undefined;
  let image = false;
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
  const native = createReadToolDefinition(ctx.cwd, {
    autoResizeImages: settings.getImageAutoResize(),
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
  const result = await native.execute(id, params, signal, undefined, ctx);
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
  const checkedReplayArtifacts = new Set<string>();
  const replayCandidates = new Map<string, Set<string>>();
  pi.on("session_start", async () => { await acquireArtifactAccess(outputArtifactStore().directory); });
  pi.registerTool({
    name: "read", label: "read", parameters: readSchema,
    description: `Read text or images with native path/image handling. Text previews are limited to ${READ_CHARS} characters; complete requested text ranges are archived when truncated. Use offset/limit for source lines, full=true for up to ${MAX_CHARS} characters, or read_artifact for the immutable captured remainder.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Truncated reads are archived. read_artifact pages use next_offset; null marks the end of the captured content."],
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

  pi.registerTool({
    name: "inspect_files", label: "inspect_files",
    description: "Inspect up to 20 explicit files in one read-only call. Each request reads a line range or searches that range for a literal string. Results preserve request order and per-file errors; large results are archived. Images must use read.",
    parameters: Type.Object({
      requests: Type.Array(Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        query: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }),
    async execute(id, params, signal, _update, ctx) {
      const store = outputArtifactStore();
      const sections: string[] = [];
      let errors = 0;
      // Bounded sequential disk work; batching removes model round trips, not safety checks.
      for (const [index, request] of params.requests.entries()) {
        signal?.throwIfAborted();
        try {
          const result = await readSnapshot(`${id}-${index}`, request, signal, ctx, store, MAX_CHARS);
          if (result.content.some(block => block.type !== "text") || !result.details || !("sourcePath" in result.details)) {
            throw new Error("Use read for images");
          }
          const artifact = "outputArtifact" in result.details ? result.details.outputArtifact : undefined;
          const preview = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
          // Keep each file's archive handle instead of expanding every large file into memory.
          let output = preview;
          if (request.query !== undefined) {
            const text = typeof artifact === "string" ? await store.get(artifact)
              : preview.slice(0, result.details.capturedChars);
            const matches = literalMatches(text, request.query);
            const bounded = await boundedText(store, matches, MAX_CHARS);
            output = bounded.content[0]!.text;
          }
          sections.push(`--- ${index + 1}. ${request.path} ---\n${output || "[No matches]"}`);
        } catch (error) {
          signal?.throwIfAborted();
          errors++;
          sections.push(`--- ${index + 1}. ${request.path} ---\nERROR: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const result = await boundedText(store, sections.join("\n\n"), READ_CHARS);
      return { ...result, details: { ...result.details, requests: params.requests.length, errors } };
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    const native = event.details as {
      fullOutputPath?: string; full_output_artifact?: string; outputBudgeted?: boolean;
      outputGuard?: { truncated?: boolean; fullOutputPath?: string };
    } | undefined;
    if (native?.outputBudgeted) return;
    // outputGuard is local adapter metadata, not the server-controlled mcpResult.
    const mcpSpill = native?.outputGuard?.truncated === true && typeof native.outputGuard.fullOutputPath === "string"
      ? native.outputGuard.fullOutputPath : undefined;
    const textOnly = event.content.every(block => block.type === "text");
    if (!textOnly && !mcpSpill) return;
    const text = event.content.map(block => block.type === "text" ? block.text : "").join("\n");
    const bashLog = (event.toolName === "bash" || event.toolName === "powershell") ? native?.fullOutputPath : undefined;
    if (text.length <= OUTPUT_CHARS && !bashLog && !mcpSpill) return;
    ctx.signal?.throwIfAborted();
    const store = outputArtifactStore();
    if (mcpSpill) {
      let notice: string;
      try {
        const full = await store.putFile(mcpSpill);
        ctx.signal?.throwIfAborted();
        notice = `\n[Complete MCP text: ${full}; use read_artifact with offset=0.]`;
        return {
          content: textOnly
            ? [{ type: "text" as const, text: page(text).text + notice }]
            : [...event.content, { type: "text" as const, text: notice }],
          details: { ...event.details as object, outputBudgeted: true, outputArtifact: full, full_output_artifact: full },
        };
      } catch {
        ctx.signal?.throwIfAborted();
        notice = `\n[Could not archive complete MCP text. The preview is incomplete; original spill: ${mcpSpill}]`;
      }
      if (!textOnly) return { content: [...event.content, { type: "text" as const, text: notice }] };
      const fallback = await boundedText(store, notice + "\n" + text);
      return { content: fallback.content, details: { ...event.details as object, ...fallback.details } };
    }
    const result = await boundedText(store, text);
    if ((event.toolName === "exec_command" || event.toolName === "write_stdin") && native?.full_output_artifact) {
      result.content[0]!.text += `\n[Complete command output: ${native.full_output_artifact}; use read_artifact.]`;
    }
    if (bashLog) {
      try {
        const full = await store.putFile(bashLog);
        result.content[0]!.text += `\n[Complete command output: ${full}; use read_artifact.]`;
        return { content: result.content, details: { ...event.details as object, ...result.details, full_output_artifact: full } };
      } catch {
        result.content[0]!.text += `\n[Could not archive the complete native command log. Retrieve omitted output from the native log: ${bashLog}]`;
      }
    }
    // Preserve native details (including complete shell-log paths), errors and nested usage.
    const details = event.details;
    const plainDetails = details == null || (typeof details === "object" && !Array.isArray(details)
      && [Object.prototype, null].includes(Object.getPrototypeOf(details)));
    return plainDetails
      ? { content: result.content, details: { ...details as object, ...result.details } }
      : { content: result.content };
  });

  // Freeze the selection at the start of a turn. Changing old tool results
  // during a tool-call chain would invalidate Codex Wire's incremental prefix.
  pi.on("before_agent_start", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const messages = branch.flatMap(entry => entry.type === "message" ? [entry.message] : []);
    replayCandidates.set(ctx.sessionManager.getSessionId(), archivedReplayCandidates(messages));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    replayCandidates.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("context", async (event, ctx) => {
    const eligible = replayCandidates.get(ctx.sessionManager.getSessionId());
    if (!eligible?.size) return;
    const messages = await slimArchivedResults(
      event.messages, outputArtifactStore(), checkedReplayArtifacts, eligible, ctx.signal,
    );
    if (messages !== event.messages) return { messages };
  });
}
