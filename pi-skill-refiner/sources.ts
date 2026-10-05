import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface SkillSource { name: string; description: string; filePath: string }
export interface TraceEntry { id: string; role: string; content: unknown; toolName?: string; toolCallId?: string; isError?: boolean }
export interface Trace {
  id: string; path: string; sourceHash: string; sessionId: string; parentSession?: string;
  leafId: string; family: string; cwd: string; entries: TraceEntry[]; score: number; contentHash: string;
}
export interface Retrieval { traces: Trace[]; scanned: number; bytes: number; skipped: { path: string; reason: string }[] }
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const stopWords = new Set("a an the this that to of in for on with and or from my our how improve improving skill skills sessions past more better make please use using".split(" "));
export function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []).filter(word => !stopWords.has(word)))];
}
export function resolveSkill(query: string, skills: SkillSource[]): SkillSource {
  const words = terms(query);
  const ranked = skills.filter(skill => skill.name !== "skill-refine").map(skill => ({ skill,
    score: (new RegExp(`(?:^|[^\\p{L}\\p{N}_-])${skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}_-])`, "iu").test(query) ? 100 : 0)
      + words.filter(word => terms(`${skill.name} ${skill.description}`).includes(word)).length,
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[0].score < ranked[1].score * 1.5)) {
    throw new Error(`Specify the target skill name or skillPath. Candidates: ${ranked.slice(0, 8).map(item => item.skill.name).join(", ") || skills.map(skill => skill.name).join(", ")}`);
  }
  return ranked[0].skill;
}

function cleanContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap<unknown>(item => {
    const block = object(item);
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "toolCall" && typeof block.name === "string") return [{ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }];
    // Reasoning, opaque signatures, images and arbitrary details are not evidence inputs.
    return [];
  });
}

/** Read-only parsing: no SessionManager.open migration, parent-file traversal, or live-leaf inference. */
export function parseSession(raw: string, path: string): Trace[] {
  const lines = raw.trim().split("\n").map(line => object(JSON.parse(line)));
  const header = lines.shift();
  if (!header || header.type !== "session" || header.version !== 3 || typeof header.id !== "string" || typeof header.cwd !== "string") {
    throw new Error("Requires a complete native v3 JSONL session");
  }
  const byId = new Map<string, Record<string, any>>();
  const parents = new Set<string>();
  for (const entry of lines) {
    if (typeof entry.id !== "string" || byId.has(entry.id) || !(entry.parentId === null || typeof entry.parentId === "string")) throw new Error("Invalid or duplicate session entry");
    byId.set(entry.id, entry);
    if (entry.parentId) parents.add(entry.parentId);
  }
  const traces: Trace[] = [];
  for (const leaf of lines.filter(entry => !parents.has(entry.id))) {
    const branch = [];
    const seen = new Set<string>();
    let cursor: string | null = leaf.id;
    while (cursor !== null) {
      const entry = byId.get(cursor);
      if (!entry || seen.has(cursor)) throw new Error("Missing parent or cyclic session branch");
      seen.add(cursor); branch.push(entry); cursor = entry.parentId;
    }
    branch.reverse();
    const replacements = new Map(branch.filter(entry => entry.type === "context_edit").map(entry => [entry.targetId, entry.replacement]));
    const entries: TraceEntry[] = [];
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const message = object(entry.message);
      if (!["user", "assistant", "toolResult", "bashExecution"].includes(message.role)) continue;
      if (replacements.has(entry.id) && replacements.get(entry.id) === null) continue;
      let content = cleanContent(replacements.has(entry.id) ? replacements.get(entry.id).content : message.content);
      if (message.role === "bashExecution") {
        if (message.excludeFromContext) continue;
        content = replacements.has(entry.id) ? content : { command: message.command, output: message.output, exitCode: message.exitCode, truncated: message.truncated };
      }
      entries.push({ id: entry.id, role: message.role, content,
        ...(message.role === "toolResult" ? { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError } : {}),
      });
    }
    if (!entries.length) continue;
    const contentHash = hash(JSON.stringify(entries.map(({ id: _id, ...entry }) => entry)));
    traces.push({ id: `${header.id}:${leaf.id}`, path, sourceHash: hash(raw), sessionId: header.id,
      parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined,
      family: header.id, leafId: leaf.id, cwd: header.cwd, entries, score: 0, contentHash });
  }
  return traces;
}

export async function retrieve(options: {
  root: string; cwd?: string; query: string; skill: SkillSource; limit: number; excludePath?: string;
  maxFiles?: number; maxBytes?: number; signal?: AbortSignal;
}): Promise<Retrieval> {
  const result: Retrieval = { traces: [], scanned: 0, bytes: 0, skipped: [] };
  const root = await realpath(options.root);
  const files: { path: string; mtime: number; size: number }[] = [];
  const maxFiles = options.maxFiles ?? 500;
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  async function list(directory: string, depth: number): Promise<void> {
    options.signal?.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < 2) await list(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await stat(path); files.push({ path, mtime: info.mtimeMs, size: info.size });
      }
    }
  }
  await list(root, 0);
  files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const queryTerms = terms(options.query);
  const skillTerms = terms(`${options.skill.name} ${options.skill.description}`);
  const candidates: Trace[] = [];
  const byPath = new Map<string, Trace>();
  for (const file of files) {
    options.signal?.throwIfAborted();
    if (resolve(file.path) === (options.excludePath && resolve(options.excludePath))) continue;
    if (result.scanned >= maxFiles || result.bytes + file.size > maxBytes || file.size > 32 * 1024 * 1024) {
      result.skipped.push({ path: file.path, reason: "Local scan budget" }); continue;
    }
    result.scanned++; result.bytes += file.size;
    try {
      const traces = parseSession(await readFile(file.path, "utf8"), file.path);
      if (traces[0]) byPath.set(resolve(file.path), traces[0]);
      for (const trace of traces) {
        if (options.cwd && resolve(trace.cwd) !== resolve(options.cwd)) continue;
        const text = JSON.stringify(trace.entries).toLowerCase();
        const vocabulary = new Set(terms(text));
        const exactUse = text.includes(options.skill.filePath.toLowerCase()) || text.includes(`/skill:${options.skill.name.toLowerCase()}`);
        const matches = queryTerms.filter(term => vocabulary.has(term)).length;
        const skillMatches = skillTerms.filter(term => vocabulary.has(term)).length;
        trace.score = (exactUse ? 20 : 0) + 4 * matches + skillMatches;
        if (trace.score && (exactUse || matches > 0)) candidates.push(trace);
      }
    } catch (error) {
      result.skipped.push({ path: file.path, reason: String(error) });
    }
  }
  // Related forks and sibling branches are alternatives, not repeated independent outcomes.
  for (const trace of candidates) {
    let ancestor = trace;
    const seen = new Set<string>();
    while (ancestor.parentSession) {
      const parent = resolve(dirname(ancestor.path), ancestor.parentSession);
      if (seen.has(parent)) break;
      seen.add(parent);
      trace.family = `parent:${parent}`;
      const found = byPath.get(parent);
      if (!found) break;
      ancestor = found; trace.family = ancestor.sessionId;
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const families = new Set<string>(), contents = new Set<string>();
  for (const trace of candidates) {
    if (families.has(trace.family) || contents.has(trace.contentHash)) {
      result.skipped.push({ path: `${trace.path}#${trace.leafId}`, reason: "Sibling/fork lineage or duplicate evidence" }); continue;
    }
    if (result.traces.length >= options.limit) break;
    families.add(trace.family); contents.add(trace.contentHash); result.traces.push(trace);
  }
  return result;
}

export async function readSkill(filePath: string): Promise<{ source: SkillSource; content: string; sha256: string }> {
  const path = await realpath(filePath);
  const content = await readFile(path, "utf8");
  if (content.length > 100_000) throw new Error("Skill exceeds 100,000 characters");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) throw new Error("Target must be a SKILL.md with frontmatter");
  const name = frontmatter.match(/^name:\s*['\"]?([\w-]+)/m)?.[1] ?? basename(dirname(path));
  const description = frontmatter.match(/^description:\s*(.+)/m)?.[1] ?? "";
  return { source: { name, description, filePath: path }, content, sha256: hash(content) };
}
