import { Buffer } from "node:buffer";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inPlaceBlocker, summarizeInPlace, type SentRequest } from "./in-place.ts";
import { BRIEF_ENTRY, BRIEF_EVENT, writeBrief, type BriefProbe } from "./brief.ts";

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
  return { contextFiles, appendSystemPrompt: "" };
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
  return `\n\n${MARKER}\nProject instructions for this summary:\n\n${truncate(sections.join("\n\n"), 32_000)}\n</pi_compaction_context>`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only visit documented provider system-instruction fields, never conversation,
// tool arguments/results, or arbitrary nested strings. Lifecycle events identify
// summary requests; quoted prompt phrases are not a request classification API.
export function patchSummaryPayload(payload: unknown, injection: string, snapshot?: Snapshot): unknown {
  if (!record(payload)) return undefined;
  const active = [...(snapshot?.contextFiles ?? []).map(file => file.content), snapshot?.customPrompt, snapshot?.appendSystemPrompt]
    .flatMap(text => text?.trim() ? [text.trim()] : []);
  const append = (text: string) => text.includes(MARKER) || active.length > 0 && active.every(rule => text.includes(rule)) ? text : text + injection;
  const content = (value: unknown): unknown => {
    if (typeof value === "string") return append(value);
    if (!Array.isArray(value)) return value;
    const index = value.findIndex((part) => record(part) && typeof part.text === "string");
    if (index < 0) return value;
    const part = value[index] as Record<string, unknown>, text = append(part.text as string);
    return text === part.text ? value : value.map((part, i) => i === index ? { ...part, text } : part);
  };
  for (const key of ["instructions", "system"]) {
    if (typeof payload[key] === "string" || Array.isArray(payload[key])) {
      const next = content(payload[key]);
      return next === payload[key] ? payload : { ...payload, [key]: next };
    }
  }
  // Pi's Google adapter passes SDK config, before wire serialization.
  if (record(payload.config) && typeof payload.config.systemInstruction === "string") {
    const next = append(payload.config.systemInstruction);
    return next === payload.config.systemInstruction ? payload : { ...payload, config: { ...payload.config, systemInstruction: next } };
  }
  if (record(payload.systemInstruction) && Array.isArray(payload.systemInstruction.parts)) {
    const next = content(payload.systemInstruction.parts);
    return next === payload.systemInstruction.parts ? payload : { ...payload, systemInstruction: { ...payload.systemInstruction, parts: next } };
  }
  if (Array.isArray(payload.messages)) {
    const index = payload.messages.findIndex((item) => record(item) && (item.role === "system" || item.role === "developer"));
    if (index >= 0) {
      const item = payload.messages[index] as Record<string, unknown>, next = content(item.content);
      return next === item.content ? payload : { ...payload, messages: payload.messages.map((item, i) => i === index ? { ...item, content: next } : item) };
    }
  }
  return undefined;
}

export default function compactionContext(pi: ExtensionAPI): void {
  let enabled = true;
  let snapshot: Snapshot | undefined;
  let summary: { signal: AbortSignal; injection?: string; snapshot: Snapshot } | undefined;
  let requestsPatched = 0;
  let lastContextBytes = 0;
  // The payload each conversation last sent for a turn, as sent: this extension loads last, after every payload handler.
  const sent = new Map<string, SentRequest>();
  // The latest context each conversation's handlers saw, for briefs asked for between events.
  const contexts = new Map<string, ExtensionContext>();
  const remember = (ctx: ExtensionContext) => { const id = ctx.sessionManager?.getSessionId?.(); if (id) contexts.set(id, ctx); };
  pi.on("session_start", (_event, ctx) => remember(ctx));
  pi.on("agent_end", (_event, ctx) => remember(ctx));
  const releaseBrief = pi.events?.on(BRIEF_EVENT, raw => {
    const probe = raw as BriefProbe;
    const ctx = probe && typeof probe === "object" ? contexts.get(probe.session) : undefined;
    if (!ctx) return;
    probe.result = writeBrief(ctx, sent.get(probe.session), brief => pi.appendEntry(BRIEF_ENTRY, brief), { refresh: probe.refresh, signal: probe.signal });
  });
  let turnRequest = false, lastInPlace = "not tried yet";
  const prepare = (signal: AbortSignal, ctx: ExtensionContext) => {
    const context = snapshot ?? fallbackSnapshot(ctx);
    summary = { signal, injection: enabled ? buildInjection(context) : undefined, snapshot: context };
  };
  const clear = () => { summary = undefined; };

  pi.on("before_agent_start", (event) => {
    clear();
    const { contextFiles, customPrompt, appendSystemPrompt } = event.systemPromptOptions;
    snapshot = { contextFiles: contextFiles?.map((file) => ({ ...file })), customPrompt, appendSystemPrompt };
  });
  pi.on("context_with_system", () => { turnRequest = true; });
  pi.on("session_before_compact", async (event, ctx) => {
    const request = ctx.model && ctx.model.provider !== "openai-codex" ? sent.get(ctx.sessionManager.getSessionId()) : undefined;
    const blocker = inPlaceBlocker(event, ctx, request);
    if (!blocker && request) {
      try {
        const compaction = await summarizeInPlace(event, ctx, request);
        if (compaction) { lastInPlace = "used"; return { compaction }; }
        lastInPlace = "fell back: the model did not return a summary";
      } catch (error) {
        if (event.signal.aborted) return;
        lastInPlace = `fell back: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      }
    } else lastInPlace = `not used: ${blocker}`;
    // Pi's own summary request gets the project rules it otherwise lacks.
    prepare(event.signal, ctx);
  });
  pi.on("session_before_tree", (event, ctx) => {
    clear();
    if (event.preparation.userWantsSummary) prepare(event.signal, ctx);
  });
  pi.on("session_compact", clear);
  pi.on("session_compact_failed", clear);
  pi.on("session_tree", clear);
  pi.on("context", clear);
  pi.on("session_shutdown", (_event, ctx) => { clear(); sent.delete(ctx.sessionManager.getSessionId()); contexts.delete(ctx.sessionManager.getSessionId()); releaseBrief?.(); });
  pi.on("before_provider_request", (event, ctx) => {
    remember(ctx);
    if (turnRequest) {
      turnRequest = false;
      const model = ctx.model;
      if (model) try {
        sent.set(ctx.sessionManager.getSessionId(), { payload: JSON.stringify(event.payload), model: `${model.provider}/${model.id}`, api: model.api, leaf: ctx.sessionManager.getLeafId() });
      } catch { /* A payload that cannot be copied is not replayed. */ }
      return;
    }
    if (!enabled || !summary?.injection || summary.signal.aborted) return;
    const patched = patchSummaryPayload(event.payload, summary.injection, summary.snapshot);
    if (patched !== undefined && patched !== event.payload) {
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
      pi.sendMessage({ customType: "pi-compaction-context-status", content: `# Compaction context\n\nStatus: ${enabled ? "on" : "off"}\nSummary in the conversation's own cache: ${lastInPlace}\nPatched requests: ${requestsPatched}\nLast context bytes: ${lastContextBytes}\n\n## Active Markdown context\n${(snapshot ?? fallbackSnapshot(ctx)).contextFiles?.map((file) => `- ${file.path}`).join("\n") || "- none captured yet"}`, display: true }, { triggerTurn: false });
    },
  });
}
