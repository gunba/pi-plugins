import { Buffer } from "node:buffer";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ContextFile = { path: string; content: string };
type Snapshot = Pick<BeforeAgentStartEvent["systemPromptOptions"], "contextFiles" | "customPrompt" | "appendSystemPrompt">;
const MARKER = '<pi_compaction_context version="1">';
const SUFFIX = "\n[content truncated for compaction context]";

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - SUFFIX.length))}${SUFFIX.slice(0, limit)}`;
}

function fallbackSnapshot(ctx: ExtensionContext): Snapshot {
  const contextFiles: ContextFile[] = [];
  for (const match of ctx.getSystemPrompt().matchAll(/<project_instructions\s+path="([^"]*)">\n?([\s\S]*?)\n?<\/project_instructions>/g)) {
    contextFiles.push({ path: match[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&"), content: match[2] });
  }
  return { contextFiles };
}

export function buildInjection(snapshot: Snapshot): string | undefined {
  const sections: string[] = [];
  for (const file of snapshot.contextFiles ?? []) {
    const path = file.path.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    sections.push(`<project_instructions path="${path}">\n${truncate(file.content, 12_000)}\n</project_instructions>`);
  }
  if (snapshot.customPrompt?.trim()) sections.push(`<custom_system_prompt>\n${truncate(snapshot.customPrompt.trim(), 8_000)}\n</custom_system_prompt>`);
  if (snapshot.appendSystemPrompt?.trim()) sections.push(`<appended_system_prompt>\n${truncate(snapshot.appendSystemPrompt.trim(), 8_000)}\n</appended_system_prompt>`);
  if (!sections.length) return undefined;
  return `\n\n${MARKER}\nThese are active Pi context instructions for the checkpoint writer. Apply them while producing the summary. Preserve task-specific preferences and constraints; reference standing project rules by path when useful.\n\n${truncate(sections.join("\n\n"), 32_000)}\n</pi_compaction_context>`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only visit documented provider system-instruction fields, never conversation,
// tool arguments/results, or arbitrary nested strings. Lifecycle events identify
// summary requests; quoted prompt phrases are not a request classification API.
export function patchSummaryPayload(payload: unknown, injection: string): unknown {
  if (!record(payload)) return undefined;
  const append = (text: string) => text.includes(MARKER) ? text : text + injection;
  const content = (value: unknown): unknown => {
    if (typeof value === "string") return append(value);
    if (!Array.isArray(value)) return value;
    const index = value.findIndex((part) => record(part) && typeof part.text === "string");
    if (index < 0) return value;
    return value.map((part, i) => i === index ? { ...part, text: append(part.text) } : part);
  };
  for (const key of ["instructions", "system"]) {
    if (typeof payload[key] === "string" || Array.isArray(payload[key])) {
      return { ...payload, [key]: content(payload[key]) };
    }
  }
  // Pi's Google adapter passes SDK config, before wire serialization.
  if (record(payload.config) && typeof payload.config.systemInstruction === "string") {
    return { ...payload, config: { ...payload.config, systemInstruction: append(payload.config.systemInstruction) } };
  }
  if (record(payload.systemInstruction) && Array.isArray(payload.systemInstruction.parts)) {
    return { ...payload, systemInstruction: { ...payload.systemInstruction, parts: content(payload.systemInstruction.parts) } };
  }
  if (Array.isArray(payload.messages)) {
    const index = payload.messages.findIndex((item) => record(item) && (item.role === "system" || item.role === "developer"));
    if (index >= 0) return { ...payload, messages: payload.messages.map((item, i) => i === index ? { ...item, content: content(item.content) } : item) };
  }
  return undefined;
}

export default function compactionContext(pi: ExtensionAPI): void {
  let enabled = true;
  let snapshot: Snapshot | undefined;
  let summary: { signal: AbortSignal; injection?: string } | undefined;
  let requestsPatched = 0;
  let lastContextBytes = 0;
  const prepare = (signal: AbortSignal, ctx: ExtensionContext) => {
    summary = { signal, injection: enabled ? buildInjection(snapshot ?? fallbackSnapshot(ctx)) : undefined };
  };
  const clear = () => { summary = undefined; };

  pi.on("before_agent_start", (event) => {
    clear();
    const { contextFiles, customPrompt, appendSystemPrompt } = event.systemPromptOptions;
    snapshot = { contextFiles: contextFiles?.map((file) => ({ ...file })), customPrompt, appendSystemPrompt };
  });
  pi.on("session_before_compact", (event, ctx) => { prepare(event.signal, ctx); });
  pi.on("session_before_tree", (event, ctx) => {
    clear();
    if (event.preparation.userWantsSummary) prepare(event.signal, ctx);
  });
  pi.on("session_compact", clear);
  pi.on("session_compact_failed", clear);
  pi.on("session_tree", clear);
  pi.on("context", clear);
  pi.on("session_shutdown", clear);
  pi.on("before_provider_request", (event) => {
    if (!enabled || !summary?.injection || summary.signal.aborted) return;
    const patched = patchSummaryPayload(event.payload, summary.injection);
    if (patched !== undefined) {
      requestsPatched++;
      lastContextBytes = Buffer.byteLength(summary.injection);
    }
    return patched;
  });
  pi.registerCommand("compaction-context", {
    description: "Show or toggle context instructions for summary requests",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "on" || command === "off") {
        enabled = command === "on";
        ctx.ui.notify(`Compaction context ${enabled ? "enabled" : "disabled"}`, "info");
        return;
      }
      pi.sendMessage({ customType: "pi-compaction-context-status", content: `# Compaction context\n\nStatus: ${enabled ? "on" : "off"}\nPatched requests: ${requestsPatched}\nLast context bytes: ${lastContextBytes}\n\n## Active Markdown context\n${(snapshot ?? fallbackSnapshot(ctx)).contextFiles?.map((file) => `- ${file.path}`).join("\n") || "- none captured yet"}`, display: true }, { triggerTurn: false });
    },
  });
}
