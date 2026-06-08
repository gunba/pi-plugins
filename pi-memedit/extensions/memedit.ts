import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { AgentSession, estimateTokens, keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { encodingForModel, getEncoding } from "js-tiktoken";

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

type CacheImpact = {
  scopeEntries: number;
  scopeTokens: number;
  stablePrefixTokens: number;
  invalidatedTailTokens: number;
  droppedTailTokens: number;
  keptTailTokens: number;
  firstDeletedIndex?: number;
  firstDeletedRole?: string;
  firstDeletedPreview?: string;
};

type MemeditStats = {
  at: number;
  mode: "auto" | "manual" | "live";
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
  cacheImpact?: CacheImpact;
  // Cache calculus: rewriting the kept tail is a one-off cost paid on the next
  // turn, while deleted-token saving recurs on every subsequent provider
  // request. Prune-pass usage is reported separately, but it no longer gates or
  // rewrites the cache payback calculation.
  recacheCost?: number; // one-off $ to rewrite/cache the kept invalidated tail
  savingPerCallCost?: number; // $ saved on every subsequent provider request
  breakEvenCalls?: number; // future API calls until the cache rewrite pays for itself
  horizonCalls?: number; // E: provider requests the deletion is expected to keep saving over
  declinedForCost?: number; // model-selected deletions skipped because recache outweighs savings
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
  savingPerCallCost: number;
  pruneTokens: number;
  pruneCost: number;
};

type MemeditSettings = {
  enabled: boolean;
  liveEnabled: boolean;
  showDeletedItems: boolean;
};

type PrunePromptMode = "next-request" | "continuation" | "manual";

type RunMemeditOptions = {
  upcomingRequest?: string;
  promptMode?: PrunePromptMode;
  promptScope?: "full" | "scoped";
  extraProtectedEntryIds?: Set<string>;
  showStatusMessage?: boolean;
};

const EXTENSION_NAME = "pi-memedit";
const STATUS_MESSAGE_TYPE = "pi-memedit-status";
const SYSTEM_STATUS_KEY = "pi-memedit";
const PRUNING_WIDGET_KEY = "pi-memedit-pruning";
const RESPONSE_MAX_TOKENS = 2048;
const SETTINGS_FILE = process.env.PI_MEMEDIT_SETTINGS || join(os.homedir(), ".pi", "agent", "memedit", "settings.json");
const DEFAULT_SETTINGS: MemeditSettings = { enabled: true, liveEnabled: true, showDeletedItems: false };
let settingsLoadError: string | undefined;
const PREVIEW_CHARS = 160;
const LIVE_MIN_TURN_INDEX = 1;
const LIVE_MIN_CANDIDATES = 100;
const LIVE_MIN_CANDIDATE_TOKENS = 50_000;
const AUTO_MIN_CANDIDATES = 40;
const AUTO_MIN_CANDIDATE_TOKENS = 20_000;
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

THE NEXT REQUEST
You may be handed the user's next request, tagged <next_request>. It is the
session's immediate future: keep every entry it will draw on, even loosely.
It sharpens the test, but it never licenses deleting a record merely because the
request does not mention it — the session outlives this one request.

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
let liveEnabled = settings.liveEnabled;
let showDeletedItems = settings.showDeletedItems;
let running = false;
let sessionLogIsAuthoritative = false;
let lastLivePruneTurnIndex = -1;
// Entries a prune pass has already judged, plus everything present when the
// session was resumed/restarted. Seeded at session_start from the existing branch
// (so a resumed conversation is frozen — context only) and grown with the
// survivors of each pass (so nothing is judged twice). This replaces the old
// leaf-id boundary entirely: identity, not position, decides what is prunable, so
// there is nothing to drift, go null, or re-scope already-judged history.
let consideredEntryIds = new Set<string>();
// Set when a run ends uncleanly so the next before_agent_start pass is skipped
// once, leaving that run's entries unjudged (still candidates for a later pass).
let skipNextAutoPrune = false;
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
  savingPerCallCost: 0,
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

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (isEnabled(value)) return true;
    if (isDisabled(value)) return false;
  }
  return fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

function loadSettings(): MemeditSettings {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<MemeditSettings>;
    settingsLoadError = undefined;
    return {
      enabled: readBoolean(parsed.enabled, DEFAULT_SETTINGS.enabled),
      liveEnabled: readBoolean(parsed.liveEnabled, DEFAULT_SETTINGS.liveEnabled),
      showDeletedItems: readBoolean(parsed.showDeletedItems, DEFAULT_SETTINGS.showDeletedItems),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      settingsLoadError = undefined;
      return { ...DEFAULT_SETTINGS };
    }
    settingsLoadError = `could not read ${SETTINGS_FILE}: ${errorMessage(error)}`;
    return { enabled: false, liveEnabled: false, showDeletedItems: DEFAULT_SETTINGS.showDeletedItems };
  }
}

function writeUtf8FileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tempFile = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tempFile, content, "utf8");
    renameSync(tempFile, file);
  } catch (error) {
    try {
      rmSync(tempFile, { force: true });
    } catch {
      // Best-effort temp cleanup; preserve the original write/rename failure.
    }
    throw error;
  }
}

function saveSettings(): void {
  settings = { enabled, liveEnabled, showDeletedItems };
  writeUtf8FileAtomic(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
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

function setLiveEnabled(value: boolean): void {
  liveEnabled = value;
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

function candidateScope(branch: SessionEntry[]): Set<string> {
  // Pruning candidates = entries this live session produced that no pass has judged
  // yet. Everything present at session_start (a resumed/restarted conversation) and
  // every survivor of a prior pass lives in consideredEntryIds, so it is context
  // only and never re-offered. No positional boundary means nothing can degenerate
  // to "the whole branch".
  const ids = new Set<string>();
  for (const entry of branch) {
    if (!consideredEntryIds.has(entry.id)) ids.add(entry.id);
  }
  return ids;
}

function currentTurnEntryIds(branch: SessionEntry[]): Set<string> {
  // The freshest turn is the most recent assistant message and everything after it
  // (its tool results) — exactly what the continuation will consume. Derived from
  // the branch at prune time, so it cannot drift or go stale like a stored leaf id.
  const ids = new Set<string>();
  let start = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && (entry.message as AnyRecord)?.role === "assistant") {
      start = i;
      break;
    }
  }
  if (start < 0) return ids;
  for (let i = start; i < branch.length; i++) ids.add(branch[i].id);
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

function appendLabeledValue(lines: string[], label: string, value: unknown): void {
  if (typeof value === "string") {
    if (value.trim()) lines.push(`[${label}]\n${value}`);
  } else if (value !== undefined && value !== null) {
    lines.push(`[${label}]\n${safeJson(value)}`);
  }
}

function bashExecutionText(message: AnyRecord | undefined): string {
  const lines: string[] = [];
  if (!message) return "";
  if (typeof message.command === "string" && message.command.trim()) lines.push(`$ ${message.command}`);
  appendLabeledValue(lines, "stdout", message.output);
  appendLabeledValue(lines, "stderr", message.stderr);
  appendLabeledValue(lines, "error", message.error);
  if (typeof message.exitCode === "number") lines.push(`[exitCode]\n${message.exitCode}`);
  if (typeof message.signal === "string" && message.signal.trim()) lines.push(`[signal]\n${message.signal}`);
  return lines.join("\n\n");
}

function messagePromptText(message: AnyRecord | undefined): string {
  if (!message) return "";
  if (message.role === "bashExecution") return bashExecutionText(message);
  return contentText(message.content);
}

function entryPromptText(entry: SessionEntry): string {
  if (entry.type === "message") return messagePromptText(entry.message as AnyRecord);
  if (entry.type === "custom_message") return contentText(entry.content);
  if (entry.type === "branch_summary") return String(entry.summary ?? "");
  if (entry.type === "compaction") return String(entry.summary ?? "");
  return "";
}

function formatPruneItem(item: ContextItem): string {
  const tag = item.number ? `[${item.number}]` : "[context]";
  const scope = item.scoped ? "candidate" : "context";
  const mutability = item.removable ? "removable" : "protected";
  const text = entryPromptText(item.entry).trim() || "(no text)";
  return `${tag} ${entryPromptRole(item.entry)} (${scope}; ${mutability}; id=${item.entry.id})\n${text}`;
}

function buildPruneMessages(items: ContextItem[], options: { upcomingRequest?: string; promptMode?: PrunePromptMode } = {}): Message[] {
  const transcript = items.map(formatPruneItem).join("\n\n---\n\n");
  const upcoming = options.upcomingRequest?.trim();
  const upcomingBlock = upcoming
    ? `The user's next request — the work this session is about to resume — is:\n<next_request>\n${upcoming}\n</next_request>\nRead the transcript through the lens of this request: keep whatever it will need, and treat as bloat only what it clearly leaves behind.\n\n`
    : "";
  const continuationBlock =
    options.promptMode === "continuation"
      ? "The main agent is mid-run and will continue after this memory edit. Earlier conversation may be omitted from this pruning prompt and is protected. Be extra conservative: keep the freshest turn, open tool results, current file state, unresolved findings, and anything the continuing agent may need. Delete only stale current-run clutter that is clearly superseded inside the shown transcript.\n\n"
      : "";
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Conversation entries follow. Only entries tagged [N] are deletion candidates; [context] entries are context only and must not be returned.\n\n${continuationBlock}${upcomingBlock}${transcript}\n\nReturn the deletion JSON now.`,
        },
      ],
      timestamp: Date.now(),
    },
  ];
}

function pruneSystemPrompt(promptMode: PrunePromptMode | undefined): string {
  if (promptMode === "continuation") {
    return `${PRUNE_SYSTEM_PROMPT}\n\nLIVE CONTINUATION MODE\nThe main agent has not finished. Prefer false negatives over false positives: deleting a result needed by the continuation is worse than keeping bloat. Protected [context] entries include fresh or otherwise unsafe-to-delete entries.`;
  }
  return PRUNE_SYSTEM_PROMPT;
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

const openAiEncoders = new Map<string, ReturnType<typeof getEncoding>>();

function usesOpenAiTokenizer(model: AnyRecord | undefined): boolean {
  const provider = String(model?.provider ?? "").toLowerCase();
  const id = String(model?.id ?? "").toLowerCase();
  if (/anthropic|claude|google|gemini|mistral|bedrock/.test(`${provider} ${id}`)) return false;
  return /openai|azure|codex|gpt-|\bo[1-9]|chatgpt/.test(`${provider} ${id}`);
}

function openAiEncoding(model: AnyRecord | undefined): ReturnType<typeof getEncoding> | undefined {
  if (!usesOpenAiTokenizer(model)) return undefined;
  const modelId = String(model?.id ?? "gpt-4o");
  const encodingName = /gpt-4o|gpt-4\.1|gpt-5|\bo[1-9]|codex/i.test(modelId) ? "o200k_base" : "cl100k_base";
  const key = `${modelId}:${encodingName}`;
  const cached = openAiEncoders.get(key);
  if (cached) return cached;
  try {
    const encoder = encodingForModel(modelId as never);
    openAiEncoders.set(key, encoder);
    return encoder;
  } catch {
    const encoder = getEncoding(encodingName);
    openAiEncoders.set(key, encoder);
    return encoder;
  }
}

function estimateTextTokens(text: string, model?: AnyRecord): number {
  const encoder = openAiEncoding(model);
  if (encoder) return encoder.encode(text).length;
  return Math.ceil(text.length / 4);
}

function estimateContentTokens(content: unknown, model?: AnyRecord): number {
  if (typeof content === "string") return estimateTextTokens(content, model);
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part: AnyRecord) => {
    if (part?.type === "text" && typeof part.text === "string") return total + estimateTextTokens(part.text, model);
    if (part?.type === "image") return total + Math.ceil(4800 / 4);
    return total;
  }, 0);
}

function estimateMessageTokens(message: AnyRecord, model?: AnyRecord): number {
  if (usesOpenAiTokenizer(model)) {
    if (message.role === "user" || message.role === "custom" || message.role === "toolResult") return estimateContentTokens(message.content, model);
    if (message.role === "assistant") {
      return (message.content ?? []).reduce((total: number, block: AnyRecord) => {
        if (block?.type === "text" && typeof block.text === "string") return total + estimateTextTokens(block.text, model);
        if (block?.type === "thinking" && typeof block.thinking === "string") return total + estimateTextTokens(block.thinking, model);
        if (block?.type === "toolCall") return total + estimateTextTokens(`${block.name ?? ""}${safeJson(block.arguments ?? {})}`, model);
        return total;
      }, 0);
    }
    if (message.role === "bashExecution") return estimateTextTokens(bashExecutionText(message), model);
    if (message.role === "branchSummary" || message.role === "compactionSummary") return estimateTextTokens(String(message.summary ?? ""), model);
  }
  return estimateTokens(message as never);
}

function estimateEntryTokens(entry: SessionEntry, model?: AnyRecord): number {
  const message = entryToAgentMessage(entry);
  return message ? estimateMessageTokens(message as AnyRecord, model) : 0;
}

function estimateEntriesTokens(entries: SessionEntry[], model?: AnyRecord): number {
  return entries.reduce((total, entry) => total + estimateEntryTokens(entry, model), 0);
}

function estimateContextItemsTokens(items: ContextItem[], model?: AnyRecord): number {
  return items.reduce((total, item) => total + estimateEntryTokens(item.entry, model), 0);
}

function previewEntry(entry: SessionEntry): DeletedItem {
  if (entry.type === "message") {
    const message = entry.message as AnyRecord;
    const role = message.role === "toolResult" ? `toolResult:${message.toolName ?? "tool"}` : String(message.role ?? "message");
    return { id: entry.id, role, text: truncateText(entryPromptText(entry) || "(no text)") };
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

type DeleteProjection = {
  expandedDeleteIds: Set<string>;
  total: number;
  counted: number;
  tokensSaved: number;
  estimatedRecacheTokens: number;
  cacheImpact: CacheImpact;
  deletedItems: DeletedItem[];
};

function computeCacheImpact(recacheScope: SessionEntry[], expandedDeleteIds: Set<string>, model?: AnyRecord): CacheImpact {
  const tokenCounts = recacheScope.map((entry) => estimateEntryTokens(entry, model));
  const scopeTokens = tokenCounts.reduce((total, value) => total + value, 0);
  const firstDeletedIndex = recacheScope.findIndex((entry) => expandedDeleteIds.has(entry.id));
  if (firstDeletedIndex < 0) {
    return {
      scopeEntries: recacheScope.length,
      scopeTokens,
      stablePrefixTokens: scopeTokens,
      invalidatedTailTokens: 0,
      droppedTailTokens: 0,
      keptTailTokens: 0,
    };
  }

  let stablePrefixTokens = 0;
  let invalidatedTailTokens = 0;
  let droppedTailTokens = 0;
  let keptTailTokens = 0;
  for (let i = 0; i < recacheScope.length; i++) {
    const tokens = tokenCounts[i] ?? 0;
    if (i < firstDeletedIndex) {
      stablePrefixTokens += tokens;
    } else {
      invalidatedTailTokens += tokens;
      if (expandedDeleteIds.has(recacheScope[i].id)) droppedTailTokens += tokens;
      else keptTailTokens += tokens;
    }
  }

  const firstDeleted = recacheScope[firstDeletedIndex];
  return {
    scopeEntries: recacheScope.length,
    scopeTokens,
    stablePrefixTokens,
    invalidatedTailTokens,
    droppedTailTokens,
    keptTailTokens,
    firstDeletedIndex,
    firstDeletedRole: entryPromptRole(firstDeleted),
    firstDeletedPreview: truncateText(entryPromptText(firstDeleted), 120),
  };
}

function projectHardDelete(
  entries: SessionEntry[],
  deleteIds: Set<string>,
  uncountedIds = new Set<string>(),
  recacheScopeEntries?: SessionEntry[],
  model?: AnyRecord,
): DeleteProjection {
  const expandedDeleteIds = expandToolDependencies(entries, deleteIds);
  if (expandedDeleteIds.size === 0) {
    const recacheScope = recacheScopeEntries && recacheScopeEntries.length > 0 ? recacheScopeEntries : entries.filter(entryParticipatesInContext);
    const cacheImpact = computeCacheImpact(recacheScope, expandedDeleteIds, model);
    return { expandedDeleteIds, total: 0, counted: 0, tokensSaved: 0, estimatedRecacheTokens: 0, cacheImpact, deletedItems: [] };
  }

  const recacheScope = recacheScopeEntries && recacheScopeEntries.length > 0 ? recacheScopeEntries : entries.filter(entryParticipatesInContext);
  const removed = entries.filter((entry) => expandedDeleteIds.has(entry.id) || (entry.type === "label" && expandedDeleteIds.has(entry.targetId)));
  const countedEntries = removed.filter((entry) => entryParticipatesInContext(entry) && !uncountedIds.has(entry.id));
  const deletedItems = countedEntries.map(previewEntry);
  const tokensSaved = estimateEntriesTokens(countedEntries, model);
  const cacheImpact = computeCacheImpact(recacheScope, expandedDeleteIds, model);
  return {
    expandedDeleteIds,
    total: removed.length,
    counted: deletedItems.length,
    tokensSaved,
    estimatedRecacheTokens: cacheImpact.keptTailTokens,
    cacheImpact,
    deletedItems,
  };
}

function assertSessionRewriteSupported(manager: AnyRecord): void {
  const missing: string[] = [];
  if (typeof manager.getHeader !== "function") missing.push("getHeader()");
  if (typeof manager.getEntries !== "function") missing.push("getEntries()");
  if (typeof manager.getLeafId !== "function") missing.push("getLeafId()");
  if (typeof manager.getSessionFile !== "function") missing.push("getSessionFile()");
  if (!Array.isArray(manager.fileEntries)) missing.push("fileEntries[]");
  if (typeof manager._buildIndex !== "function") missing.push("_buildIndex()");
  if (missing.length > 0) throw new Error(`Pi session manager does not support safe pi-memedit rewrite; missing ${missing.join(", ")}`);
}

function validateRewrittenReferences(entries: SessionEntry[], keptIds: Set<string>): void {
  for (const entry of entries) {
    if (entry.parentId && !keptIds.has(entry.parentId)) throw new Error(`pi-memedit rewrite left dangling parentId on ${entry.id}`);
    if (entry.type === "compaction" && entry.firstKeptEntryId && !keptIds.has(entry.firstKeptEntryId)) {
      throw new Error(`pi-memedit rewrite left dangling firstKeptEntryId on ${entry.id}`);
    }
    if (entry.type === "branch_summary" && entry.fromId && !keptIds.has(entry.fromId)) {
      throw new Error(`pi-memedit rewrite left dangling branch_summary fromId on ${entry.id}`);
    }
    if (entry.type === "label" && typeof entry.targetId === "string" && !keptIds.has(entry.targetId)) {
      throw new Error(`pi-memedit rewrite left dangling label targetId on ${entry.id}`);
    }
  }
}

function applyHardDelete(
  ctx: ExtensionContext,
  deleteIds: Set<string>,
  uncountedIds = new Set<string>(),
  recacheScopeEntries?: SessionEntry[],
  model?: AnyRecord,
): DeleteProjection {
  const manager = ctx.sessionManager as AnyRecord;
  assertSessionRewriteSupported(manager);

  const header = manager.getHeader();
  if (!header) throw new Error("Current session has no header; cannot rewrite session log");

  const entries = manager.getEntries() as SessionEntry[];
  const projection = projectHardDelete(entries, deleteIds, uncountedIds, recacheScopeEntries, model);
  if (projection.expandedDeleteIds.size === 0) return projection;

  const sessionFile = manager.getSessionFile();
  if (typeof sessionFile !== "string" || !sessionFile) throw new Error("Current session has no writable session file; cannot rewrite session log");

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const oldLeafId = manager.getLeafId() ?? null;
  const retainedEntries = entries.filter((entry) => {
    if (projection.expandedDeleteIds.has(entry.id)) return false;
    if (entry.type === "label" && projection.expandedDeleteIds.has(entry.targetId)) return false;
    return true;
  });
  const retainedIds = new Set(retainedEntries.map((entry) => entry.id));
  const keptEntries = retainedEntries.filter((entry) => entry.type !== "label" || typeof entry.targetId !== "string" || retainedIds.has(entry.targetId));
  const keptIds = new Set(keptEntries.map((entry) => entry.id));

  const rewrittenEntries = keptEntries.map((entry) => {
    const next = structuredClone(entry) as SessionEntry;
    if (next.parentId && !keptIds.has(next.parentId)) {
      next.parentId = nearestKeptAncestor(next.parentId, keptIds, byId);
    }
    if (next.type === "compaction") {
      const replacement = replacementFirstKept(next, keptIds, byId);
      if (replacement && keptIds.has(replacement)) next.firstKeptEntryId = replacement;
      else delete next.firstKeptEntryId;
    }
    if (next.type === "branch_summary" && next.fromId && !keptIds.has(next.fromId)) {
      const replacement = nearestKeptAncestor(next.fromId, keptIds, byId);
      if (replacement) next.fromId = replacement;
      else delete next.fromId;
    }
    return next;
  });
  validateRewrittenReferences(rewrittenEntries, keptIds);

  const nextFileEntries = [header, ...rewrittenEntries];
  writeUtf8FileAtomic(sessionFile, `${nextFileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  manager.fileEntries = nextFileEntries;
  manager._buildIndex();
  manager.leafId = oldLeafId && keptIds.has(oldLeafId) ? oldLeafId : nearestKeptAncestor(oldLeafId, keptIds, byId);
  manager.flushed = true;

  sessionLogIsAuthoritative = true;
  markAgentStateNeedsSync(manager.getSessionId?.());
  return projection;
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
//     EVERY subsequent provider request, saving cacheRead per token per call.
//     A turn fans out into many provider requests (one per tool round-trip),
//     so the saving recurs per API call, not per user turn.
function recacheEconomics(
  deletedTokens: number,
  recacheTokens: number,
  model: AnyRecord | undefined,
): { recacheCost: number; savingPerCallCost: number; breakEvenCalls: number | undefined } {
  const pricing = cachePricing(model);
  const recachePenaltyPerToken = Math.max(0, pricing.cacheWritePerToken - pricing.cacheReadPerToken);
  const recacheCost = recacheTokens * recachePenaltyPerToken;
  const savingPerCallCost = deletedTokens * pricing.cacheReadPerToken;
  const breakEvenCalls = savingPerCallCost > 0 ? Math.ceil(recacheCost / savingPerCallCost) : undefined;
  return { recacheCost, savingPerCallCost, breakEvenCalls };
}

// --- Golden-rule profitability gate ---------------------------------------
//
// Applying a deletion invalidates the prompt cache from that entry onward, so the
// kept tail is re-written once at the cache-write rate. That one-off premium is
// only worth paying when the deleted tokens stop being re-read often enough to
// recover it: breakEvenCalls = recacheCost / savingPerCall must fall within the
// cache's remaining life E. The cached-prefix prune already paid for the analysis,
// so this is a marginal apply/skip decision, not a re-judgement of what to keep.
//
// E = min(E_session, calls-until-auto-compaction). Conversation length is
// heavy-tailed, so remaining provider requests are ~flat by age at a median of
// MEMEDIT_HORIZON_CALLS (measured across session history); compaction — which
// evicts the pruned region regardless — caps the horizon near the context ceiling.
const MEMEDIT_HORIZON_CALLS = 25;
const COMPACTION_RESERVE_TOKENS = 16_384; // Pi DEFAULT_COMPACTION_SETTINGS.reserveTokens
const HORIZON_GROWTH_SAMPLE = 8;
const HORIZON_GROWTH_FALLBACK = 3_000;

function assistantTotalTokensSequence(branch: SessionEntry[]): number[] {
  const sequence: number[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message as AnyRecord;
    if (message?.role !== "assistant") continue;
    const total = (message.usage as AnyRecord | undefined)?.totalTokens;
    if (typeof total === "number" && total > 0) sequence.push(total);
  }
  return sequence;
}

// Median positive turn-over-turn context growth, used to project how many more
// requests fit before auto-compaction. Median (not mean) because tool outputs make
// the per-turn delta heavy-tailed.
function recentGrowthPerCall(sequence: number[]): number {
  if (sequence.length < 2) return HORIZON_GROWTH_FALLBACK;
  const recent = sequence.slice(-(HORIZON_GROWTH_SAMPLE + 1));
  const deltas: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const delta = recent[i] - recent[i - 1];
    if (delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return HORIZON_GROWTH_FALLBACK;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] || HORIZON_GROWTH_FALLBACK;
}

function estimateForwardHorizon(ctx: ExtensionContext, branch: SessionEntry[], fallbackContextTokens: number): number {
  const usage = ctx.getContextUsage();
  const contextWindow = typeof usage?.contextWindow === "number" ? usage.contextWindow : 0;
  const contextNow = typeof usage?.tokens === "number" ? usage.tokens : fallbackContextTokens;
  if (contextWindow <= 0) return MEMEDIT_HORIZON_CALLS;
  const growth = recentGrowthPerCall(assistantTotalTokensSequence(branch));
  const headroom = contextWindow - COMPACTION_RESERVE_TOKENS - contextNow;
  const callsToCompaction = headroom > 0 ? headroom / growth : 0;
  return Math.max(1, Math.min(MEMEDIT_HORIZON_CALLS, Math.round(callsToCompaction)));
}

function pruneNetValue(cacheImpact: CacheImpact, model: AnyRecord | undefined, horizonCalls: number): number {
  const { recacheCost, savingPerCallCost } = recacheEconomics(cacheImpact.droppedTailTokens, cacheImpact.keptTailTokens, model);
  return savingPerCallCost * horizonCalls - recacheCost;
}

// Choose the subset of model-selected deletions worth applying. Declining the
// earliest, low-value deletions moves the cache-invalidation point later, shrinking
// the kept tail that must be re-cached. We pick the first-deletion index that
// maximises expected net value (ongoing saving over the horizon minus the one-off
// recache) and apply every deletion from there on; if no cut is net-positive the
// whole set is declined.
function selectProfitableDeletions(
  recacheScope: SessionEntry[],
  selectedIds: Set<string>,
  model: AnyRecord | undefined,
  horizonCalls: number,
): { appliedIds: Set<string>; declined: number } {
  if (selectedIds.size === 0) return { appliedIds: new Set(), declined: 0 };
  const expanded = expandToolDependencies(recacheScope, selectedIds);
  const pricing = cachePricing(model);
  const penaltyPerToken = Math.max(0, pricing.cacheWritePerToken - pricing.cacheReadPerToken);
  const readPerToken = pricing.cacheReadPerToken;
  // No usable cache pricing: the gate cannot judge, so honour the model's selection.
  if (readPerToken <= 0 && penaltyPerToken <= 0) return { appliedIds: new Set(expanded), declined: 0 };

  const tokens = recacheScope.map((entry) => estimateEntryTokens(entry, model));
  const isDeleted = recacheScope.map((entry) => expanded.has(entry.id));

  let droppedSuffix = 0;
  let keptSuffix = 0;
  let bestIndex = -1;
  let bestNet = 0; // baseline 0 = decline everything
  for (let i = recacheScope.length - 1; i >= 0; i--) {
    if (isDeleted[i]) droppedSuffix += tokens[i];
    else keptSuffix += tokens[i];
    if (!isDeleted[i]) continue;
    const net = readPerToken * horizonCalls * droppedSuffix - penaltyPerToken * keptSuffix;
    if (net > bestNet) {
      bestNet = net;
      bestIndex = i;
    }
  }

  const appliedIds = new Set<string>();
  if (bestIndex >= 0) {
    for (let i = bestIndex; i < recacheScope.length; i++) if (isDeleted[i]) appliedIds.add(recacheScope[i].id);
  }
  const declined = [...selectedIds].reduce((count, id) => (appliedIds.has(id) ? count : count + 1), 0);
  return { appliedIds, declined };
}

function updateTelemetry(stats: MemeditStats): void {
  if (stats.status !== "applied" && stats.status !== "noop" && !stats.pruneTokens && !stats.pruneCost) return;
  telemetry.runs++;
  if (stats.status === "applied" || stats.status === "noop") {
    telemetry.contextTokensBefore += stats.contextTokensBefore || 0;
    telemetry.tokensSaved += stats.tokensSaved || 0;
    telemetry.estimatedRecacheTokens += stats.estimatedRecacheTokens || 0;
    telemetry.recacheCost += stats.recacheCost || 0;
    telemetry.savingPerCallCost += stats.savingPerCallCost || 0;
  }
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
  if (!stats.savingPerCallCost) return "no ongoing saving";
  if (!stats.recacheCost) return "cache-positive immediately";
  if (stats.breakEvenCalls === undefined) return "break-even unknown";
  return `cache rewrite pays back after ${stats.breakEvenCalls} API call${stats.breakEvenCalls === 1 ? "" : "s"}`;
}

function cumulativeContextPercent(): number {
  return telemetry.contextTokensBefore > 0 ? (telemetry.tokensSaved / telemetry.contextTokensBefore) * 100 : 0;
}

function cumulativeBreakEvenCalls(): number | undefined {
  return telemetry.savingPerCallCost > 0 ? Math.ceil(telemetry.recacheCost / telemetry.savingPerCallCost) : undefined;
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

function statusColor(stats: MemeditStats): ThemeColor {
  if (stats.status === "applied") return "success";
  if (stats.status === "noop") return "muted";
  if (stats.status === "skipped") return "warning";
  return "error";
}

function styledStatusHeadline(stats: MemeditStats, theme: Theme): string {
  const color = statusColor(stats);
  return `${theme.fg(color, "✂")} ${theme.bold(theme.fg(color, memeditStatusText(stats)))}`;
}

function styledStatusSummary(stats: MemeditStats, theme: Theme): string[] {
  const lines = [
    `${theme.fg("dim", "Candidates")} ${theme.fg("muted", String(stats.candidates))}${theme.fg("dim", " · selected ")}${theme.fg("muted", String(stats.selected))}${theme.fg("dim", " · ignored ")}${theme.fg("muted", String(stats.ignored))}`,
  ];
  if (stats.status === "applied" || stats.status === "noop" || stats.tokensSaved !== undefined) {
    lines.push(
      `${theme.fg("dim", "Est. context")} ${theme.fg("success", formatPercent(stats.contextPercentSaved))} ${theme.fg("muted", `pruned (${formatTokens(stats.tokensSaved)} / ${formatTokens(stats.contextTokensBefore)} active)`)}`,
      `${theme.fg("dim", "Cache tail")} ${theme.fg("muted", `invalidate ${formatTokens(stats.cacheImpact?.invalidatedTailTokens)} · drop ${formatTokens(stats.cacheImpact?.droppedTailTokens)} · rewrite ${formatTokens(stats.cacheImpact?.keptTailTokens)} (${formatCost(stats.recacheCost)})`)}`,
      `${theme.fg("dim", "Savings")} ${theme.fg("success", `${formatCost(stats.savingPerCallCost)}/API call`)} ${theme.fg("muted", `· prune ${formatCost(stats.pruneCost)} · ${breakEvenText(stats)}`)}`,
    );
  }
  if (stats.declinedForCost) {
    lines.push(
      `${theme.fg("dim", "Declined")} ${theme.fg("muted", `${stats.declinedForCost} deletion${stats.declinedForCost === 1 ? "" : "s"} — recache > savings within ~${stats.horizonCalls ?? MEMEDIT_HORIZON_CALLS} calls`)}`,
    );
  }
  if (stats.error) lines.push(`${theme.fg("warning", "Reason")} ${theme.fg("muted", truncateText(stats.error, 220))}`);
  return lines;
}

function renderStatusMessage(stats: MemeditStats, expanded: boolean, theme: Theme) {
  const box = new Box(1, 0, (text: string) => theme.bg("customMessageBg", text));
  const lines = [styledStatusHeadline(stats, theme), ...styledStatusSummary(stats, theme)];
  if (expanded) {
    lines.push(
      theme.fg("borderMuted", "─".repeat(36)),
      `${theme.fg("dim", "Mode")} ${theme.fg("muted", stats.mode)}${theme.fg("dim", " · at ")}${theme.fg("muted", new Date(stats.at).toLocaleString())}`,
    );
    if (typeof stats.contextWindowPercentBefore === "number") {
      const tokenDetails =
        typeof stats.contextWindowTokensBefore === "number" && typeof stats.contextWindowTokensLimit === "number"
          ? ` (${formatTokens(stats.contextWindowTokensBefore)} / ${formatTokens(stats.contextWindowTokensLimit)})`
          : "";
      lines.push(`${theme.fg("dim", "Model window before prune")} ${theme.fg("muted", `${formatPercent(stats.contextWindowPercentBefore)}${tokenDetails}`)}`);
    }
    if (stats.cacheImpact) {
      lines.push(
        `${theme.fg("dim", "Cache scope")} ${theme.fg("muted", `${stats.cacheImpact.scopeEntries} entries, ${formatTokens(stats.cacheImpact.scopeTokens)} tokens`)}`,
        `${theme.fg("dim", "Stable prefix")} ${theme.fg("muted", formatTokens(stats.cacheImpact.stablePrefixTokens))}`,
        `${theme.fg("dim", "First invalidation")} ${theme.fg("muted", `${stats.cacheImpact.firstDeletedRole ?? "none"}${stats.cacheImpact.firstDeletedPreview ? ` — ${stats.cacheImpact.firstDeletedPreview}` : ""}`)}`,
      );
    }
    if (showDeletedItems && stats.deletedItems && stats.deletedItems.length > 0) {
      lines.push(theme.fg("warning", "Removed"), ...stats.deletedItems.map((item) => theme.fg("muted", formatDeletedItem(item))));
    }
  } else {
    lines.push(keyHint("app.tools.expand", "details"));
  }
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

function createPruningWidget(candidateText: string) {
  return (_tui: unknown, theme: Theme) => {
    const box = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
    box.addChild(
      new Text(
        `${theme.fg("warning", "✂")} ${theme.bold(theme.fg("warning", "pi-memedit pruning"))} ${theme.fg("muted", candidateText)}`,
        0,
        0,
      ),
    );
    box.addChild(new Text(theme.fg("dim", "Memory edit in progress — Pi will continue automatically."), 0, 0));
    return box;
  };
}

function showPruningUi(ctx: ExtensionContext, candidates: number): void {
  if (!ctx.hasUI) return;
  const candidateText = `${candidates} candidate${candidates === 1 ? "" : "s"}`;
  ctx.ui.setStatus(SYSTEM_STATUS_KEY, ctx.ui.theme.fg("warning", `memedit:pruning(${candidates})`));
  ctx.ui.setWidget(PRUNING_WIDGET_KEY, createPruningWidget(candidateText));
}

function clearPruningUi(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(PRUNING_WIDGET_KEY, undefined);
}

function footerStatusText(): string {
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
  if (stats.status === "applied" || stats.status === "noop" || stats.tokensSaved !== undefined) {
    lines.push(
      `Est. context: ${formatPercent(stats.contextPercentSaved)} pruned (${formatTokens(stats.tokensSaved)} deleted / ${formatTokens(stats.contextTokensBefore)} active${contextWindowSuffix(stats)}).`,
      `Cache impact: invalidates ${formatTokens(stats.cacheImpact?.invalidatedTailTokens)} tail tokens; drops ${formatTokens(stats.cacheImpact?.droppedTailTokens)} and rewrites ${formatTokens(stats.cacheImpact?.keptTailTokens)} kept tokens (${formatCost(stats.recacheCost)}).`,
      `Savings: ${formatCost(stats.savingPerCallCost)}/API call; prune pass ${formatTokens(stats.pruneTokens)} tokens, ${formatCost(stats.pruneCost)} — ${breakEvenText(stats)}.`,
    );
  }
  if (stats.declinedForCost) {
    lines.push(
      `Declined ${stats.declinedForCost} deletion${stats.declinedForCost === 1 ? "" : "s"} for cost: recache outweighs savings within the ~${stats.horizonCalls ?? MEMEDIT_HORIZON_CALLS}-call horizon.`,
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

function preflightAllowsRun(candidates: ContextItem[], model: AnyRecord, mode: "auto" | "manual" | "live"): boolean {
  if (mode === "manual") return true;

  const candidateTokens = estimateContextItemsTokens(candidates, model);
  if (mode === "live") {
    return (
      candidateTokens >= LIVE_MIN_CANDIDATE_TOKENS ||
      (candidates.length >= LIVE_MIN_CANDIDATES && candidateTokens >= Math.floor(LIVE_MIN_CANDIDATE_TOKENS / 2))
    );
  }

  return (
    candidateTokens >= AUTO_MIN_CANDIDATE_TOKENS ||
    (candidates.length >= AUTO_MIN_CANDIDATES && candidateTokens >= Math.floor(AUTO_MIN_CANDIDATE_TOKENS / 2))
  );
}

async function runMemedit(
  ctx: ExtensionContext,
  mode: "auto" | "manual" | "live",
  options: RunMemeditOptions = {},
): Promise<MemeditStats | undefined> {
  if ((!enabled && mode !== "manual") || running) return;
  const model = ctx.model;
  if (!model) return;

  const manager = ctx.sessionManager as AnyRecord;
  const branch = (manager.getBranch?.() ?? []) as SessionEntry[];
  const contextUsageBefore = contextUsageFields(ctx);
  const scopedEntryIds = candidateScope(branch);
  const protectedEntryIds = protectFinalAssistantTextResponse(branch, scopedEntryIds);
  for (const id of options.extraProtectedEntryIds ?? []) protectedEntryIds.add(id);
  const items = collectContextItems(branch, scopedEntryIds, protectedEntryIds);
  const promptItems = options.promptScope === "scoped" ? items.filter((item) => item.scoped) : items;
  const activeContextEntries = items.map((item) => item.entry);
  const contextTokensBefore = estimateContextItemsTokens(items, model as AnyRecord);
  const candidates = items.filter((item) => item.removable && item.number !== undefined);
  if (candidates.length === 0) {
    lastStats = { at: Date.now(), mode, status: "skipped", candidates: 0, selected: 0, deleted: 0, ignored: 0, contextTokensBefore, ...contextUsageBefore };
    return mode === "manual" || options.showStatusMessage ? lastStats : undefined;
  }

  if (!preflightAllowsRun(candidates, model as AnyRecord, mode)) {
    const candidateTokens = estimateContextItemsTokens(candidates, model as AnyRecord);
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
      tokensSaved: candidateTokens,
      contextPercentSaved: contextTokensBefore > 0 ? (candidateTokens / contextTokensBefore) * 100 : 0,
      error: "not enough removable material yet; carrying this range forward",
    };
    if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, footerStatusText());
    return undefined;
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
        systemPrompt: pruneSystemPrompt(options.promptMode),
        messages: buildPruneMessages(promptItems, { upcomingRequest: options.upcomingRequest, promptMode: options.promptMode }),
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: RESPONSE_MAX_TOKENS,
        sessionId: manager.getSessionId?.(),
        cacheRetention: "none",
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
    const pruneTokens = usageTotalTokens(response.usage as AnyRecord | undefined);
    const pruneCost = response.usage?.cost?.total || 0;

    // Golden-rule gate: the cached-prefix analysis is already paid, so applying a
    // deletion is now a marginal choice. Take only the deletions whose one-off
    // recache is repaid by ongoing context savings within the cache's remaining
    // life; selectProfitableDeletions picks the most profitable invalidation point.
    const horizonCalls = estimateForwardHorizon(ctx, branch, contextTokensBefore);
    const entries = (manager.getEntries?.() ?? []) as SessionEntry[];
    const selection = selectProfitableDeletions(activeContextEntries, selectedIds, model as AnyRecord, horizonCalls);
    let appliedSelectedIds = selection.appliedIds;
    let declinedForCost = selection.declined;

    // Applying re-expands tool dependencies, which can drag an earlier entry back
    // into the tail; re-check the realized economics and back the model-deletions
    // out entirely if they no longer pay back. Housekeeping (already out of model
    // context) is always swept regardless.
    if (appliedSelectedIds.size > 0) {
      const projected = projectHardDelete(entries, new Set([...appliedSelectedIds, ...housekeepingIds]), housekeepingIds, activeContextEntries, model as AnyRecord);
      if (pruneNetValue(projected.cacheImpact, model as AnyRecord, horizonCalls) <= 0) {
        declinedForCost = selectedIds.size;
        appliedSelectedIds = new Set();
      }
    }

    const rewriteIds = new Set([...appliedSelectedIds, ...housekeepingIds]);
    const deleted = applyHardDelete(ctx, rewriteIds, housekeepingIds, activeContextEntries, model as AnyRecord);
    // The editor has now judged every candidate shown to it — record them so no
    // later pass re-offers a survivor. Protected entries (fresh turn, final answer,
    // user messages) were never candidates and stay eligible for a future pass.
    for (const item of candidates) consideredEntryIds.add(item.entry.id);
    const { recacheCost, savingPerCallCost, breakEvenCalls } = recacheEconomics(
      deleted.tokensSaved,
      deleted.estimatedRecacheTokens,
      model as AnyRecord,
    );
    const contextPercentSaved = contextTokensBefore > 0 ? (deleted.tokensSaved / contextTokensBefore) * 100 : 0;
    lastStats = {
      at: Date.now(),
      mode,
      status: deleted.counted > 0 ? "applied" : declinedForCost > 0 ? "skipped" : "noop",
      candidates: candidates.length,
      selected: selectedIds.size,
      deleted: deleted.counted,
      ignored,
      contextTokensBefore,
      ...contextUsageBefore,
      tokensSaved: deleted.tokensSaved,
      estimatedRecacheTokens: deleted.estimatedRecacheTokens,
      contextPercentSaved,
      cacheImpact: deleted.cacheImpact,
      recacheCost,
      savingPerCallCost,
      breakEvenCalls,
      horizonCalls,
      declinedForCost: declinedForCost || undefined,
      pruneTokens,
      pruneCost,
      deletedItems: deleted.deletedItems,
      error:
        deleted.counted === 0 && declinedForCost > 0
          ? `recache outweighs savings within the ~${horizonCalls}-call horizon; ${declinedForCost} deletion${declinedForCost === 1 ? "" : "s"} declined`
          : undefined,
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
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = messages[index] as AnyRecord;
    if (candidate?.role !== "assistant") continue;
    if (candidate.stopReason === "error" || candidate.stopReason === "aborted" || candidate.stopReason === "length") {
      return candidate.errorMessage ? `${candidate.stopReason}: ${candidate.errorMessage}` : String(candidate.stopReason);
    }
    return undefined;
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
    `Live pruning: ${liveEnabled ? "on" : "off"}`,
    `Show removed text: ${showDeletedItems ? "on" : "off"}`,
    `Settings file: ${SETTINGS_FILE}`,
  ];
  if (settingsLoadError) settingsLines.push(`Settings warning: ${settingsLoadError}; pi-memedit failed closed.`);
  if (!lastStats) return [...settingsLines, "pi-memedit has not run in this session."].join("\n");
  const lines = [
    ...settingsLines,
    `Last run: ${new Date(lastStats.at).toLocaleString()}`,
    `Mode: ${lastStats.mode}`,
    `Status: ${lastStats.status}`,
    `Candidates: ${lastStats.candidates}`,
    `Selected: ${lastStats.selected}`,
    `Deleted entries: ${lastStats.deleted}`,
    `Ignored item numbers: ${lastStats.ignored}`,
    `Last estimated context reduction: ${formatPercent(lastStats.contextPercentSaved)} (${formatTokens(lastStats.tokensSaved)} deleted / ${formatTokens(lastStats.contextTokensBefore)} active)`,
    `Last cache impact: invalidated ${formatTokens(lastStats.cacheImpact?.invalidatedTailTokens)} tail tokens; dropped ${formatTokens(lastStats.cacheImpact?.droppedTailTokens)}; rewrote ${formatTokens(lastStats.cacheImpact?.keptTailTokens)} (${formatCost(lastStats.recacheCost)})`,
    `Last savings: ${formatCost(lastStats.savingPerCallCost)}/API call; prune pass ${formatTokens(lastStats.pruneTokens)} tokens, ${formatCost(lastStats.pruneCost)} — ${breakEvenText(lastStats)}`,
    `Cumulative context pruned: ${formatPercent(cumulativeContextPercent())} (${formatTokens(telemetry.tokensSaved)} deleted / ${formatTokens(telemetry.contextTokensBefore)} active considered)`,
    `Cumulative cache calculus: ${formatCost(telemetry.recacheCost)} one-off recache vs ${formatCost(telemetry.savingPerCallCost)}/API call saved${cumulativeBreakEvenCalls() === undefined ? "" : ` — break-even after ${cumulativeBreakEvenCalls()} API call${cumulativeBreakEvenCalls() === 1 ? "" : "s"}`}`,
    `Cumulative prune-pass overhead: ${formatTokens(telemetry.pruneTokens)} tokens, ${formatCost(telemetry.pruneCost)}`,
    `Realized saving so far: ${formatCost(realizedSavingsCost)} over ${realizedSavingsCalls} API call${realizedSavingsCalls === 1 ? "" : "s"} (${formatCost(telemetry.savingPerCallCost)}/call active)`,
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
  pi.registerMessageRenderer<MemeditStats>(STATUS_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const stats = message.details;
    if (!stats || typeof stats !== "object" || typeof (stats as MemeditStats).status !== "string") return undefined;
    return renderStatusMessage(stats as MemeditStats, expanded === true, theme);
  });

  installAgentSessionPatch();

  pi.on("session_start", async (_event, ctx) => {
    sessionLogIsAuthoritative = false;
    // Freeze whatever already exists: a fresh start has ~nothing, a resume or
    // restart has the whole prior conversation. Either way it becomes context only
    // — this session prunes only the content it generates.
    const branch = ((ctx.sessionManager as AnyRecord).getBranch?.() ?? []) as SessionEntry[];
    consideredEntryIds = new Set(branch.map((entry) => entry.id));
    lastLivePruneTurnIndex = -1;
    skipNextAutoPrune = false;
    if (ctx.hasUI) {
      ctx.ui.setStatus(SYSTEM_STATUS_KEY, footerStatusText());
      if (settingsLoadError) ctx.ui.notify(`pi-memedit failed closed: ${settingsLoadError}`, "warning");
    }
  });

  pi.on("context", async (event, ctx) => {
    if (sessionLogIsAuthoritative) {
      const messages = currentSessionMessages(ctx);
      if (messages) return { messages: messages as never };
    }
    const filtered = event.messages.filter((message: AnyRecord) => !isStatusAgentMessage(message));
    if (filtered.length !== event.messages.length) return { messages: filtered as never };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // A run that ended uncleanly left its entries unjudged; skip one pass so they
    // aren't pruned on the strength of an aborted transcript. They stay candidates,
    // so a later pass picks them up once the session is healthy again.
    if (skipNextAutoPrune) {
      skipNextAutoPrune = false;
      return;
    }
    // Candidates accumulate until there is enough to be worth a pass; an empty or
    // below-threshold scope simply returns without judging anything, so nothing is
    // lost by attempting on every turn.
    const stats = await runMemedit(ctx, "auto", {
      upcomingRequest: event.prompt,
      promptMode: "next-request",
    });
    if (stats) return { message: statusMessage(stats) };
  });

  pi.on("agent_start", async () => {
    lastLivePruneTurnIndex = -1;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!enabled || !liveEnabled || running) return;
    // Live pruning only makes sense between a tool-using assistant turn and the
    // continuation that consumes those tool results. If the assistant has just
    // given a final answer, pruning here happens after the user-visible finish
    // line and feels like pointless post-response churn.
    const assistantMessage = event.message as AnyRecord;
    const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
    const hasToolCalls = Array.isArray(assistantMessage?.content)
      ? assistantMessage.content.some((part: AnyRecord) => part?.type === "toolCall")
      : false;
    if (toolResults.length === 0 && assistantMessage?.stopReason !== "toolUse" && !hasToolCalls) return;
    if (event.turnIndex < LIVE_MIN_TURN_INDEX) return;
    if (lastLivePruneTurnIndex >= 0 && event.turnIndex - lastLivePruneTurnIndex < 2) return;

    const branch = ((ctx.sessionManager as AnyRecord).getBranch?.() ?? []) as SessionEntry[];
    // Keep the freshest turn — this assistant message and its tool results — which
    // the continuation will consume. Derived from the branch, never a stored
    // boundary, so it cannot drift or go stale.
    const freshTurnEntryIds = currentTurnEntryIds(branch);
    const stats = await runMemedit(ctx, "live", {
      promptMode: "continuation",
      promptScope: "scoped",
      extraProtectedEntryIds: freshTurnEntryIds,
    });
    if (stats?.status === "applied") {
      lastLivePruneTurnIndex = event.turnIndex;
      if (ctx.hasUI) ctx.ui.notify(`pi-memedit live pruned ${formatTokens(stats.tokensSaved)}; ${breakEvenText(stats)}`, "info");
    }
  });

  // Every provider request after a prune omits the deleted tokens, so the
  // ongoing cache-read saving is realized one API call at a time. Tick it up
  // live instead of waiting for the next prune or the end of the run.
  pi.on("before_provider_request", async (_event, ctx) => {
    if (!enabled) return;
    if (running) return; // the prune's own LLM call is overhead, not a saving
    if (telemetry.savingPerCallCost <= 0) return;
    realizedSavingsCost += telemetry.savingPerCallCost;
    realizedSavingsCalls += 1;
    if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, footerStatusText());
  });

  pi.on("agent_end", async (event, ctx) => {
    const unsuccessfulReason = unsuccessfulRunReason(event.messages);
    if (unsuccessfulReason) {
      skipNextAutoPrune = true;
      lastStats = skippedStats(`agent run did not complete cleanly (${unsuccessfulReason})`);
      if (ctx.hasUI) ctx.ui.setStatus(SYSTEM_STATUS_KEY, enabled ? "memedit:skipped" : "memedit:off");
      return;
    }
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
      const liveMatch = command.match(/^live\s+(on|off|enable|disable)$/);
      if (liveMatch) {
        const next = liveMatch[1] === "on" || liveMatch[1] === "enable";
        setLiveEnabled(next);
        if (ctx.hasUI) {
          ctx.ui.setStatus(SYSTEM_STATUS_KEY, footerStatusText());
          ctx.ui.notify(`pi-memedit live pruning ${next ? "enabled" : "disabled"} and persisted to ${SETTINGS_FILE}`, "info");
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
        await runMemedit(ctx, "manual", { promptMode: "manual" });
        if (ctx.hasUI) ctx.ui.notify(formatStats(), "info");
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `${formatStats()}\n\nCommands: /memedit status | run | on | off | live on | live off | show-deleted on | show-deleted off`,
          "info",
        );
      }
    },
  });
}
