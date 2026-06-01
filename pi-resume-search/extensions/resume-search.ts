import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyMatch,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type KeyId,
} from "@earendil-works/pi-tui";

type Theme = ExtensionCommandContext["ui"]["theme"];
type Scope = "current" | "all";
type SortMode = "threaded" | "recent" | "relevance";
type NameFilter = "all" | "named";

type QueryToken = { kind: "fuzzy" | "phrase"; value: string };
type ParsedQuery =
  | { mode: "empty"; tokens: []; regex: null; error?: undefined }
  | { mode: "regex"; tokens: []; regex: RegExp | null; error?: string }
  | { mode: "tokens"; tokens: QueryToken[]; regex: null; error?: undefined };

type SessionPiece = {
  label: string;
  text: string;
  entryId?: string;
  timestampMs?: number;
};

type SessionDocument = {
  fullText: string;
  pieces: SessionPiece[];
};

type SessionNode = {
  session: SessionInfo;
  score: number;
  depth: number;
  isLast: boolean;
  ancestorContinues: boolean[];
};

type MatchRange = { index: number; length: number };
type MatchSnippet = {
  piece: SessionPiece;
  range?: MatchRange;
};

type StatusMessage = { type: "info" | "error"; message: string } | null;
type KeybindingsLike = {
  matches?: (data: string, keybinding: string) => boolean;
  getKeys?: (keybinding: string) => KeyId[];
};

type ResumeSearchOptions = {
  currentLoader: () => Promise<SessionInfo[]>;
  allLoader: () => Promise<SessionInfo[]>;
  currentSessionPath?: string;
  initialQuery?: string;
  theme: Theme;
  keybindings: KeybindingsLike;
  requestRender: () => void;
  done: (sessionPath: string | null) => void;
};

const DOCUMENT_CACHE = new Map<string, { modifiedMs: number; document: SessionDocument }>();
const MAX_DOCUMENT_CACHE_ENTRIES = 200;
const MAX_SNIPPETS_PER_SESSION = 2;
const SEARCH_RECOMPUTE_DEBOUNCE_MS = 90;
const MAX_REGEX_PATTERN_LENGTH = 160;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function normalizeDisplayText(value: string): string {
  return stripAnsi(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSnippetText(value: string): string {
  return stripAnsi(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").replace(/\s+/g, " ");
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function shortenPath(value: string | undefined): string {
  if (!value) return "";
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function canonicalPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return resolve(value).replace(/\\/g, "/");
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  const left = canonicalPath(a);
  const right = canonicalPath(b);
  return !!left && !!right && left === right;
}

function formatAge(date: Date): string {
  const now = Date.now();
  const diffMs = Math.max(0, now - date.getTime());
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function formatTimestamp(timestampMs: number | undefined, fallback: Date): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return formatAge(fallback);
  return formatAge(new Date(timestampMs));
}

function keyMatches(keybindings: KeybindingsLike, data: string, keybinding: string, fallbackKeys: readonly KeyId[] = []): boolean {
  try {
    if (keybindings.matches?.(data, keybinding)) return true;
  } catch {
    // Some injected keybinding managers are narrowly typed. Fall through to raw-key fallback.
  }
  return fallbackKeys.some((key) => matchesKey(data, key));
}

function keyLabel(keybindings: KeybindingsLike, keybinding: string, fallback: string): string {
  try {
    const keys = keybindings.getKeys?.(keybinding);
    if (keys?.length) return keys[0] ?? fallback;
  } catch {
    // Keep rendering even when an older manager does not know this binding.
  }
  return fallback;
}

function keyHintText(theme: Theme, keybindings: KeybindingsLike, keybinding: string, description: string, fallback: string): string {
  return `${theme.fg("accent", keyLabel(keybindings, keybinding, fallback))} ${theme.fg("muted", description)}`;
}

function regexSafetyError(pattern: string): string | undefined {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return `Regex too long (max ${MAX_REGEX_PATTERN_LENGTH} characters)`;

  let escaped = false;
  let groups = 0;
  for (let index = 0; index < pattern.length; index++) {
    const ch = pattern[index];
    if (escaped) {
      if (/^[1-9]$/.test(ch)) return "Backreferences are not supported in interactive search";
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "(") groups++;
  }
  if (groups > 12) return "Regex has too many groups for interactive search";

  // Reject common catastrophic-backtracking shapes such as `(a+)+`, `(.*)*`, or `(foo){1,}`.
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(pattern)) {
    return "Nested regex quantifiers are not supported in interactive search";
  }

  return undefined;
}

function parseSearchQuery(query: string): ParsedQuery {
  const trimmed = query.trim();
  if (!trimmed) return { mode: "empty", tokens: [], regex: null };

  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    const safetyError = regexSafetyError(pattern);
    if (safetyError) return { mode: "regex", tokens: [], regex: null, error: safetyError };
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (err) {
      return {
        mode: "regex",
        tokens: [],
        regex: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const tokens: QueryToken[] = [];
  let buffer = "";
  let inQuote = false;
  const flush = (kind: QueryToken["kind"]) => {
    const value = buffer.trim();
    buffer = "";
    if (value) tokens.push({ kind, value });
  };

  for (const ch of trimmed) {
    if (ch === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      flush("fuzzy");
      continue;
    }
    buffer += ch;
  }

  // Treat an unfinished quoted phrase as a normal fuzzy token without keeping the raw quote.
  flush("fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseRegex(value: string): RegExp | null {
  const parts = value.trim().split(/\s+/).filter(Boolean).map(escapeRegex);
  if (parts.length === 0) return null;
  return new RegExp(parts.join("\\s+"), "i");
}

function matchText(text: string, parsed: ParsedQuery): { matches: boolean; score: number } {
  if (parsed.mode === "empty") return { matches: true, score: 0 };
  if (parsed.mode === "regex") {
    if (!parsed.regex) return { matches: false, score: 0 };
    const match = text.match(parsed.regex);
    if (!match || match.index === undefined) return { matches: false, score: 0 };
    return { matches: true, score: match.index * 0.1 };
  }

  let score = 0;
  let normalized: string | undefined;
  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      normalized ??= normalizeSearchText(text);
      const phrase = normalizeSearchText(token.value);
      const idx = normalized.indexOf(phrase);
      if (idx < 0) return { matches: false, score: 0 };
      score += idx * 0.1;
      continue;
    }

    const directIdx = text.toLowerCase().indexOf(token.value.toLowerCase());
    if (directIdx >= 0) {
      score += directIdx * 0.1;
      continue;
    }

    const fuzzy = fuzzyMatch(token.value, text);
    if (!fuzzy.matches) return { matches: false, score: 0 };
    score += fuzzy.score;
  }

  return { matches: true, score };
}

function findDirectRange(text: string, parsed: ParsedQuery): MatchRange | undefined {
  if (parsed.mode === "empty") return undefined;
  if (parsed.mode === "regex") {
    if (!parsed.regex) return undefined;
    const match = text.match(parsed.regex);
    if (!match || match.index === undefined) return undefined;
    return { index: match.index, length: match[0]?.length ?? 0 };
  }

  let best: MatchRange | undefined;
  const consider = (range: MatchRange | undefined) => {
    if (!range || range.length <= 0) return;
    if (!best || range.index < best.index) best = range;
  };

  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      const re = phraseRegex(token.value);
      const match = re ? text.match(re) : null;
      if (match && match.index !== undefined) consider({ index: match.index, length: match[0]?.length ?? 0 });
      continue;
    }
    const idx = text.toLowerCase().indexOf(token.value.toLowerCase());
    if (idx >= 0) consider({ index: idx, length: token.value.length });
  }
  return best;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown; mimeType?: unknown };
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    if (item.type === "thinking" && typeof item.thinking === "string") parts.push(item.thinking);
    if (item.type === "toolCall") {
      const args = item.arguments === undefined ? "" : safeJson(item.arguments);
      parts.push(`${String(item.name ?? "tool")} ${args}`.trim());
    }
    if (item.type === "image") parts.push(`[image ${String(item.mimeType ?? "")}]`.trim());
  }
  return parts.join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function timestampFrom(entry: any): number | undefined {
  const messageTs = entry?.message?.timestamp;
  if (typeof messageTs === "number") return messageTs;
  const entryTs = entry?.timestamp;
  if (typeof entryTs === "string") {
    const parsed = new Date(entryTs).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function addPiece(pieces: SessionPiece[], label: string, text: string, entry: any): void {
  const normalized = normalizeDisplayText(text);
  if (!normalized) return;
  pieces.push({ label, text: normalized, entryId: typeof entry?.id === "string" ? entry.id : undefined, timestampMs: timestampFrom(entry) });
}

function documentFromEntries(session: SessionInfo, entries: any[]): SessionDocument {
  const pieces: SessionPiece[] = [];
  if (session.name) {
    pieces.push({ label: "name", text: session.name, timestampMs: session.modified.getTime() });
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "message") {
      const message = entry.message;
      const role = typeof message?.role === "string" ? message.role : "message";
      if (role === "toolResult") {
        addPiece(pieces, `tool:${String(message?.toolName ?? "result")}`, contentToText(message?.content), entry);
        continue;
      }
      if (role === "bashExecution") {
        addPiece(pieces, "bash", [`$ ${String(message?.command ?? "")}`, String(message?.output ?? "")].join("\n"), entry);
        continue;
      }
      addPiece(pieces, role, contentToText(message?.content), entry);
      continue;
    }
    if (entry.type === "custom_message") {
      addPiece(pieces, `custom:${String(entry.customType ?? "message")}`, contentToText(entry.content), entry);
      continue;
    }
    if (entry.type === "compaction") {
      addPiece(pieces, "compaction", String(entry.summary ?? ""), entry);
      continue;
    }
    if (entry.type === "branch_summary") {
      addPiece(pieces, "branch", String(entry.summary ?? ""), entry);
      continue;
    }
    if (entry.type === "session_info") {
      addPiece(pieces, "name", String(entry.name ?? ""), entry);
      continue;
    }
  }

  const fullText = pieces.map((piece) => `${piece.label}: ${piece.text}`).join("\n");
  return { fullText, pieces };
}

function getCachedSessionDocument(session: SessionInfo): SessionDocument | undefined {
  const modifiedMs = session.modified.getTime();
  const cached = DOCUMENT_CACHE.get(session.path);
  if (!cached) return undefined;
  if (cached.modifiedMs !== modifiedMs) {
    DOCUMENT_CACHE.delete(session.path);
    return undefined;
  }

  // Refresh insertion order so the map behaves like a small LRU cache.
  DOCUMENT_CACHE.delete(session.path);
  DOCUMENT_CACHE.set(session.path, cached);
  return cached.document;
}

function rememberSessionDocument(path: string, modifiedMs: number, document: SessionDocument): void {
  DOCUMENT_CACHE.delete(path);
  DOCUMENT_CACHE.set(path, { modifiedMs, document });
  while (DOCUMENT_CACHE.size > MAX_DOCUMENT_CACHE_ENTRIES) {
    const oldest = DOCUMENT_CACHE.keys().next().value;
    if (typeof oldest !== "string") break;
    DOCUMENT_CACHE.delete(oldest);
  }
}

function getSessionDocument(session: SessionInfo): SessionDocument {
  const modifiedMs = session.modified.getTime();
  const cached = getCachedSessionDocument(session);
  if (cached) return cached;

  try {
    const content = readFileSync(session.path, "utf8");
    const entries = content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const document = documentFromEntries(session, entries);
    rememberSessionDocument(session.path, modifiedMs, document);
    return document;
  } catch {
    const fallbackText = normalizeDisplayText(`${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText}`);
    const document = {
      fullText: fallbackText,
      pieces: [{ label: "session", text: fallbackText, timestampMs: modifiedMs }],
    } satisfies SessionDocument;
    rememberSessionDocument(session.path, modifiedMs, document);
    return document;
  }
}

function quickSessionSearchText(session: SessionInfo): string {
  return [session.id, session.name ?? "", session.cwd, session.path, session.firstMessage, session.allMessagesText].join("\n");
}

function fullSessionSearchText(session: SessionInfo): string {
  const document = getSessionDocument(session);
  return [session.id, session.name ?? "", session.cwd, session.path, document.fullText].join("\n");
}

function hasSessionName(session: SessionInfo): boolean {
  return Boolean(session.name?.trim());
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
  return filter === "all" || hasSessionName(session);
}

function buildTree(sessions: SessionInfo[]): SessionNode[] {
  const byPath = new Map<string, { session: SessionInfo; children: Array<{ session: SessionInfo; children: any[] }> }>();
  for (const session of sessions) {
    byPath.set(canonicalPath(session.path) ?? session.path, { session, children: [] });
  }

  const roots: Array<{ session: SessionInfo; children: any[] }> = [];
  for (const session of sessions) {
    const key = canonicalPath(session.path) ?? session.path;
    const node = byPath.get(key);
    if (!node) continue;
    const parent = canonicalPath(session.parentSessionPath);
    if (parent && byPath.has(parent)) {
      byPath.get(parent)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (nodes: Array<{ session: SessionInfo; children: any[] }>) => {
    nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);

  const out: SessionNode[] = [];
  const walk = (node: { session: SessionInfo; children: any[] }, depth: number, ancestorContinues: boolean[], isLast: boolean) => {
    out.push({ session: node.session, score: 0, depth, isLast, ancestorContinues });
    node.children.forEach((child, index) => {
      const childIsLast = index === node.children.length - 1;
      const continues = depth > 0 ? !isLast : false;
      walk(child, depth + 1, [...ancestorContinues, continues], childIsLast);
    });
  };
  roots.forEach((root, index) => walk(root, 0, [], index === roots.length - 1));
  return out;
}

function filterSessions(sessions: SessionInfo[], query: string, sortMode: SortMode, nameFilter: NameFilter): { nodes: SessionNode[]; error?: string } {
  const named = sessions.filter((session) => matchesNameFilter(session, nameFilter));
  const parsed = parseSearchQuery(query);
  if (parsed.error) return { nodes: [], error: parsed.error };

  if (parsed.mode === "empty") {
    if (sortMode === "threaded") return { nodes: buildTree(named) };
    return {
      nodes: named.map((session) => ({ session, score: 0, depth: 0, isLast: true, ancestorContinues: [] })),
    };
  }

  const scored: SessionNode[] = [];
  for (const session of named) {
    let result = matchText(quickSessionSearchText(session), parsed);
    if (!result.matches) result = matchText(fullSessionSearchText(session), parsed);
    if (!result.matches) continue;
    scored.push({ session, score: result.score, depth: 0, isLast: true, ancestorContinues: [] });
  }

  if (sortMode !== "recent") {
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return b.session.modified.getTime() - a.session.modified.getTime();
    });
  }

  return { nodes: scored };
}

function snippetMatches(piece: SessionPiece, parsed: ParsedQuery): boolean {
  if (parsed.mode === "empty") return false;
  const direct = findDirectRange(piece.text, parsed);
  if (direct) return true;
  return matchText(piece.text, parsed).matches;
}

function snippetsForSession(session: SessionInfo, parsed: ParsedQuery): MatchSnippet[] {
  if (parsed.mode === "empty" || parsed.error) return [];
  const document = getCachedSessionDocument(session);
  if (!document) return [];
  const snippets: MatchSnippet[] = [];

  for (const piece of document.pieces) {
    if (!snippetMatches(piece, parsed)) continue;
    snippets.push({ piece, range: findDirectRange(piece.text, parsed) });
    if (snippets.length >= MAX_SNIPPETS_PER_SESSION) return snippets;
  }

  // If a session matched only because terms were spread across entries, show the first entries containing any direct term.
  if (snippets.length === 0 && parsed.mode === "tokens") {
    for (const piece of document.pieces) {
      const range = findDirectRange(piece.text, { mode: "tokens", tokens: parsed.tokens.slice(0, 1), regex: null });
      if (!range) continue;
      snippets.push({ piece, range });
      if (snippets.length >= MAX_SNIPPETS_PER_SESSION) return snippets;
    }
  }

  return snippets;
}

function makeExcerpt(text: string, range: MatchRange | undefined, theme: Theme, maxTextWidth: number): string {
  if (!range) return truncateToWidth(normalizeDisplayText(text), maxTextWidth, "…");

  const radius = 54;
  const start = Math.max(0, range.index - radius);
  const end = Math.min(text.length, range.index + range.length + radius);
  const before = normalizeSnippetText(text.slice(start, range.index));
  const match = normalizeSnippetText(text.slice(range.index, range.index + range.length));
  const after = normalizeSnippetText(text.slice(range.index + range.length, end));
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return truncateToWidth(`${prefix}${theme.fg("muted", before)}${theme.fg("accent", match)}${theme.fg("muted", after)}${suffix}`, maxTextWidth, "…");
}

function treePrefix(node: SessionNode): string {
  if (node.depth === 0) return "";
  const parents = node.ancestorContinues.map((continues) => (continues ? "│  " : "   ")).join("");
  return parents + (node.isLast ? "└─ " : "├─ ");
}

async function deleteSessionFile(sessionPath: string): Promise<{ ok: true; method: "trash" | "unlink" } | { ok: false; error: string }> {
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const trash = spawnSync("trash", trashArgs, { encoding: "utf8" });
  if (trash.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };

  try {
    await unlink(sessionPath);
    return { ok: true, method: "unlink" };
  } catch (err) {
    const unlinkError = err instanceof Error ? err.message : String(err);
    const trashError = [trash.error?.message, trash.stderr?.trim().split("\n")[0]].filter(Boolean).join(" · ");
    return { ok: false, error: trashError ? `${unlinkError} (${trashError})` : unlinkError };
  }
}

class ResumeSearchSelector implements Component, Focusable {
  private input = new Input();
  private renameInput = new Input();
  private scope: Scope = "current";
  private sortMode: SortMode = "threaded";
  private nameFilter: NameFilter = "all";
  private showPath = false;
  private currentSessions: SessionInfo[] | null = null;
  private allSessions: SessionInfo[] | null = null;
  private nodes: SessionNode[] = [];
  private selectedIndex = 0;
  private currentLoading = false;
  private allLoading = false;
  private statusMessage: StatusMessage = null;
  private confirmingDeletePath: string | null = null;
  private mode: "list" | "rename" = "list";
  private renameTargetPath: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null;
  private _focused = false;

  constructor(private readonly options: ResumeSearchOptions) {
    this.input.setValue(options.initialQuery?.trim() ?? "");
    this.input.onSubmit = () => this.selectCurrent();
    this.renameInput.onSubmit = (value) => void this.confirmRename(value);
    void this.loadScope("current");
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.mode === "list";
    this.renameInput.focused = value && this.mode === "rename";
  }

  invalidate(): void {
    this.input.invalidate();
    this.renameInput.invalidate();
  }

  handleInput(data: string): void {
    if (this.mode === "rename") {
      if (keyMatches(this.options.keybindings, data, "tui.select.cancel", ["escape", "ctrl+c"])) {
        this.exitRenameMode();
        return;
      }
      this.renameInput.handleInput(data);
      this.options.requestRender();
      return;
    }

    if (this.confirmingDeletePath) {
      if (keyMatches(this.options.keybindings, data, "tui.select.confirm", ["enter", "return"])) {
        const path = this.confirmingDeletePath;
        this.confirmingDeletePath = null;
        void this.deleteSession(path);
        return;
      }
      if (keyMatches(this.options.keybindings, data, "tui.select.cancel", ["escape", "ctrl+c"])) {
        this.confirmingDeletePath = null;
        this.options.requestRender();
      }
      return;
    }

    if (keyMatches(this.options.keybindings, data, "tui.input.tab", ["tab"])) {
      this.toggleScope();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "app.session.toggleSort", ["ctrl+s"])) {
      this.toggleSort();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "app.session.toggleNamedFilter", ["ctrl+n"])) {
      this.nameFilter = this.nameFilter === "all" ? "named" : "all";
      this.recompute();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "app.session.togglePath", ["ctrl+p"])) {
      this.showPath = !this.showPath;
      this.options.requestRender();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "app.session.rename", ["ctrl+r"])) {
      this.enterRenameModeForSelected();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "app.session.delete", ["ctrl+d"])) {
      this.startDeleteConfirmation();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "app.session.deleteNoninvasive", ["ctrl+backspace"])) {
      if (this.input.getValue().length > 0) {
        this.handleSearchInput(data);
      } else {
        this.startDeleteConfirmation();
      }
      return;
    }
    if (keyMatches(this.options.keybindings, data, "tui.select.up", ["up"])) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.options.requestRender();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "tui.select.down", ["down"])) {
      this.selectedIndex = Math.min(Math.max(0, this.nodes.length - 1), this.selectedIndex + 1);
      this.options.requestRender();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "tui.select.pageUp", ["pageUp"])) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleSessions());
      this.options.requestRender();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "tui.select.pageDown", ["pageDown"])) {
      this.selectedIndex = Math.min(Math.max(0, this.nodes.length - 1), this.selectedIndex + this.maxVisibleSessions());
      this.options.requestRender();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "tui.select.confirm", ["enter", "return"])) {
      this.selectCurrent();
      return;
    }
    if (keyMatches(this.options.keybindings, data, "tui.select.cancel", ["escape", "ctrl+c"])) {
      this.clearStatusTimer();
      this.clearRecomputeTimer();
      this.options.done(null);
      return;
    }

    this.handleSearchInput(data);
  }

  render(width: number): string[] {
    if (this.mode === "rename") return this.renderRename(width);

    const lines: string[] = [];
    lines.push("");
    lines.push(this.border(width));
    lines.push("");
    lines.push(...this.renderHeader(width));
    lines.push("");
    lines.push(...this.input.render(width));
    lines.push("");

    if (this.isLoading()) {
      lines.push(this.options.theme.fg("muted", truncateToWidth("  Loading sessions…", width, "…")));
    } else if (this.nodes.length === 0) {
      lines.push(this.options.theme.fg("muted", truncateToWidth(this.emptyMessage(), width, "…")));
    } else {
      lines.push(...this.renderSessionRows(width));
    }

    lines.push("");
    lines.push(this.border(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderHeader(width: number): string[] {
    const theme = this.options.theme;
    const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
    const leftText = theme.bold(title);
    const scopeText =
      this.scope === "current"
        ? `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`
        : `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
    const nameText = `${theme.fg("muted", "Name: ")}${theme.fg("accent", this.nameFilter === "all" ? "All" : "Named")}`;
    const sortText = `${theme.fg("muted", "Sort: ")}${theme.fg("accent", this.sortLabel())}`;
    const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
    const leftWidth = Math.max(0, width - visibleWidth(rightText) - 1);
    const left = truncateToWidth(leftText, leftWidth, "");
    const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

    let hint1: string;
    let hint2: string;
    const query = this.input.getValue().trim();
    const parsed = parseSearchQuery(query);
    if (this.confirmingDeletePath) {
      const confirm = keyHintText(theme, this.options.keybindings, "tui.select.confirm", "confirm", "enter");
      const cancel = keyHintText(theme, this.options.keybindings, "tui.select.cancel", "cancel", "escape");
      hint1 = theme.fg("error", truncateToWidth(`Delete session? ${confirm} · ${cancel}`, width, "…"));
      hint2 = "";
    } else if (parsed.error) {
      hint1 = theme.fg("error", truncateToWidth(`Invalid regex: ${parsed.error}`, width, "…"));
      hint2 = "";
    } else if (this.statusMessage) {
      hint1 = theme.fg(this.statusMessage.type === "error" ? "error" : "accent", truncateToWidth(this.statusMessage.message, width, "…"));
      hint2 = "";
    } else {
      const sep = theme.fg("muted", " · ");
      const pathState = this.showPath ? "(on)" : "(off)";
      hint1 = truncateToWidth(`${keyHintText(theme, this.options.keybindings, "tui.input.tab", "scope", "tab")}${sep}${theme.fg("muted", 're:<pattern> regex · "phrase" exact · full-session text')}`, width, "…");
      hint2 = truncateToWidth(
        [
          keyHintText(theme, this.options.keybindings, "app.session.toggleSort", "sort", "ctrl+s"),
          keyHintText(theme, this.options.keybindings, "app.session.toggleNamedFilter", "named", "ctrl+n"),
          keyHintText(theme, this.options.keybindings, "app.session.delete", "delete", "ctrl+d"),
          keyHintText(theme, this.options.keybindings, "app.session.togglePath", `path ${pathState}`, "ctrl+p"),
          keyHintText(theme, this.options.keybindings, "app.session.rename", "rename", "ctrl+r"),
        ].join(sep),
        width,
        "…",
      );
    }

    return [`${left}${" ".repeat(spacing)}${rightText}`, hint1, hint2];
  }

  private renderSessionRows(width: number): string[] {
    const lines: string[] = [];
    const maxVisible = this.maxVisibleSessions();
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.nodes.length - maxVisible));
    const end = Math.min(start + maxVisible, this.nodes.length);
    const parsed = parseSearchQuery(this.input.getValue());
    const showSnippets = parsed.mode !== "empty" && !parsed.error;

    for (let index = start; index < end; index++) {
      const node = this.nodes[index];
      lines.push(this.renderSessionLine(node, index === this.selectedIndex, width));
      if (showSnippets) {
        const snippets = snippetsForSession(node.session, parsed);
        const limit = index === this.selectedIndex ? MAX_SNIPPETS_PER_SESSION : 1;
        for (const snippet of snippets.slice(0, limit)) {
          lines.push(this.renderSnippetLine(node.session, snippet, width));
        }
      }
    }

    if (start > 0 || end < this.nodes.length) {
      lines.push(this.options.theme.fg("muted", truncateToWidth(`  (${this.selectedIndex + 1}/${this.nodes.length})`, width, "")));
    }
    return lines;
  }

  private renderSessionLine(node: SessionNode, selected: boolean, width: number): string {
    const theme = this.options.theme;
    const session = node.session;
    const prefix = treePrefix(node);
    const hasName = hasSessionName(session);
    const displayText = normalizeDisplayText(session.name ? session.name : session.firstMessage || "(no messages)");
    const age = formatAge(session.modified);
    let right = `${session.messageCount} ${age}`;
    if (this.scope === "all" && session.cwd) right = `${shortenPath(session.cwd)} ${right}`;
    if (this.showPath) right = `${shortenPath(session.path)} ${right}`;

    const cursor = selected ? theme.fg("accent", "› ") : "  ";
    const rightWidth = visibleWidth(right) + 2;
    const available = Math.max(10, width - visibleWidth(cursor) - visibleWidth(prefix) - rightWidth);
    const title = truncateToWidth(displayText, available, "…");
    const current = samePath(session.path, this.options.currentSessionPath);
    const deleting = this.confirmingDeletePath === session.path;
    let styledTitle = title;
    if (deleting) styledTitle = theme.fg("error", styledTitle);
    else if (current) styledTitle = theme.fg("accent", styledTitle);
    else if (hasName) styledTitle = theme.fg("warning", styledTitle);
    if (selected) styledTitle = theme.bold(styledTitle);

    const left = `${cursor}${theme.fg("dim", prefix)}${styledTitle}`;
    const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    const line = `${left}${" ".repeat(spacing)}${theme.fg(deleting ? "error" : "dim", right)}`;
    const truncated = truncateToWidth(line, width, "");
    return selected ? theme.bg("selectedBg", truncated) : truncated;
  }

  private renderSnippetLine(session: SessionInfo, snippet: MatchSnippet, width: number): string {
    const theme = this.options.theme;
    const id = snippet.piece.entryId ? `#${snippet.piece.entryId}` : "";
    const where = `${snippet.piece.label}${id ? ` ${id}` : ""} ${formatTimestamp(snippet.piece.timestampMs, session.modified)}`;
    const prefix = `  ↳ ${where} · `;
    const prefixStyled = theme.fg("dim", prefix);
    const textWidth = Math.max(8, width - visibleWidth(prefix));
    return truncateToWidth(`${prefixStyled}${makeExcerpt(snippet.piece.text, snippet.range, theme, textWidth)}`, width, "…");
  }

  private renderRename(width: number): string[] {
    const theme = this.options.theme;
    const lines = [
      "",
      this.border(width),
      "",
      theme.bold("Rename Session"),
      "",
      ...this.renameInput.render(width),
      "",
      theme.fg(
        "muted",
        truncateToWidth(
          `${keyLabel(this.options.keybindings, "tui.select.confirm", "enter")} to save · ${keyLabel(this.options.keybindings, "tui.select.cancel", "escape")} to cancel`,
          width,
          "…",
        ),
      ),
      "",
      this.border(width),
    ];
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private border(width: number): string {
    return this.options.theme.fg("accent", "─".repeat(Math.max(0, width)));
  }

  private sortLabel(): string {
    if (this.sortMode === "threaded") return "Threaded";
    if (this.sortMode === "recent") return "Recent";
    return "Fuzzy";
  }

  private emptyMessage(): string {
    if (this.nameFilter === "named") return "  No named sessions matched. Press Ctrl+N to show all sessions.";
    if (this.input.getValue().trim()) return "  No sessions matched the full-session search.";
    if (this.scope === "current") return "  No sessions in current folder. Press Tab to view all.";
    return "  No sessions found.";
  }

  private isLoading(): boolean {
    return this.scope === "current" ? this.currentLoading : this.allLoading;
  }

  private maxVisibleSessions(): number {
    return this.input.getValue().trim() ? 6 : 10;
  }

  private getVisibleSessions(): SessionInfo[] {
    return this.scope === "all" ? this.allSessions ?? [] : this.currentSessions ?? [];
  }

  private recompute(): void {
    this.clearRecomputeTimer();
    const result = filterSessions(this.getVisibleSessions(), this.input.getValue(), this.sortMode, this.nameFilter);
    this.nodes = result.nodes;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.nodes.length - 1));
    this.options.requestRender();
  }

  private scheduleRecompute(): void {
    this.clearRecomputeTimer();
    this.options.requestRender();
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null;
      this.recompute();
    }, SEARCH_RECOMPUTE_DEBOUNCE_MS);
  }

  private flushRecompute(): void {
    if (!this.recomputeTimer) return;
    clearTimeout(this.recomputeTimer);
    this.recomputeTimer = null;
    this.recompute();
  }

  private clearRecomputeTimer(): void {
    if (!this.recomputeTimer) return;
    clearTimeout(this.recomputeTimer);
    this.recomputeTimer = null;
  }

  private async loadScope(scope: Scope): Promise<void> {
    if (scope === "current") this.currentLoading = true;
    else this.allLoading = true;
    this.options.requestRender();

    try {
      const sessions = await (scope === "current" ? this.options.currentLoader() : this.options.allLoader());
      if (scope === "current") this.currentSessions = sessions;
      else this.allSessions = sessions;
      if (scope === this.scope) this.recompute();
    } catch (err) {
      this.setStatus({ type: "error", message: `Failed to load sessions: ${err instanceof Error ? err.message : String(err)}` }, 4000);
    } finally {
      if (scope === "current") this.currentLoading = false;
      else this.allLoading = false;
      this.options.requestRender();
    }
  }

  private toggleScope(): void {
    this.scope = this.scope === "current" ? "all" : "current";
    if (this.scope === "all" && this.allSessions === null && !this.allLoading) void this.loadScope("all");
    this.recompute();
  }

  private toggleSort(): void {
    this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
    this.recompute();
  }

  private handleSearchInput(data: string): void {
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() === before) return;
    this.selectedIndex = 0;
    this.scheduleRecompute();
  }

  private selectCurrent(): void {
    this.flushRecompute();
    const selected = this.nodes[this.selectedIndex]?.session;
    if (!selected) return;
    this.clearStatusTimer();
    this.clearRecomputeTimer();
    this.options.done(selected.path);
  }

  private startDeleteConfirmation(): void {
    this.flushRecompute();
    const selected = this.nodes[this.selectedIndex]?.session;
    if (!selected) return;
    if (samePath(selected.path, this.options.currentSessionPath)) {
      this.setStatus({ type: "error", message: "Cannot delete the currently active session" }, 3000);
      return;
    }
    this.confirmingDeletePath = selected.path;
    this.options.requestRender();
  }

  private async deleteSession(sessionPath: string): Promise<void> {
    const result = await deleteSessionFile(sessionPath);
    if (result.ok === false) {
      this.setStatus({ type: "error", message: `Failed to delete: ${result.error}` }, 4000);
      return;
    }
    DOCUMENT_CACHE.delete(sessionPath);
    if (this.currentSessions) this.currentSessions = this.currentSessions.filter((session) => session.path !== sessionPath);
    if (this.allSessions) this.allSessions = this.allSessions.filter((session) => session.path !== sessionPath);
    this.recompute();
    this.setStatus({ type: "info", message: result.method === "trash" ? "Session moved to trash" : "Session deleted" }, 2000);
  }

  private enterRenameModeForSelected(): void {
    this.flushRecompute();
    const selected = this.nodes[this.selectedIndex]?.session;
    if (!selected) return;
    this.mode = "rename";
    this.renameTargetPath = selected.path;
    this.renameInput.setValue(selected.name ?? "");
    this.focused = this._focused;
    this.options.requestRender();
  }

  private exitRenameMode(): void {
    this.mode = "list";
    this.renameTargetPath = null;
    this.focused = this._focused;
    this.options.requestRender();
  }

  private async confirmRename(value: string): Promise<void> {
    const nextName = value.trim();
    const target = this.renameTargetPath;
    if (!target) {
      this.exitRenameMode();
      return;
    }

    try {
      const manager = SessionManager.open(target);
      manager.appendSessionInfo(nextName);
      this.updateSessionName(target, nextName || undefined);
      DOCUMENT_CACHE.delete(target);
      this.setStatus({ type: "info", message: nextName ? "Session renamed" : "Session name cleared" }, 2000);
    } catch (err) {
      this.setStatus({ type: "error", message: `Failed to rename: ${err instanceof Error ? err.message : String(err)}` }, 4000);
    } finally {
      this.exitRenameMode();
    }
  }

  private updateSessionName(path: string, nextName: string | undefined): void {
    const update = (sessions: SessionInfo[] | null) => {
      if (!sessions) return sessions;
      return sessions.map((session) => (session.path === path ? { ...session, name: nextName } : session));
    };
    this.currentSessions = update(this.currentSessions);
    this.allSessions = update(this.allSessions);
    this.recompute();
  }

  private setStatus(message: StatusMessage, autoHideMs?: number): void {
    this.clearStatusTimer();
    this.statusMessage = message;
    if (message && autoHideMs) {
      this.statusTimer = setTimeout(() => {
        this.statusMessage = null;
        this.statusTimer = null;
        this.options.requestRender();
      }, autoHideMs);
    }
    this.options.requestRender();
  }

  private clearStatusTimer(): void {
    if (!this.statusTimer) return;
    clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }
}

async function openResumeSearch(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/resume-search requires interactive UI", "warning");
    return;
  }

  await ctx.waitForIdle();
  const sessionDir = ctx.sessionManager.getSessionDir();
  const currentSessionPath = ctx.sessionManager.getSessionFile();
  const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & { usesDefaultSessionDir?: () => boolean };
  const allSessionsLoader = () =>
    (sessionManager.usesDefaultSessionDir?.() ?? true) ? SessionManager.listAll() : SessionManager.listAll(sessionDir);

  const selected = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    return new ResumeSearchSelector({
      currentLoader: () => SessionManager.list(ctx.cwd, sessionDir),
      allLoader: allSessionsLoader,
      currentSessionPath,
      initialQuery: args,
      theme,
      keybindings: keybindings as KeybindingsLike,
      requestRender: () => tui.requestRender(),
      done,
    });
  });

  if (!selected) return;
  await ctx.switchSession(selected, {
    withSession: async (nextCtx) => {
      nextCtx.ui.notify("Resumed session", "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("resume-search", {
    description: "Resume a session with full-session text search and match snippets",
    handler: openResumeSearch,
  });

  pi.registerCommand("rs", {
    description: "Alias for /resume-search",
    handler: openResumeSearch,
  });
}
