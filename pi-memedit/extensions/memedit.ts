import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { AgentSession, convertToLlm } from "@earendil-works/pi-coding-agent";
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

type DeletedItem = {
  id: string;
  role: string;
  text: string;
};

type MemeditStats = {
  at: number;
  mode: "auto" | "manual";
  status: "applied" | "noop" | "skipped" | "failed";
  candidates: number;
  selected: number;
  deleted: number;
  ignored: number;
  deletedItems?: DeletedItem[];
  error?: string;
};

type MemeditSettings = {
  enabled: boolean;
  showDeletedItems: boolean;
};

const EXTENSION_NAME = "pi-memedit";
const STATUS_MESSAGE_TYPE = "pi-memedit-status";
const SYSTEM_STATUS_KEY = "pi-memedit";
const RESPONSE_MAX_TOKENS = 2048;
const SETTINGS_FILE = process.env.PI_MEMEDIT_SETTINGS || join(os.homedir(), ".pi", "agent", "memedit", "settings.json");
const DEFAULT_SETTINGS: MemeditSettings = { enabled: true, showDeletedItems: false };
const PREVIEW_CHARS = 160;
const AGENT_SESSION_PATCH_KEY = Symbol.for("pi.memedit.agentSessionPatchInstalled");
const AGENT_STATE_SYNC_KEY = Symbol.for("pi.memedit.agentStateSyncSessions");
const PRUNE_SYSTEM_PROMPT = `You are pi-memedit's post-turn memory editor.

The conversation above is a list of entries — messages, tool calls, tool
results. Entries you may delete are tagged [1], [2], .... Deletion is permanent.

WHAT DELETION MEANS HERE
Deleting an entry removes everything in it, for good. A piece of information
survives that deletion only if another surviving entry holds it at the same
fidelity — the literal value, not a mention or recap. The run's closing summary
is a recap: it preserves nothing, and never justifies deleting the records
behind it. For each entry, ask: is this the last place this information lives?

THE TEST
Keep an entry if a future agent resuming this session would need what it holds,
or would go wrong without it — redoing work, or reopening a settled question.
Delete an entry only when what it holds is worthless going forward, or already
held at full fidelity by a surviving entry.

A WRONG TURN IS NOT AUTOMATICALLY DELETABLE
The flailing toward a result — repeated failed calls, retries, "let me try…" —
is deletable once a later entry shows the working approach; that route carries
nothing forward. But a wrong turn that reached a conclusion is a result, not a
detour: "we evaluated X and ruled it out because Y" is a fact about where the
work now stands. Lose it, and a future agent may re-explore the same dead end or
treat a settled matter as open. Keep ruled-out options and negative findings.

CLEARLY DELETABLE
- Failed or aborted tool calls that a later correct call supersedes, when their
  only content was getting the mechanics right.
- A large retrieval mined for one fact, when that fact already appears in a
  surviving entry. (If it appears nowhere else, this entry is its only copy —
  keep it.)
- Pure status chatter and intermediate reasoning that a later recorded result
  makes redundant.

CLEARLY KEEP
- File paths, file and code changes, open questions, and blockers.
- Command or verification output that establishes current state — what is
  installed, what a file now holds after an edit, what a check confirmed. A
  later record of the same thing can supersede it; a sentence mentioning it
  cannot.
- Any entry that is the sole record of a result, conclusion, or finding —
  positive or negative.

Delete the clear cases with confidence — clearing that bloat is the point of
this pass. But a finished run is rarely all bloat: the changes it made and the
state it left behind outlive the reasoning that produced them, and your summary
mentioning them does not make them safe to drop. When you can't tell whether an
entry is the last copy of something that matters, keep it — deleting a needed
entry silently breaks the session, while keeping a stale one costs little. If
nothing clearly qualifies, return an empty list; that is a valid answer.

Return only JSON of this shape:
{"delete":[<item numbers>]}`;

let settings = loadSettings();
let enabled = resolveInitialEnabled(settings.enabled);
let showDeletedItems = settings.showDeletedItems;
let running = false;
let sessionLogIsAuthoritative = false;
let activeRunStartLeafId: string | null | undefined;
let lastCompletedRunStartLeafId: string | null | undefined;
let lastStats: MemeditStats | undefined;

function stateSyncSessions(): Set<string> {
  const globalState = globalThis as typeof globalThis & { [AGENT_STATE_SYNC_KEY]?: Set<string> };
  globalState[AGENT_STATE_SYNC_KEY] ??= new Set<string>();
  return globalState[AGENT_STATE_SYNC_KEY]!;
}

function markAgentStateNeedsSync(sessionId: unknown): void {
  if (typeof sessionId === "string" && sessionId) stateSyncSessions().add(sessionId);
}

function installAgentSessionPatch(): void {
  const globalState = globalThis as typeof globalThis & { [AGENT_SESSION_PATCH_KEY]?: boolean };
  if (globalState[AGENT_SESSION_PATCH_KEY]) return;

  const proto = (AgentSession as unknown as { prototype?: AnyRecord }).prototype;
  const original = proto?._checkCompaction;
  if (typeof original !== "function") return;

  proto._checkCompaction = async function patchedCheckCompaction(this: AnyRecord, ...args: unknown[]) {
    const sessionId = this.sessionManager?.getSessionId?.();
    if (typeof sessionId === "string" && stateSyncSessions().delete(sessionId)) {
      const sessionContext = this.sessionManager?.buildSessionContext?.();
      if (Array.isArray(sessionContext?.messages) && this.agent?.state) {
        this.agent.state.messages = sessionContext.messages.filter((message: AnyRecord) => !isStatusAgentMessage(message));
      }
    }
    return original.apply(this, args);
  };
  globalState[AGENT_SESSION_PATCH_KEY] = true;
}

function isDisabled(value: string | undefined): boolean {
  return /^(0|false|off|no|disabled)$/i.test((value ?? "").trim());
}

function isEnabled(value: string | undefined): boolean {
  return /^(1|true|on|yes|enabled)$/i.test((value ?? "").trim());
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (isEnabled(value)) return true;
    if (isDisabled(value)) return false;
  }
  return fallback;
}

function loadSettings(): MemeditSettings {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<MemeditSettings>;
    return {
      enabled: readBoolean(parsed.enabled, DEFAULT_SETTINGS.enabled),
      showDeletedItems: readBoolean(parsed.showDeletedItems, DEFAULT_SETTINGS.showDeletedItems),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(): void {
  settings = { enabled, showDeletedItems };
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function resolveInitialEnabled(persistedEnabled: boolean): boolean {
  if (isEnabled(process.env.PI_MEMEDIT_DISABLE)) return false;
  if (isDisabled(process.env.PI_MEMEDIT) || isDisabled(process.env.PI_MEMEDIT_ENABLED)) return false;
  if (isEnabled(process.env.PI_MEMEDIT) || isEnabled(process.env.PI_MEMEDIT_ENABLED)) return true;
  return persistedEnabled;
}

function setEnabled(value: boolean): void {
  enabled = value;
  saveSettings();
}

function setShowDeletedItems(value: boolean): void {
  showDeletedItems = value;
  saveSettings();
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

function entryIsRemovable(entry: SessionEntry, scopedEntryIds: Set<string>, protectedEntryIds: Set<string>): boolean {
  if (!scopedEntryIds.has(entry.id)) return false;
  if (protectedEntryIds.has(entry.id)) return false;
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

function isAssistantTextResponse(entry: SessionEntry): boolean {
  if (entry.type !== "message" || entry.message?.role !== "assistant") return false;
  const content = entry.message.content;
  return Array.isArray(content) && content.some((part: AnyRecord) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
}

function protectFinalAssistantTextResponse(branch: SessionEntry[], scopedEntryIds: Set<string>): Set<string> {
  const protectedIds = new Set<string>();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!scopedEntryIds.has(entry.id)) continue;
    if (isAssistantTextResponse(entry)) {
      protectedIds.add(entry.id);
      break;
    }
  }
  return protectedIds;
}

function collectContextItems(branch: SessionEntry[], scopedEntryIds: Set<string>, protectedEntryIds: Set<string>): ContextItem[] {
  const items: ContextItem[] = [];
  const append = (entry: SessionEntry) => {
    if (!entryParticipatesInContext(entry)) return;
    const agentMessage = entryToAgentMessage(entry);
    if (!agentMessage) return;
    const scoped = scopedEntryIds.has(entry.id);
    items.push({ entry, agentMessage, scoped, removable: entryIsRemovable(entry, scopedEntryIds, protectedEntryIds) });
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
    content: [{ type: "text", text: "Return the deletion JSON now." }],
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

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars = PREVIEW_CHARS): string {
  const compact = compactText(value);
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: AnyRecord) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "toolCall" && typeof part.name === "string") return `tool call: ${part.name}`;
      if (part?.type === "thinking" && typeof part.thinking === "string") return part.thinking;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function previewEntry(entry: SessionEntry): DeletedItem {
  if (entry.type === "message") {
    const message = entry.message as AnyRecord;
    const role = message.role === "toolResult" ? `toolResult:${message.toolName ?? "tool"}` : String(message.role ?? "message");
    return { id: entry.id, role, text: truncateText(contentText(message.content) || "(no text)") };
  }
  if (entry.type === "custom_message") {
    return { id: entry.id, role: `custom:${entry.customType ?? "message"}`, text: truncateText(contentText(entry.content) || "(no text)") };
  }
  if (entry.type === "branch_summary") {
    return { id: entry.id, role: "branchSummary", text: truncateText(String(entry.summary ?? "")) };
  }
  return { id: entry.id, role: entry.type, text: truncateText(JSON.stringify(entry)) };
}

function formatDeletedItem(item: DeletedItem): string {
  return `- ${item.role}: ${item.text}`;
}

function parseDeleteNumbers(text: string): number[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const jsonText = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  const parsed = JSON.parse(jsonText) as { delete?: unknown };
  const raw = parsed.delete;
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

function applyHardDelete(ctx: ExtensionContext, deleteIds: Set<string>, uncountedIds = new Set<string>()): { total: number; counted: number; deletedItems: DeletedItem[] } {
  if (deleteIds.size === 0) return { total: 0, counted: 0, deletedItems: [] };

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
  markAgentStateNeedsSync(manager.getSessionId?.());
  const removed = entries.filter((entry) => !keptEntries.includes(entry));
  const deletedItems = removed
    .filter((entry) => entryParticipatesInContext(entry) && !uncountedIds.has(entry.id))
    .map(previewEntry);
  return { total: removed.length, counted: deletedItems.length, deletedItems };
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
  const lines = [`${memeditStatusText(stats)} Candidates: ${stats.candidates}; selected: ${stats.selected}; ignored: ${stats.ignored}.`];
  if (showDeletedItems && stats.deletedItems && stats.deletedItems.length > 0) {
    lines.push("Removed:", ...stats.deletedItems.map(formatDeletedItem));
  }

  setTimeout(() => {
    pi.sendMessage(
      {
        customType: STATUS_MESSAGE_TYPE,
        content: lines.join("\n"),
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
  const protectedEntryIds = protectFinalAssistantTextResponse(branch, scopedEntryIds);
  const items = collectContextItems(branch, scopedEntryIds, protectedEntryIds);
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
      deletedItems: deleted.deletedItems,
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

function unsuccessfulRunReason(messages: unknown[]): string | undefined {
  for (const message of messages) {
    const candidate = message as AnyRecord;
    if (candidate?.role !== "assistant") continue;
    if (candidate.stopReason === "error" || candidate.stopReason === "aborted" || candidate.stopReason === "length") {
      return candidate.errorMessage ? `${candidate.stopReason}: ${candidate.errorMessage}` : String(candidate.stopReason);
    }
  }
  return undefined;
}

function skippedStats(reason: string): MemeditStats {
  return {
    at: Date.now(),
    mode: "auto",
    status: "skipped",
    candidates: 0,
    selected: 0,
    deleted: 0,
    ignored: 0,
    error: reason,
  };
}

function formatStats(): string {
  const settingsLines = [
    `pi-memedit: ${enabled ? "enabled" : "disabled"}`,
    `Show removed text: ${showDeletedItems ? "on" : "off"}`,
    `Settings file: ${SETTINGS_FILE}`,
  ];
  if (!lastStats) return [...settingsLines, "pi-memedit has not run in this session."].join("\n");
  const lines = [
    ...settingsLines,
    `Last run: ${new Date(lastStats.at).toLocaleString()}`,
    `Mode: ${lastStats.mode}`,
    `Status: ${lastStats.status}`,
    `Candidates: ${lastStats.candidates}`,
    `Selected: ${lastStats.selected}`,
    `Deleted entries: ${lastStats.deleted}`,
    `Ignored ids: ${lastStats.ignored}`,
  ];
  if (showDeletedItems && lastStats.deletedItems && lastStats.deletedItems.length > 0) {
    lines.push("Removed:", ...lastStats.deletedItems.map(formatDeletedItem));
  }
  if (lastStats.error) lines.push(`Error: ${lastStats.error}`);
  return lines.join("\n");
}

export default function memedit(pi: ExtensionAPI) {
  installAgentSessionPatch();

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

  pi.on("agent_end", async (event, ctx) => {
    const startLeafId = activeRunStartLeafId;
    activeRunStartLeafId = undefined;

    const unsuccessfulReason = unsuccessfulRunReason(event.messages);
    if (unsuccessfulReason) {
      lastStats = skippedStats(`agent run did not complete cleanly (${unsuccessfulReason})`);
      if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, enabled ? "memedit:skipped" : "memedit:off");
      scheduleChatNotice(pi, lastStats);
      return;
    }

    lastCompletedRunStartLeafId = startLeafId;
    const stats = await runMemedit(ctx, "auto", startLeafId);
    if (stats) scheduleChatNotice(pi, stats);
  });

  pi.registerCommand("memedit", {
    description: "Show or control automatic post-turn context/session-log memory editing",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "status";
      if (command === "on" || command === "enable") {
        setEnabled(true);
        if (ctx.hasUI) {
          ctx.ui.setStatus(SYSTEM_STATUS_KEY, "memedit:on");
          ctx.ui.notify(`pi-memedit enabled and persisted to ${SETTINGS_FILE}`, "info");
        }
        return;
      }
      if (command === "off" || command === "disable") {
        setEnabled(false);
        if (ctx.hasUI) {
          ctx.ui.setStatus(SYSTEM_STATUS_KEY, "memedit:off");
          ctx.ui.notify(`pi-memedit disabled and persisted to ${SETTINGS_FILE}`, "info");
        }
        return;
      }
      const showMatch = command.match(/^(?:show|show-deleted|details|verbose|output|removed|removed-text)\s+(on|off|enable|disable)$/);
      if (showMatch) {
        const next = showMatch[1] === "on" || showMatch[1] === "enable";
        setShowDeletedItems(next);
        if (ctx.hasUI) ctx.ui.notify(`pi-memedit removed-text output ${next ? "enabled" : "disabled"} and persisted to ${SETTINGS_FILE}`, "info");
        return;
      }
      if (command === "run") {
        await ctx.waitForIdle();
        await runMemedit(ctx, "manual", lastCompletedRunStartLeafId);
        if (ctx.hasUI) ctx.ui.notify(formatStats(), "info");
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${formatStats()}\n\nCommands: /memedit status | run | on | off | show-deleted on | show-deleted off`,
          "info",
        );
      }
    },
  });
}
