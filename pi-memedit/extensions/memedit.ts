import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { AgentSession, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AnyRecord = Record<string, any>;

type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: unknown;
  [key: string]: unknown;
};

type AnthropicMessageBlock = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

type AnthropicMessageParam = {
  role?: string;
  content?: string | AnthropicMessageBlock[];
  [key: string]: unknown;
};

type AnthropicPayload = {
  model?: unknown;
  messages?: unknown;
  system?: unknown;
  stream?: unknown;
  [key: string]: unknown;
};

type SessionEntry = AnyRecord & {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
};

type ContextItem = {
  number?: number;
  entry: SessionEntry;
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
  contextTokensBefore?: number;
  contextWindowTokensBefore?: number;
  contextWindowTokensLimit?: number;
  contextWindowPercentBefore?: number;
  tokensSaved?: number;
  estimatedRecacheTokens?: number;
  contextPercentSaved?: number;
  // Cache calculus: the recache penalty is a one-off cost paid on the next turn,
  // while the saving recurs on every subsequent turn. They are not comparable
  // as raw token counts, so we carry them as dollar flows plus a break-even.
  recacheCost?: number; // one-off $ to re-cache the invalidated tail
  savingPerTurnCost?: number; // $ saved on every subsequent turn
  breakEvenTurns?: number; // future turns until the recache pays for itself
  pruneTokens?: number;
  pruneCost?: number;
  deletedItems?: DeletedItem[];
  error?: string;
};

type MemeditTelemetry = {
  runs: number;
  contextTokensBefore: number;
  tokensSaved: number;
  estimatedRecacheTokens: number;
  recacheCost: number;
  savingPerTurnCost: number;
  pruneTokens: number;
  pruneCost: number;
};

type MemeditSettings = {
  enabled: boolean;
  showDeletedItems: boolean;
};

const EXTENSION_NAME = "pi-memedit";
const STATUS_MESSAGE_TYPE = "pi-memedit-status";
const SYSTEM_STATUS_KEY = "pi-memedit";
const PRUNING_WIDGET_KEY = "pi-memedit-pruning";
const RESPONSE_MAX_TOKENS = 2048;
const SETTINGS_FILE = process.env.PI_MEMEDIT_SETTINGS || join(os.homedir(), ".pi", "agent", "memedit", "settings.json");
const DEFAULT_SETTINGS: MemeditSettings = { enabled: true, showDeletedItems: false };
const PREVIEW_CHARS = 160;
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const ANTHROPIC_OAUTH_TOKEN_MARKER = "sk-ant-oat";
const CLAUDE_CODE_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI";
const ANTHROPIC_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CLAUDE_CODE_VERSION = "2.1.150";
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const BILLING_HEADER_SALT = "59cf53e54c78";
const BILLING_HEADER_POSITIONS = [4, 7, 20] as const;
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
let pendingRunStartLeafId: string | null | undefined;
let lastCompletedRunStartLeafId: string | null | undefined;
let lastStats: MemeditStats | undefined;
// Realized ongoing saving: the pruned tokens are absent from EVERY provider
// request after a prune, so the benefit accrues in real time, one API call at a
// time. We tick it up on each request rather than reporting a single snapshot.
let realizedSavingsCost = 0;
let realizedSavingsCalls = 0;
let telemetry: MemeditTelemetry = {
  runs: 0,
  contextTokensBefore: 0,
  tokensSaved: 0,
  estimatedRecacheTokens: 0,
  recacheCost: 0,
  savingPerTurnCost: 0,
  pruneTokens: 0,
  pruneCost: 0,
};

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

function isSubagentChildProcess(): boolean {
  return process.env[SUBAGENT_CHILD_ENV] === "1";
}

function isSubagentRuntimeBlocked(): boolean {
  return isSubagentChildProcess();
}

function subagentDisabledReason(): string {
  return "disabled in pi-subagents child process";
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
  if (isSubagentRuntimeBlocked()) return false;
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
    if (!entryToAgentMessage(entry)) return;
    const scoped = scopedEntryIds.has(entry.id);
    items.push({ entry, scoped, removable: entryIsRemovable(entry, scopedEntryIds, protectedEntryIds) });
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

function entryPromptRole(entry: SessionEntry): string {
  if (entry.type === "message") {
    const message = entry.message as AnyRecord;
    if (message.role === "toolResult") return `toolResult:${message.toolName ?? "tool"}`;
    return String(message.role ?? "message");
  }
  if (entry.type === "custom_message") return `custom:${entry.customType ?? "message"}`;
  if (entry.type === "branch_summary") return "branchSummary";
  if (entry.type === "compaction") return "compactionSummary";
  return entry.type;
}

function entryPromptText(entry: SessionEntry): string {
  if (entry.type === "message") return contentText((entry.message as AnyRecord).content);
  if (entry.type === "custom_message") return contentText(entry.content);
  if (entry.type === "branch_summary") return String(entry.summary ?? "");
  if (entry.type === "compaction") return String(entry.summary ?? "");
  return "";
}

function formatPruneItem(item: ContextItem): string {
  const tag = item.number ? `[${item.number}]` : "[context]";
  const scope = item.scoped ? "current-run" : "earlier-context";
  const mutability = item.removable ? "removable" : "protected";
  const text = entryPromptText(item.entry).trim() || "(no text)";
  return `${tag} ${entryPromptRole(item.entry)} (${scope}; ${mutability}; id=${item.entry.id})\n${text}`;
}

function buildPruneMessages(items: ContextItem[]): Message[] {
  const transcript = items.map(formatPruneItem).join("\n\n---\n\n");
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Conversation entries follow. Only entries tagged [N] are deletion candidates; [context] entries are context only and must not be returned.\n\n${transcript}\n\nReturn the deletion JSON now.`,
        },
      ],
      timestamp: Date.now(),
    },
  ];
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof (part as AnyRecord).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicOAuthApiKey(apiKey: string): boolean {
  return apiKey.includes(ANTHROPIC_OAUTH_TOKEN_MARKER);
}

function isAnthropicMessagesPayload(payload: unknown): payload is AnthropicPayload {
  return isRecord(payload) && typeof payload.model === "string" && Array.isArray(payload.messages) && typeof payload.stream === "boolean";
}

function hasAnthropicOAuthSystemMarker(block: unknown): boolean {
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return false;
  return block.text.includes(CLAUDE_CODE_IDENTITY_PREFIX) || block.text.includes(ANTHROPIC_BILLING_HEADER_PREFIX);
}

function isAnthropicOAuthPayload(payload: AnthropicPayload): boolean {
  return Array.isArray(payload.system) && payload.system.some(hasAnthropicOAuthSystemMarker);
}

function getFirstUserText(messages: AnthropicMessageParam[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return "";
  if (typeof firstUserMessage.content === "string") return firstUserMessage.content;
  if (!Array.isArray(firstUserMessage.content)) return "";
  const firstTextBlock = firstUserMessage.content.find((block) => block.type === "text" && typeof block.text === "string");
  return typeof firstTextBlock?.text === "string" ? firstTextBlock.text : "";
}

function buildBillingHeaderValue(messages: AnthropicMessageParam[]): string | undefined {
  const messageText = getFirstUserText(messages);
  if (!messageText) return undefined;

  const cch = createHash("sha256").update(messageText).digest("hex").slice(0, 5);
  const sampledCharacters = BILLING_HEADER_POSITIONS.map((index) => messageText[index] || "0").join("");
  const suffix = createHash("sha256").update(`${BILLING_HEADER_SALT}${sampledCharacters}${CLAUDE_CODE_VERSION}`).digest("hex").slice(0, 3);

  return [
    ANTHROPIC_BILLING_HEADER_PREFIX,
    `cc_version=${CLAUDE_CODE_VERSION}.${suffix};`,
    `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`,
    `cch=${cch};`,
  ].join(" ");
}

function normalizeSystemBlock(block: unknown): AnthropicTextBlock {
  if (typeof block === "string") return { type: "text", text: block };
  if (isRecord(block) && typeof block.text === "string") return { ...block, type: "text", text: block.text };
  return { type: "text", text: "" };
}

function prependBillingHeader(system: unknown, messages: AnthropicMessageParam[]): unknown {
  const billingHeader = buildBillingHeaderValue(messages);
  if (!billingHeader) return system;

  const systemBlocks = Array.isArray(system) ? system.map(normalizeSystemBlock) : system == null ? [] : [normalizeSystemBlock(system)];
  if (systemBlocks.some((block) => block.text.includes(ANTHROPIC_BILLING_HEADER_PREFIX))) return systemBlocks;

  return [{ type: "text", text: billingHeader }, ...systemBlocks];
}

function splitAssistantToolUseTrailingContent(messages: AnthropicMessageParam[]): AnthropicMessageParam[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];

    const firstToolUseIndex = message.content.findIndex((block) => block.type === "tool_use");
    if (firstToolUseIndex === -1) return [message];

    const trailingBlocks = message.content.slice(firstToolUseIndex);
    if (!trailingBlocks.some((block) => block.type !== "tool_use")) return [message];

    return [
      { ...message, content: message.content.filter((block) => block.type !== "tool_use") },
      { ...message, content: message.content.filter((block) => block.type === "tool_use") },
    ];
  });
}

function shapeAnthropicOAuthPayload(payload: unknown): unknown {
  if (!isAnthropicMessagesPayload(payload) || !isAnthropicOAuthPayload(payload)) return payload;
  const messages = payload.messages as AnthropicMessageParam[];
  const normalizedMessages = splitAssistantToolUseTrailingContent(messages);
  return {
    ...payload,
    messages: normalizedMessages,
    system: prependBillingHeader(payload.system, normalizedMessages),
  };
}

function shapeMemeditProviderPayload(payload: unknown, apiKey: string): unknown {
  return isAnthropicOAuthApiKey(apiKey) ? shapeAnthropicOAuthPayload(payload) : payload;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars = PREVIEW_CHARS): string {
  const compact = compactText(value);
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: AnyRecord) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "toolCall" && typeof part.name === "string") return `tool call: ${part.name} ${safeJson(part.arguments ?? {})}`;
      if (part?.type === "thinking" && typeof part.thinking === "string") return part.thinking;
      if (part?.type === "image") return "[image omitted]";
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function estimateEntryTokens(entry: SessionEntry): number {
  const message = entryToAgentMessage(entry);
  return message ? estimateTokens(message as never) : 0;
}

function estimateEntriesTokens(entries: SessionEntry[]): number {
  return entries.reduce((total, entry) => total + estimateEntryTokens(entry), 0);
}

function estimateContextItemsTokens(items: ContextItem[]): number {
  return items.reduce((total, item) => total + estimateEntryTokens(item.entry), 0);
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

function applyHardDelete(
  ctx: ExtensionContext,
  deleteIds: Set<string>,
  uncountedIds = new Set<string>(),
  recacheScopeEntries?: SessionEntry[],
): { total: number; counted: number; tokensSaved: number; estimatedRecacheTokens: number; deletedItems: DeletedItem[] } {
  if (deleteIds.size === 0) return { total: 0, counted: 0, tokensSaved: 0, estimatedRecacheTokens: 0, deletedItems: [] };

  const manager = ctx.sessionManager as AnyRecord;
  const header = manager.getHeader?.();
  if (!header) throw new Error("Current session has no header; cannot rewrite session log");

  const entries = (manager.getEntries?.() ?? []) as SessionEntry[];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const oldLeafId = manager.getLeafId?.() ?? null;
  const expandedDeleteIds = expandToolDependencies(entries, deleteIds);
  const recacheScope = recacheScopeEntries && recacheScopeEntries.length > 0 ? recacheScopeEntries : entries.filter(entryParticipatesInContext);
  const firstDeletedIndex = recacheScope.findIndex((entry) => expandedDeleteIds.has(entry.id));

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
  const countedEntries = removed.filter((entry) => entryParticipatesInContext(entry) && !uncountedIds.has(entry.id));
  const deletedItems = countedEntries.map(previewEntry);
  const tokensSaved = estimateEntriesTokens(countedEntries);
  const estimatedRecacheTokens =
    firstDeletedIndex < 0
      ? 0
      : estimateEntriesTokens(recacheScope.slice(firstDeletedIndex + 1).filter((entry) => !expandedDeleteIds.has(entry.id)));
  return { total: removed.length, counted: deletedItems.length, tokensSaved, estimatedRecacheTokens, deletedItems };
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

function usageTotalTokens(usage: AnyRecord | undefined): number {
  if (!usage) return 0;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
}

// Model cost fields are quoted in dollars per MILLION tokens; convert to $/token.
const COST_TOKEN_DIVISOR = 1_000_000;

type CachePricing = {
  inputPerToken: number;
  cacheReadPerToken: number;
  cacheWritePerToken: number;
};

// Resolve per-token cache prices. When a provider omits a cache-read or
// cache-write price the tokens are billed at the plain input rate, so that is
// the correct fallback (no cache discount, no separate write surcharge).
function cachePricing(model: AnyRecord | undefined): CachePricing {
  const cost = (model?.cost ?? {}) as AnyRecord;
  const input = typeof cost.input === "number" ? cost.input : 0;
  const cacheRead = typeof cost.cacheRead === "number" && cost.cacheRead > 0 ? cost.cacheRead : input;
  const cacheWrite = typeof cost.cacheWrite === "number" && cost.cacheWrite > 0 ? cost.cacheWrite : input;
  return {
    inputPerToken: input / COST_TOKEN_DIVISOR,
    cacheReadPerToken: cacheRead / COST_TOKEN_DIVISOR,
    cacheWritePerToken: cacheWrite / COST_TOKEN_DIVISOR,
  };
}

// The cache calculus, expressed as two flows rather than one snapshot:
//   - One-off recache cost: the tail after the first deletion loses its cache
//     prefix, so on the NEXT turn those tokens are re-written to cache. Without
//     the prune they would have been a cache read, so the extra cost is only
//     (cacheWrite - cacheRead) per token, paid once.
//   - Ongoing saving: the deleted tokens are no longer re-read from cache on
//     EVERY subsequent turn, saving cacheRead per token per turn.
function recacheEconomics(
  deletedTokens: number,
  recacheTokens: number,
  model: AnyRecord | undefined,
): { recacheCost: number; savingPerTurnCost: number; breakEvenTurns: number | undefined } {
  const pricing = cachePricing(model);
  const recachePenaltyPerToken = Math.max(0, pricing.cacheWritePerToken - pricing.cacheReadPerToken);
  const recacheCost = recacheTokens * recachePenaltyPerToken;
  const savingPerTurnCost = deletedTokens * pricing.cacheReadPerToken;
  const breakEvenTurns = savingPerTurnCost > 0 ? Math.ceil(recacheCost / savingPerTurnCost) : undefined;
  return { recacheCost, savingPerTurnCost, breakEvenTurns };
}

function updateTelemetry(stats: MemeditStats): void {
  if (stats.status !== "applied" && stats.status !== "noop") return;
  telemetry.runs++;
  telemetry.contextTokensBefore += stats.contextTokensBefore || 0;
  telemetry.tokensSaved += stats.tokensSaved || 0;
  telemetry.estimatedRecacheTokens += stats.estimatedRecacheTokens || 0;
  telemetry.recacheCost += stats.recacheCost || 0;
  telemetry.savingPerTurnCost += stats.savingPerTurnCost || 0;
  telemetry.pruneTokens += stats.pruneTokens || 0;
  telemetry.pruneCost += stats.pruneCost || 0;
}

function formatTokens(value: number | undefined): string {
  const count = Math.round(value || 0);
  if (Math.abs(count) < 1000) return `${count}`;
  if (Math.abs(count) < 1_000_000) return `${(count / 1000).toFixed(Math.abs(count) < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatPercent(value: number | undefined): string {
  if (!Number.isFinite(value)) return "0.0%";
  return `${(value || 0).toFixed(1)}%`;
}

function formatCost(value: number | undefined): string {
  const cost = value || 0;
  if (cost === 0) return "$0";
  const abs = Math.abs(cost);
  if (abs < 0.000001) return `$${cost.toExponential(2)}`;
  if (abs < 0.01) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
}

function breakEvenText(stats: MemeditStats): string {
  if (!stats.savingPerTurnCost) return "no ongoing saving";
  if (!stats.recacheCost) return "net positive immediately";
  if (stats.breakEvenTurns === undefined) return "break-even unknown";
  return `pays for itself after ${stats.breakEvenTurns} turn${stats.breakEvenTurns === 1 ? "" : "s"}`;
}

function cumulativeContextPercent(): number {
  return telemetry.contextTokensBefore > 0 ? (telemetry.tokensSaved / telemetry.contextTokensBefore) * 100 : 0;
}

function cumulativeBreakEvenTurns(): number | undefined {
  return telemetry.savingPerTurnCost > 0 ? Math.ceil(telemetry.recacheCost / telemetry.savingPerTurnCost) : undefined;
}

function contextUsageFields(ctx: ExtensionContext): Pick<MemeditStats, "contextWindowTokensBefore" | "contextWindowTokensLimit" | "contextWindowPercentBefore"> {
  const usage = ctx.getContextUsage();
  return {
    contextWindowTokensBefore: typeof usage?.tokens === "number" ? usage.tokens : undefined,
    contextWindowTokensLimit: typeof usage?.contextWindow === "number" ? usage.contextWindow : undefined,
    contextWindowPercentBefore: typeof usage?.percent === "number" ? usage.percent : undefined,
  };
}

function contextWindowSuffix(stats: MemeditStats): string {
  if (typeof stats.contextWindowPercentBefore !== "number") return "";
  const tokenDetails =
    typeof stats.contextWindowTokensBefore === "number" && typeof stats.contextWindowTokensLimit === "number"
      ? ` (${formatTokens(stats.contextWindowTokensBefore)} / ${formatTokens(stats.contextWindowTokensLimit)})`
      : "";
  return `; model window before prune: ${formatPercent(stats.contextWindowPercentBefore)}${tokenDetails}`;
}

function showPruningUi(ctx: ExtensionContext, candidates: number): void {
  if (!ctx.hasUI) return;
  const candidateText = `${candidates} candidate${candidates === 1 ? "" : "s"}`;
  ctx.ui.setStatus(SYSTEM_STATUS_KEY, `memedit:pruning(${candidates})`);
  ctx.ui.setWidget(PRUNING_WIDGET_KEY, [
    `✂ pi-memedit is pruning ${candidateText}…`,
    "Pi will continue after the memory edit finishes.",
  ]);
}

function clearPruningUi(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(PRUNING_WIDGET_KEY, undefined);
}

function footerStatusText(): string {
  if (isSubagentRuntimeBlocked()) return "memedit:off(subagent)";
  if (!enabled) return "memedit:off";
  if (realizedSavingsCost > 0) return `memedit:${formatCost(realizedSavingsCost)} saved`;
  if (lastStats?.status === "applied") return `memedit:${formatTokens(lastStats.tokensSaved)} pruned`;
  if (lastStats?.status === "noop") return "memedit:noop";
  return `memedit:${lastStats?.status ?? "on"}`;
}

function memeditStatusText(stats: MemeditStats): string {
  if (stats.status === "applied") return `${EXTENSION_NAME}: deleted ${stats.deleted} context entr${stats.deleted === 1 ? "y" : "ies"}.`;
  if (stats.status === "noop") return `${EXTENSION_NAME}: no context entries deleted.`;
  if (stats.status === "skipped") return `${EXTENSION_NAME}: skipped${stats.error ? ` (${stats.error})` : ""}.`;
  return `${EXTENSION_NAME}: failed${stats.error ? ` (${stats.error})` : ""}.`;
}

function statusMessage(stats: MemeditStats) {
  const lines = [`${memeditStatusText(stats)} Candidates: ${stats.candidates}; selected: ${stats.selected}; ignored: ${stats.ignored}.`];
  if (stats.status === "applied" || stats.status === "noop") {
    lines.push(
      `Context: ${formatPercent(stats.contextPercentSaved)} pruned (${formatTokens(stats.tokensSaved)} deleted / ${formatTokens(stats.contextTokensBefore)} active${contextWindowSuffix(stats)}).`,
      `Cache calculus: re-caches ${formatTokens(stats.estimatedRecacheTokens)} tokens once (${formatCost(stats.recacheCost)}) to save ${formatCost(stats.savingPerTurnCost)}/turn — ${breakEvenText(stats)}.`,
      `Prune-pass overhead: ${formatTokens(stats.pruneTokens)} tokens, ${formatCost(stats.pruneCost)}.`,
    );
  }
  if (showDeletedItems && stats.deletedItems && stats.deletedItems.length > 0) {
    lines.push("Removed:", ...stats.deletedItems.map(formatDeletedItem));
  }

  return {
    customType: STATUS_MESSAGE_TYPE,
    content: lines.join("\n"),
    display: true,
    details: stats,
  };
}

async function runMemedit(ctx: ExtensionContext, mode: "auto" | "manual", startLeafId: string | null | undefined): Promise<MemeditStats | undefined> {
  if (isSubagentRuntimeBlocked()) {
    lastStats = { at: Date.now(), mode, status: "skipped", candidates: 0, selected: 0, deleted: 0, ignored: 0, error: subagentDisabledReason() };
    return lastStats;
  }
  if (!enabled || running) return;
  const model = ctx.model;
  if (!model) return;

  const manager = ctx.sessionManager as AnyRecord;
  const branch = (manager.getBranch?.() ?? []) as SessionEntry[];
  const contextUsageBefore = contextUsageFields(ctx);
  const scopedEntryIds = entryIdsAfter(branch, startLeafId);
  const protectedEntryIds = protectFinalAssistantTextResponse(branch, scopedEntryIds);
  const items = collectContextItems(branch, scopedEntryIds, protectedEntryIds);
  const activeContextEntries = items.map((item) => item.entry);
  const contextTokensBefore = estimateContextItemsTokens(items);
  const candidates = items.filter((item) => item.removable && item.number !== undefined);
  if (candidates.length === 0) {
    lastStats = { at: Date.now(), mode, status: "skipped", candidates: 0, selected: 0, deleted: 0, ignored: 0, contextTokensBefore, ...contextUsageBefore };
    return lastStats;
  }

  running = true;
  showPruningUi(ctx, candidates.length);
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      const authError = auth.ok === false ? auth.error : `No API key for ${model.provider}`;
      lastStats = {
        at: Date.now(),
        mode,
        status: "skipped",
        candidates: candidates.length,
        selected: 0,
        deleted: 0,
        ignored: 0,
        contextTokensBefore,
        ...contextUsageBefore,
        error: authError,
      };
      return lastStats;
    }

    const response = await completeSimple(
      model,
      {
        systemPrompt: PRUNE_SYSTEM_PROMPT,
        messages: buildPruneMessages(items),
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: RESPONSE_MAX_TOKENS,
        sessionId: manager.getSessionId?.(),
        cacheRetention: "short",
        signal: ctx.signal,
        onPayload: (payload) => shapeMemeditProviderPayload(payload, auth.apiKey),
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
    const deleted = applyHardDelete(ctx, rewriteIds, housekeepingIds, activeContextEntries);
    const pruneTokens = usageTotalTokens(response.usage as AnyRecord | undefined);
    const pruneCost = response.usage?.cost?.total || 0;
    const { recacheCost, savingPerTurnCost, breakEvenTurns } = recacheEconomics(
      deleted.tokensSaved,
      deleted.estimatedRecacheTokens,
      model as AnyRecord,
    );
    const contextPercentSaved = contextTokensBefore > 0 ? (deleted.tokensSaved / contextTokensBefore) * 100 : 0;
    lastStats = {
      at: Date.now(),
      mode,
      status: deleted.counted > 0 ? "applied" : "noop",
      candidates: candidates.length,
      selected: selectedIds.size,
      deleted: deleted.counted,
      ignored,
      contextTokensBefore,
      ...contextUsageBefore,
      tokensSaved: deleted.tokensSaved,
      estimatedRecacheTokens: deleted.estimatedRecacheTokens,
      contextPercentSaved,
      recacheCost,
      savingPerTurnCost,
      breakEvenTurns,
      pruneTokens,
      pruneCost,
      deletedItems: deleted.deletedItems,
    };
    updateTelemetry(lastStats);
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
      contextTokensBefore,
      ...contextUsageBefore,
      error: overflow ? "prune request exceeded context; left unchanged for normal Pi compaction" : message,
    };
    if (ctx.hasUI && !overflow) ctx.ui.notify(`pi-memedit failed: ${lastStats.error}`, "warning");
  } finally {
    running = false;
    clearPruningUi(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, footerStatusText());
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
    `pi-memedit: ${isSubagentRuntimeBlocked() ? subagentDisabledReason() : enabled ? "enabled" : "disabled"}`,
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
    `Last context reduction: ${formatPercent(lastStats.contextPercentSaved)} (${formatTokens(lastStats.tokensSaved)} deleted / ${formatTokens(lastStats.contextTokensBefore)} active)`,
    `Last cache calculus: re-cache ${formatTokens(lastStats.estimatedRecacheTokens)} tokens once (${formatCost(lastStats.recacheCost)}) vs ${formatCost(lastStats.savingPerTurnCost)}/turn saved — ${breakEvenText(lastStats)}`,
    `Last prune-pass overhead: ${formatTokens(lastStats.pruneTokens)} tokens, ${formatCost(lastStats.pruneCost)}`,
    `Cumulative context pruned: ${formatPercent(cumulativeContextPercent())} (${formatTokens(telemetry.tokensSaved)} deleted / ${formatTokens(telemetry.contextTokensBefore)} active considered)`,
    `Cumulative cache calculus: ${formatCost(telemetry.recacheCost)} one-off recache vs ${formatCost(telemetry.savingPerTurnCost)}/turn saved${cumulativeBreakEvenTurns() === undefined ? "" : ` — break-even after ${cumulativeBreakEvenTurns()} turn${cumulativeBreakEvenTurns() === 1 ? "" : "s"}`}`,
    `Cumulative prune-pass overhead: ${formatTokens(telemetry.pruneTokens)} tokens, ${formatCost(telemetry.pruneCost)}`,
    `Realized saving so far: ${formatCost(realizedSavingsCost)} over ${realizedSavingsCalls} API call${realizedSavingsCalls === 1 ? "" : "s"} (${formatCost(telemetry.savingPerTurnCost)}/call active)`,
  ];
  if (typeof lastStats.contextWindowPercentBefore === "number") {
    const tokenDetails =
      typeof lastStats.contextWindowTokensBefore === "number" && typeof lastStats.contextWindowTokensLimit === "number"
        ? ` (${formatTokens(lastStats.contextWindowTokensBefore)} / ${formatTokens(lastStats.contextWindowTokensLimit)})`
        : "";
    lines.push(`Model window before last prune: ${formatPercent(lastStats.contextWindowPercentBefore)}${tokenDetails}`);
  }
  if (showDeletedItems && lastStats.deletedItems && lastStats.deletedItems.length > 0) {
    lines.push("Removed:", ...lastStats.deletedItems.map(formatDeletedItem));
  }
  if (lastStats.error) lines.push(`Error: ${lastStats.error}`);
  return lines.join("\n");
}

export default function memedit(pi: ExtensionAPI) {
  if (isSubagentRuntimeBlocked()) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, "memedit:off(subagent)");
    });
    pi.registerCommand("memedit", {
      description: "Show why pi-memedit is disabled in this subagent child process",
      handler: async (_args, ctx) => {
        if (ctx.hasUI) ctx.ui.notify(formatStats(), "info");
      },
    });
    return;
  }

  installAgentSessionPatch();

  pi.on("session_start", async (_event, ctx) => {
    sessionLogIsAuthoritative = false;
    if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, footerStatusText());
  });

  pi.on("context", async (event, ctx) => {
    if (sessionLogIsAuthoritative) {
      const messages = currentSessionMessages(ctx);
      if (messages) return { messages: messages as never };
    }
    const filtered = event.messages.filter((message: AnyRecord) => !isStatusAgentMessage(message));
    if (filtered.length !== event.messages.length) return { messages: filtered as never };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const startLeafId = pendingRunStartLeafId;
    if (startLeafId === undefined) return;

    pendingRunStartLeafId = undefined;
    lastCompletedRunStartLeafId = startLeafId;
    const stats = await runMemedit(ctx, "auto", startLeafId);
    if (stats) return { message: statusMessage(stats) };
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeRunStartLeafId = (ctx.sessionManager as AnyRecord).getLeafId?.() ?? null;
  });

  // Every provider request after a prune omits the deleted tokens, so the
  // ongoing cache-read saving is realized one API call at a time. Tick it up
  // live instead of waiting for the next prune or the end of the run.
  pi.on("before_provider_request", async (_event, ctx) => {
    if (isSubagentRuntimeBlocked() || !enabled) return;
    if (running) return; // the prune's own LLM call is overhead, not a saving
    if (telemetry.savingPerTurnCost <= 0) return;
    realizedSavingsCost += telemetry.savingPerTurnCost;
    realizedSavingsCalls += 1;
    if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, footerStatusText());
  });

  pi.on("agent_end", async (event, ctx) => {
    const startLeafId = activeRunStartLeafId;
    activeRunStartLeafId = undefined;

    const unsuccessfulReason = unsuccessfulRunReason(event.messages);
    if (unsuccessfulReason) {
      pendingRunStartLeafId = undefined;
      lastStats = skippedStats(`agent run did not complete cleanly (${unsuccessfulReason})`);
      if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, enabled ? "memedit:skipped" : "memedit:off");
      return;
    }

    pendingRunStartLeafId = startLeafId;
    lastCompletedRunStartLeafId = startLeafId;
    if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, footerStatusText());
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
