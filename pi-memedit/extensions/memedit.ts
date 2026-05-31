import { writeFileSync } from "node:fs";
import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AnyRecord = Record<string, any>;

type SessionEntry = AnyRecord & {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
};

type ContextItem = {
  number?: number;
  entry: SessionEntry;
  agentMessage: AnyRecord;
  scoped: boolean;
  removable: boolean;
};

type MemeditStats = {
  at: number;
  mode: "auto" | "manual";
  status: "applied" | "noop" | "skipped" | "failed";
  candidates: number;
  selected: number;
  deleted: number;
  ignored: number;
  error?: string;
};

const EXTENSION_NAME = "pi-memedit";
const STATUS_MESSAGE_TYPE = "pi-memedit-status";
const SYSTEM_STATUS_KEY = "pi-memedit";
const RESPONSE_MAX_TOKENS = 2048;
const PRUNE_SYSTEM_PROMPT = [
  "You are pi-memedit's post-turn memory editor.",
  "The system prompt is included for continuity and is protected. Never select it for deletion.",
  "No tools are available in this pass. Return only valid JSON.",
].join("\n");

let enabled = !isDisabled(process.env.PI_MEMEDIT) && !isDisabled(process.env.PI_MEMEDIT_ENABLED) && !isEnabled(process.env.PI_MEMEDIT_DISABLE);
let running = false;
let sessionLogIsAuthoritative = false;
let activeRunStartLeafId: string | null | undefined;
let lastCompletedRunStartLeafId: string | null | undefined;
let lastStats: MemeditStats | undefined;

function isDisabled(value: string | undefined): boolean {
  return /^(0|false|off|no|disabled)$/i.test((value ?? "").trim());
}

function isEnabled(value: string | undefined): boolean {
  return /^(1|true|on|yes|enabled)$/i.test((value ?? "").trim());
}

function timestampMs(entry: SessionEntry): number {
  const parsed = new Date(entry.timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function entryToAgentMessage(entry: SessionEntry): AnyRecord | undefined {
  if (entry.type === "message") {
    if (entry.message?.role === "bashExecution" && entry.message.excludeFromContext) return undefined;
    return entry.message;
  }
  if (entry.type === "custom_message") {
    if (entry.customType === STATUS_MESSAGE_TYPE) return undefined;
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: timestampMs(entry),
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: timestampMs(entry),
    };
  }
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: timestampMs(entry),
    };
  }
  return undefined;
}

function entryParticipatesInContext(entry: SessionEntry): boolean {
  return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction";
}

function entryIsRemovable(entry: SessionEntry, scopedEntryIds: Set<string>): boolean {
  if (!scopedEntryIds.has(entry.id)) return false;
  // User messages are protected by default: they carry requirements, corrections, and approvals.
  if (entry.type === "message" && entry.message?.role === "user") return false;
  // Compaction summaries are protected: deleting one can accidentally re-expand old history.
  return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

function getLatestCompactionIndex(branch: SessionEntry[]): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") return i;
  }
  return -1;
}

function entryIdsAfter(branch: SessionEntry[], startLeafId: string | null | undefined): Set<string> {
  if (startLeafId === undefined) return new Set();
  const ids = new Set<string>();
  let collecting = startLeafId === null;
  for (const entry of branch) {
    if (collecting) ids.add(entry.id);
    if (entry.id === startLeafId) collecting = true;
  }
  return ids;
}

function collectContextItems(branch: SessionEntry[], scopedEntryIds: Set<string>): ContextItem[] {
  const items: ContextItem[] = [];
  const append = (entry: SessionEntry) => {
    if (!entryParticipatesInContext(entry)) return;
    const agentMessage = entryToAgentMessage(entry);
    if (!agentMessage) return;
    const scoped = scopedEntryIds.has(entry.id);
    items.push({ entry, agentMessage, scoped, removable: entryIsRemovable(entry, scopedEntryIds) });
  };

  const compactionIndex = getLatestCompactionIndex(branch);
  if (compactionIndex >= 0) {
    const compaction = branch[compactionIndex];
    append(compaction);

    let foundFirstKept = false;
    for (let i = 0; i < compactionIndex; i++) {
      const entry = branch[i];
      if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) append(entry);
    }
    for (let i = compactionIndex + 1; i < branch.length; i++) append(branch[i]);
  } else {
    for (const entry of branch) append(entry);
  }

  let nextNumber = 1;
  for (const item of items) {
    if (item.removable) item.number = nextNumber++;
  }
  return items;
}

function contentWithPrefix(content: unknown, prefix: string): any[] {
  if (typeof content === "string") return [{ type: "text", text: `${prefix}\n${content}` }];
  if (!Array.isArray(content)) return [{ type: "text", text: prefix }];

  const next = content.map((block) => (block && typeof block === "object" ? { ...(block as AnyRecord) } : block));
  const textIndex = next.findIndex((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string");
  if (textIndex >= 0) {
    next[textIndex] = { ...next[textIndex], text: `${prefix}\n${next[textIndex].text}` };
  } else {
    next.unshift({ type: "text", text: prefix });
  }
  return next;
}

function prefixMessage(message: Message, item: ContextItem): Message {
  if (!item.number) return structuredClone(message);
  const clone = structuredClone(message) as AnyRecord;
  clone.content = contentWithPrefix(clone.content, `[${item.number}]`);
  return clone as Message;
}

function buildPruneMessages(items: ContextItem[]): Message[] {
  const messages: Message[] = [];
  for (const item of items) {
    const llmMessages = convertToLlm([item.agentMessage as never]) as Message[];
    for (const message of llmMessages) messages.push(prefixMessage(message, item));
  }
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "You are performing pi-memedit's post-turn memory edit pass.",
          "Only the just-finished agent run can be pruned, and only removable current-run items are tagged as [1], [2], .... Untagged content is context only and cannot be deleted.",
          "The current system prompt was included separately and is protected.",
          "Choose only removable item numbers that can be hard-deleted from both future context and the session log.",
          "Delete items that are redundant, misleading, superseded, dead-end exploration, or ephemeral status with no lasting value.",
          "Keep user requirements, preferences, clarifications, decisions, current goals, unresolved questions, blockers, file paths, code changes, command/test results, errors, and resolutions.",
          "When uncertain, keep the item.",
          "Return exactly this JSON shape and nothing else:",
          "{\"delete\":[1,2],\"rationale\":{\"1\":\"short reason\",\"2\":\"short reason\"}}",
        ].join("\n"),
      },
    ],
    timestamp: Date.now(),
  });
  return messages;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof (part as AnyRecord).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseDeleteNumbers(text: string): number[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const jsonText = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  const parsed = JSON.parse(jsonText) as AnyRecord;
  const raw = parsed.delete ?? parsed.deletions ?? parsed.remove ?? parsed.messages ?? [];
  if (!Array.isArray(raw)) return [];

  const numbers = new Set<number>();
  for (const value of raw) {
    const candidate = typeof value === "number" || typeof value === "string" ? value : value?.id ?? value?.number ?? value?.message;
    const parsedNumber = Number(candidate);
    if (Number.isInteger(parsedNumber) && parsedNumber > 0) numbers.add(parsedNumber);
  }
  return [...numbers].sort((a, b) => a - b);
}

function toolCallIdsFromAssistant(message: AnyRecord): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part: AnyRecord) => part?.type === "toolCall" && typeof part.id === "string")
    .map((part: AnyRecord) => part.id);
}

function expandToolDependencies(entries: SessionEntry[], initialDeleteIds: Set<string>): Set<string> {
  const deleteIds = new Set(initialDeleteIds);
  const assistantCallsByEntry = new Map<string, string[]>();
  const assistantEntryByToolCall = new Map<string, string>();
  const resultEntriesByToolCall = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as AnyRecord;
    if (message?.role === "assistant") {
      const callIds = toolCallIdsFromAssistant(message);
      if (callIds.length > 0) assistantCallsByEntry.set(entry.id, callIds);
      for (const callId of callIds) assistantEntryByToolCall.set(callId, entry.id);
    } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      const resultEntries = resultEntriesByToolCall.get(message.toolCallId) ?? new Set<string>();
      resultEntries.add(entry.id);
      resultEntriesByToolCall.set(message.toolCallId, resultEntries);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!deleteIds.has(entry.id) || entry.type !== "message") continue;
      const message = entry.message as AnyRecord;
      if (message?.role === "assistant") {
        for (const callId of assistantCallsByEntry.get(entry.id) ?? []) {
          for (const resultEntryId of resultEntriesByToolCall.get(callId) ?? []) {
            if (!deleteIds.has(resultEntryId)) {
              deleteIds.add(resultEntryId);
              changed = true;
            }
          }
        }
      } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        const assistantEntryId = assistantEntryByToolCall.get(message.toolCallId);
        if (assistantEntryId && !deleteIds.has(assistantEntryId)) {
          deleteIds.add(assistantEntryId);
          changed = true;
        }
      }
    }
  }

  return deleteIds;
}

function nearestKeptAncestor(id: string | null | undefined, keptIds: Set<string>, byId: Map<string, SessionEntry>): string | null {
  let currentId = id ?? null;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    if (keptIds.has(currentId)) return currentId;
    currentId = byId.get(currentId)?.parentId ?? null;
  }
  return null;
}

function pathToEntry(id: string, byId: Map<string, SessionEntry>): SessionEntry[] {
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function replacementFirstKept(compaction: SessionEntry, keptIds: Set<string>, byId: Map<string, SessionEntry>): string | undefined {
  if (!compaction.firstKeptEntryId || keptIds.has(compaction.firstKeptEntryId)) return compaction.firstKeptEntryId;
  const path = pathToEntry(compaction.id, byId);
  const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
  const firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (compactionIndex < 0 || firstKeptIndex < 0) return undefined;
  for (let i = firstKeptIndex; i < compactionIndex; i++) {
    if (keptIds.has(path[i].id)) return path[i].id;
  }
  return undefined;
}

function applyHardDelete(ctx: ExtensionContext, deleteIds: Set<string>, uncountedIds = new Set<string>()): { total: number; counted: number } {
  if (deleteIds.size === 0) return { total: 0, counted: 0 };

  const manager = ctx.sessionManager as AnyRecord;
  const header = manager.getHeader?.();
  if (!header) throw new Error("Current session has no header; cannot rewrite session log");

  const entries = (manager.getEntries?.() ?? []) as SessionEntry[];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const oldLeafId = manager.getLeafId?.() ?? null;
  const expandedDeleteIds = expandToolDependencies(entries, deleteIds);

  const keptEntries = entries.filter((entry) => {
    if (expandedDeleteIds.has(entry.id)) return false;
    if (entry.type === "label" && expandedDeleteIds.has(entry.targetId)) return false;
    return true;
  });
  const keptIds = new Set(keptEntries.map((entry) => entry.id));

  const rewrittenEntries = keptEntries.map((entry) => {
    const next = structuredClone(entry) as SessionEntry;
    if (next.parentId && !keptIds.has(next.parentId)) {
      next.parentId = nearestKeptAncestor(next.parentId, keptIds, byId);
    }
    if (next.type === "compaction") {
      const replacement = replacementFirstKept(next, keptIds, byId);
      if (replacement) next.firstKeptEntryId = replacement;
    }
    if (next.type === "branch_summary" && next.fromId && !keptIds.has(next.fromId)) {
      next.fromId = nearestKeptAncestor(next.fromId, keptIds, byId) ?? next.fromId;
    }
    return next;
  });

  const nextFileEntries = [header, ...rewrittenEntries];
  const sessionFile = manager.getSessionFile?.();
  if (sessionFile) {
    writeFileSync(sessionFile, `${nextFileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  }

  manager.fileEntries = nextFileEntries;
  manager._buildIndex?.();
  manager.leafId = oldLeafId && keptIds.has(oldLeafId) ? oldLeafId : nearestKeptAncestor(oldLeafId, keptIds, byId);
  manager.flushed = true;

  sessionLogIsAuthoritative = true;
  const removed = entries.filter((entry) => !keptEntries.includes(entry));
  const counted = removed.filter((entry) => entryParticipatesInContext(entry) && !uncountedIds.has(entry.id)).length;
  return { total: removed.length, counted };
}

function isStatusAgentMessage(message: AnyRecord): boolean {
  return message?.role === "custom" && message.customType === STATUS_MESSAGE_TYPE;
}

function currentSessionMessages(ctx: ExtensionContext): AnyRecord[] | undefined {
  const manager = ctx.sessionManager as AnyRecord;
  const sessionContext = manager.buildSessionContext?.();
  return Array.isArray(sessionContext?.messages) ? sessionContext.messages.filter((message: AnyRecord) => !isStatusAgentMessage(message)) : undefined;
}

function statusEntryIds(entries: SessionEntry[]): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.type === "custom_message" && entry.customType === STATUS_MESSAGE_TYPE)
      .map((entry) => entry.id),
  );
}

function isLikelyContextOverflowMessage(message: string | undefined): boolean {
  return /context (window|length|size|limit)|too many tokens|maximum (context|tokens)|prompt too long|input too large|exceeds? .*context/i.test(message ?? "");
}

function memeditStatusText(stats: MemeditStats): string {
  if (stats.status === "applied") return `${EXTENSION_NAME}: deleted ${stats.deleted} context entr${stats.deleted === 1 ? "y" : "ies"}.`;
  if (stats.status === "noop") return `${EXTENSION_NAME}: no context entries deleted.`;
  if (stats.status === "skipped") return `${EXTENSION_NAME}: skipped${stats.error ? ` (${stats.error})` : ""}.`;
  return `${EXTENSION_NAME}: failed${stats.error ? ` (${stats.error})` : ""}.`;
}

function scheduleChatNotice(pi: ExtensionAPI, stats: MemeditStats): void {
  setTimeout(() => {
    pi.sendMessage(
      {
        customType: STATUS_MESSAGE_TYPE,
        content: `${memeditStatusText(stats)} Candidates: ${stats.candidates}; selected: ${stats.selected}; ignored: ${stats.ignored}.`,
        display: true,
        details: stats,
      },
    );
  }, 0);
}

async function runMemedit(ctx: ExtensionContext, mode: "auto" | "manual", startLeafId: string | null | undefined): Promise<MemeditStats | undefined> {
  if (!enabled || running) return;
  const model = ctx.model;
  if (!model) return;

  const manager = ctx.sessionManager as AnyRecord;
  const branch = (manager.getBranch?.() ?? []) as SessionEntry[];
  const scopedEntryIds = entryIdsAfter(branch, startLeafId);
  const items = collectContextItems(branch, scopedEntryIds);
  const candidates = items.filter((item) => item.removable && item.number !== undefined);
  if (candidates.length === 0) {
    lastStats = { at: Date.now(), mode, status: "skipped", candidates: 0, selected: 0, deleted: 0, ignored: 0 };
    return lastStats;
  }

  running = true;
  if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, "memedit:pruning");
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      lastStats = {
        at: Date.now(),
        mode,
        status: "skipped",
        candidates: candidates.length,
        selected: 0,
        deleted: 0,
        ignored: 0,
        error: auth.ok ? `No API key for ${model.provider}` : auth.error,
      };
      return lastStats;
    }

    const response = await completeSimple(
      model,
      {
        systemPrompt: `${ctx.getSystemPrompt()}\n\n${PRUNE_SYSTEM_PROMPT}`,
        messages: buildPruneMessages(items),
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: RESPONSE_MAX_TOKENS,
        sessionId: manager.getSessionId?.(),
        cacheRetention: "short",
        signal: ctx.signal,
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `memedit prune request ended with ${response.stopReason}`);
    }

    const deleteNumbers = parseDeleteNumbers(assistantText(response));
    const itemByNumber = new Map(candidates.map((item) => [item.number!, item]));
    const selectedIds = new Set<string>();
    let ignored = 0;
    for (const number of deleteNumbers) {
      const item = itemByNumber.get(number);
      if (item) selectedIds.add(item.entry.id);
      else ignored++;
    }

    const housekeepingIds = statusEntryIds(branch);
    const rewriteIds = new Set([...selectedIds, ...housekeepingIds]);
    const deleted = applyHardDelete(ctx, rewriteIds, housekeepingIds);
    lastStats = {
      at: Date.now(),
      mode,
      status: deleted.counted > 0 ? "applied" : "noop",
      candidates: candidates.length,
      selected: selectedIds.size,
      deleted: deleted.counted,
      ignored,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const overflow = isLikelyContextOverflowMessage(message);
    lastStats = {
      at: Date.now(),
      mode,
      status: overflow ? "skipped" : "failed",
      candidates: candidates.length,
      selected: 0,
      deleted: 0,
      ignored: 0,
      error: overflow ? "prune request exceeded context; left unchanged for normal Pi compaction" : message,
    };
    if (ctx.hasUI && !overflow) ctx.ui.notify(`pi-memedit failed: ${lastStats.error}`, "warning");
  } finally {
    running = false;
    if (ctx.hasUI) {
      const suffix = lastStats?.status === "applied" ? `-${lastStats.deleted}` : lastStats?.status ?? "on";
      ctx.ui.setStatus(SYSTEM_STATUS_KEY, enabled ? `memedit:${suffix}` : "memedit:off");
    }
  }
  return lastStats;
}

function formatStats(): string {
  if (!lastStats) return "pi-memedit has not run in this session.";
  const lines = [
    `pi-memedit: ${enabled ? "enabled" : "disabled"}`,
    `Last run: ${new Date(lastStats.at).toLocaleString()}`,
    `Mode: ${lastStats.mode}`,
    `Status: ${lastStats.status}`,
    `Candidates: ${lastStats.candidates}`,
    `Selected: ${lastStats.selected}`,
    `Deleted entries: ${lastStats.deleted}`,
    `Ignored ids: ${lastStats.ignored}`,
  ];
  if (lastStats.error) lines.push(`Error: ${lastStats.error}`);
  return lines.join("\n");
}

export default function memedit(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    sessionLogIsAuthoritative = false;
    if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, enabled ? "memedit:on" : "memedit:off");
  });

  pi.on("context", async (event, ctx) => {
    if (sessionLogIsAuthoritative) {
      const messages = currentSessionMessages(ctx);
      if (messages) return { messages: messages as never };
    }
    const filtered = event.messages.filter((message: AnyRecord) => !isStatusAgentMessage(message));
    if (filtered.length !== event.messages.length) return { messages: filtered as never };
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeRunStartLeafId = (ctx.sessionManager as AnyRecord).getLeafId?.() ?? null;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const startLeafId = activeRunStartLeafId;
    lastCompletedRunStartLeafId = startLeafId;
    activeRunStartLeafId = undefined;
    const stats = await runMemedit(ctx, "auto", startLeafId);
    if (stats) scheduleChatNotice(pi, stats);
  });

  pi.registerCommand("memedit", {
    description: "Show or control automatic post-turn context/session-log memory editing",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "status";
      if (command === "on" || command === "enable") {
        enabled = true;
        if (ctx.hasUI) {
          ctx.ui.setStatus(SYSTEM_STATUS_KEY, "memedit:on");
          ctx.ui.notify("pi-memedit enabled", "info");
        }
        return;
      }
      if (command === "off" || command === "disable") {
        enabled = false;
        if (ctx.hasUI) {
          ctx.ui.setStatus(SYSTEM_STATUS_KEY, "memedit:off");
          ctx.ui.notify("pi-memedit disabled", "info");
        }
        return;
      }
      if (command === "run") {
        await ctx.waitForIdle();
        await runMemedit(ctx, "manual", lastCompletedRunStartLeafId);
        if (ctx.hasUI) ctx.ui.notify(formatStats(), "info");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(`${formatStats()}\n\nCommands: /memedit status | run | on | off`, "info");
    },
  });
}
