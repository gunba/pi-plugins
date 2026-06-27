import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_TEXT_LENGTH = 300_000;
const MAX_CANDIDATE_LENGTH = 500;
const PATH_BOUNDARY = /[\s,;!?)}\]>"]/;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", "!", "?", ")", "]", "}", ">", "\""]);
const FILE_LINK_RE = /\[((?:\\.|[^\\\]])*)\]\(<file:\/\/[^>]+>\)/g;

type TextPart = { type?: string; text?: string; [key: string]: unknown };
type MessageLike = { role?: string; content?: unknown; [key: string]: unknown };
type CandidateType = "absolute" | "tilde" | "windows" | "unc" | "relative" | "bare";

type ParsedCandidate = {
  visible: string;
  pathText: string;
  suffix: string;
  trailing: string;
  type: CandidateType;
  strong: boolean;
};

type ResolvedCandidate = ParsedCandidate & {
  resolvedPath: string;
  exists: boolean;
  url: string;
};

export default function fileLinks(pi: ExtensionAPI): void {
  pi.on("message_end", async (event, ctx) => {
    const message = event.message as unknown as MessageLike;
    if (!shouldLinkMessage(message)) return;
    const linked = linkMessage(message, ctx);
    if (linked === message) return;
    return { message: linked as unknown as typeof event.message };
  });

  pi.on("context", (event) => ({
    messages: event.messages.map((message) => stripMessageFileLinks(message as unknown as MessageLike)) as unknown as typeof event.messages,
  }));
}

function shouldLinkMessage(message: MessageLike): boolean {
  return message.role === "assistant" || message.role === "user";
}

function linkMessage(message: MessageLike, ctx: ExtensionContext): MessageLike {
  const content = message.content;
  if (typeof content === "string") {
    const linked = linkifyText(content, ctx.cwd);
    return linked === content ? message : { ...message, content: linked };
  }

  if (!Array.isArray(content)) return message;
  let changed = false;
  const next = content.map((part) => {
    if (!isTextPart(part)) return part;
    const linked = linkifyText(part.text || "", ctx.cwd);
    if (linked === part.text) return part;
    changed = true;
    return { ...part, text: linked };
  });
  return changed ? { ...message, content: next } : message;
}

function stripMessageFileLinks(message: MessageLike): MessageLike {
  const content = message.content;
  if (typeof content === "string") {
    const stripped = stripFileLinks(content);
    return stripped === content ? message : { ...message, content: stripped };
  }

  if (!Array.isArray(content)) return message;
  let changed = false;
  const next = content.map((part) => {
    if (!isTextPart(part)) return part;
    const stripped = stripFileLinks(part.text || "");
    if (stripped === part.text) return part;
    changed = true;
    return { ...part, text: stripped };
  });
  return changed ? { ...message, content: next } : message;
}

function isTextPart(value: unknown): value is TextPart {
  return !!value && typeof value === "object" && (value as TextPart).type === "text" && typeof (value as TextPart).text === "string";
}

function linkifyText(text: string, cwd: string): string {
  if (!text || text.length > MAX_TEXT_LENGTH) return text;
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let changed = false;
  let inFence = false;

  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    const linked = linkifyLine(line, cwd);
    if (linked !== line) changed = true;
    return linked;
  });

  return changed ? out.join("\n") : text;
}

function linkifyLine(line: string, cwd: string): string {
  let out = "";
  for (let i = 0; i < line.length;) {
    const markdownLinkEnd = existingMarkdownLinkEnd(line, i);
    if (markdownLinkEnd > i) {
      out += line.slice(i, markdownLinkEnd);
      i = markdownLinkEnd;
      continue;
    }

    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end < 0) {
        out += line.slice(i);
        break;
      }
      const raw = line.slice(i, end + 1);
      const inner = raw.slice(1, -1);
      const linked = linkifyStandalonePath(inner, cwd);
      out += linked ?? raw;
      i = end + 1;
      continue;
    }

    const quote = line[i];
    if (quote === "'" || quote === "\"") {
      const quoted = readQuotedPath(line, i, cwd);
      if (quoted) {
        out += quote + quoted.link + quote;
        i = quoted.end;
        continue;
      }
    }

    const match = findPathAt(line, i, cwd);
    if (match) {
      out += match.link;
      i = match.end;
      continue;
    }

    out += line[i];
    i += 1;
  }
  return out;
}

function existingMarkdownLinkEnd(line: string, start: number): number {
  const imageOffset = line[start] === "!" && line[start + 1] === "[" ? 1 : 0;
  if (line[start + imageOffset] !== "[") return -1;
  let escaped = false;
  for (let i = start + imageOffset + 1; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "]" && line[i + 1] === "(") {
      const close = line.indexOf(")", i + 2);
      return close >= 0 ? close + 1 : -1;
    }
  }
  return -1;
}

function readQuotedPath(line: string, start: number, cwd: string): { link: string; end: number } | undefined {
  const quote = line[start];
  const end = line.indexOf(quote, start + 1);
  if (end < 0) return undefined;
  const inner = line.slice(start + 1, end);
  const linked = linkifyStandalonePath(inner, cwd);
  return linked ? { link: linked, end: end + 1 } : undefined;
}

function linkifyStandalonePath(raw: string, cwd: string): string | undefined {
  const leading = raw.match(/^\s*/)?.[0] || "";
  const trailing = raw.match(/\s*$/)?.[0] || "";
  const body = raw.slice(leading.length, raw.length - trailing.length);
  if (!body || body.includes("\n")) return undefined;
  const type = candidateTypeAt(body, 0, true);
  if (!type) return undefined;
  const parsed = parseCandidate(body, type, "");
  if (!parsed) return undefined;
  const resolved = resolveCandidate(parsed, cwd);
  if (!isLinkable(resolved)) return undefined;
  return leading + markdownFileLink(resolved) + trailing;
}

function findPathAt(line: string, start: number, cwd: string): { link: string; end: number } | undefined {
  const type = candidateTypeAt(line, start, false);
  if (!type) return undefined;

  const existing = longestExistingCandidate(line, start, type, cwd);
  if (existing) {
    return { link: markdownFileLink(existing) + existing.trailing, end: start + existing.visible.length + existing.trailing.length };
  }

  const parsed = fallbackCandidate(line, start, type);
  if (!parsed) return undefined;
  const resolved = resolveCandidate(parsed, cwd);
  if (!isLinkable(resolved)) return undefined;
  return { link: markdownFileLink(resolved) + resolved.trailing, end: start + resolved.visible.length + resolved.trailing.length };
}

function candidateTypeAt(line: string, start: number, standalone: boolean): CandidateType | undefined {
  const rest = line.slice(start);
  const prev = start > 0 ? line[start - 1] : "";
  if (!standalone && prev && !isBoundaryBeforePath(prev)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) return undefined;

  if (rest.startsWith("~/") || rest.startsWith("~\\")) return "tilde";
  if (/^[A-Za-z]:[\\/]/.test(rest)) return "windows";
  if (rest.startsWith("\\\\")) return "unc";
  if (rest.startsWith("./") || rest.startsWith("../") || rest.startsWith(".\\") || rest.startsWith("..\\")) return "relative";
  if (rest.startsWith("/") && !rest.startsWith("//")) return "absolute";
  if (standalone && looksLikeBarePath(rest)) return "bare";
  if (!standalone && isBareStart(line[start]) && looksLikeBarePath(rest)) return "bare";
  return undefined;
}

function isBoundaryBeforePath(ch: string): boolean {
  return /[\s([{<"']/.test(ch);
}

function isBareStart(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_.@~+-]/.test(ch);
}

function looksLikeBarePath(text: string): boolean {
  const window = text.slice(0, MAX_CANDIDATE_LENGTH);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(window)) return false;
  return /[\\/]/.test(window) && !/^\d+[/-]\d+/.test(window);
}

function longestExistingCandidate(line: string, start: number, type: CandidateType, cwd: string): ResolvedCandidate | undefined {
  let best: ResolvedCandidate | undefined;
  const max = Math.min(line.length, start + MAX_CANDIDATE_LENGTH);
  for (let end = start + 2; end <= max; end++) {
    const raw = line.slice(start, end);
    if (!rawHasPathShape(raw, type)) continue;
    const { body, trailing } = trimTrailingPunctuation(raw);
    const parsed = parseCandidate(body, type, trailing);
    if (!parsed) continue;
    const resolved = resolveCandidate(parsed, cwd);
    if (!resolved.exists) continue;
    if (!best || resolved.visible.length > best.visible.length) best = resolved;
  }
  return best;
}

function rawHasPathShape(raw: string, type: CandidateType): boolean {
  if (type !== "bare") return true;
  return /[\\/]/.test(raw);
}

function fallbackCandidate(line: string, start: number, type: CandidateType): ParsedCandidate | undefined {
  const fileish = readFileishCandidate(line, start, type);
  if (fileish) return parseCandidate(fileish.body, type, fileish.trailing);

  const token = readTokenCandidate(line, start);
  if (!token) return undefined;
  return parseCandidate(token.body, type, token.trailing);
}

function readFileishCandidate(line: string, start: number, type: CandidateType): { body: string; trailing: string } | undefined {
  if (type === "bare") return undefined;
  const max = Math.min(line.length, start + MAX_CANDIDATE_LENGTH);
  for (let end = start + 3; end <= max; end++) {
    const chunk = line.slice(start, end);
    if (!/\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}(?::\d+(?::\d+)?)?$/.test(chunk)) continue;
    const next = line[end] || "";
    if (next && !PATH_BOUNDARY.test(next)) continue;
    const { body, trailing } = trimTrailingPunctuation(chunk);
    return { body, trailing };
  }
  return undefined;
}

function readTokenCandidate(line: string, start: number): { body: string; trailing: string } | undefined {
  let end = start;
  while (end < line.length && !/\s/.test(line[end]) && !"<>()[]{}\"'".includes(line[end])) end += 1;
  if (end === start) return undefined;
  return trimTrailingPunctuation(line.slice(start, end));
}

function trimTrailingPunctuation(raw: string): { body: string; trailing: string } {
  let body = raw;
  let trailing = "";
  while (body && TRAILING_PUNCTUATION.has(body[body.length - 1]!)) {
    trailing = body[body.length - 1] + trailing;
    body = body.slice(0, -1);
  }
  return { body, trailing };
}

function parseCandidate(body: string, type: CandidateType, trailing: string): ParsedCandidate | undefined {
  if (!body || /^[a-z][a-z0-9+.-]*:\/\//i.test(body)) return undefined;
  const suffixMatch = body.match(/:(\d+)(?::(\d+))?$/);
  const suffix = suffixMatch ? suffixMatch[0] : "";
  const pathText = suffix ? body.slice(0, -suffix.length) : body;
  if (!pathText || !/[\\/]/.test(pathText)) return undefined;
  const strong = type !== "bare" || hasFileExtension(pathText);
  return { visible: body, pathText, suffix, trailing, type, strong };
}

function resolveCandidate(candidate: ParsedCandidate, cwd: string): ResolvedCandidate {
  const pathText = candidate.pathText;
  let resolvedPath: string;

  if (candidate.type === "windows" || candidate.type === "unc") {
    resolvedPath = pathText;
  } else if (candidate.type === "tilde") {
    resolvedPath = resolve(homedir(), pathText.slice(2).replace(/[\\/]/g, sep));
  } else if (candidate.type === "absolute") {
    resolvedPath = pathText;
  } else {
    resolvedPath = resolve(cwd, pathText.replace(/[\\/]/g, sep));
  }

  const exists = pathExists(resolvedPath, candidate.type);
  const url = fileUrl(resolvedPath, candidate.type);
  return { ...candidate, resolvedPath, exists, url };
}

function pathExists(path: string, type: CandidateType): boolean {
  if ((type === "windows" || type === "unc") && process.platform !== "win32") return false;
  try { return existsSync(path); } catch { return false; }
}

function fileUrl(path: string, type: CandidateType): string {
  if (type === "windows" || type === "unc") return windowsFileUrl(path);
  return pathToFileURL(isAbsolute(path) ? path : resolve(path)).href;
}

function windowsFileUrl(path: string): string {
  const slashPath = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(slashPath)) return `file:///${encodeSegments(slashPath)}`;
  if (slashPath.startsWith("//")) return `file:${encodeSegments(slashPath)}`;
  return `file:///${encodeSegments(slashPath)}`;
}

function encodeSegments(path: string): string {
  return path.split("/").map((segment) => /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)).join("/");
}

function isLinkable(candidate: ResolvedCandidate): boolean {
  if (candidate.exists) return true;
  if (candidate.type === "bare" && /\s/.test(candidate.pathText)) return false;
  return candidate.strong;
}

function markdownFileLink(candidate: ResolvedCandidate): string {
  return `[${escapeMarkdownLabel(candidate.visible)}](<${candidate.url}>)`;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

function stripFileLinks(text: string): string {
  return text.replace(FILE_LINK_RE, (_full, label: string) => unescapeMarkdownLabel(label));
}

function unescapeMarkdownLabel(value: string): string {
  return value.replace(/\\([\\\[\]])/g, "$1");
}

function hasFileExtension(path: string): boolean {
  const leaf = path.split(/[\\/]/).pop() || "";
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(leaf);
}
