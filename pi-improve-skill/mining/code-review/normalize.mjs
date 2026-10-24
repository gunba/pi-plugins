#!/usr/bin/env node
// Turn raw GitHub, lore and Gerrit data into review units: one reviewer
// comment with its code context, the replies that followed (each tagged with
// the speaker's role) and outcome signals. Roles come from metadata here
// (change author, bot accounts); Jev checks the semantics in classify.
//
//   node normalize.mjs   -> $DATA_DIR/units.jsonl, $DATA_DIR/changes.jsonl

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, basename, join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const CPP_REPOS = /llvm|WebKit|envoy|dotnet|swift|pytorch|duckdb|bitcoin|openjdk/;
const EXT = {
  ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++", ".inc": "C++", ".def": "C++",
  ".rs": "Rust", ".go": "Go", ".py": "Python", ".pyi": "Python", ".pyx": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".jsx": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".java": "Java", ".cs": "C#", ".swift": "Swift", ".kt": "Kotlin",
  ".m": "Objective-C", ".mm": "Objective-C++", ".sh": "Shell", ".bash": "Shell", ".s": "Assembly", ".S": "Assembly", ".asm": "Assembly",
  ".ll": "LLVM IR", ".mir": "LLVM IR", ".td": "TableGen", ".md": "Docs", ".rst": "Docs", ".txt": "Text", ".yml": "Config", ".yaml": "Config",
  ".toml": "Config", ".json": "Config", ".bzl": "Build", ".bazel": "Build", ".cmake": "Build", ".gn": "Build", ".mk": "Build", ".sql": "SQL", ".test": "SQL tests",
  ".proto": "Protobuf", ".lua": "Lua", ".nix": "Nix", ".html": "HTML", ".css": "CSS",
};
function language(path, project) {
  if (!path) return null;
  const name = basename(path);
  if (/^(Makefile|Kconfig|CMakeLists\.txt|BUILD|meson\.build|Cargo\.toml|configure\.ac)$/.test(name)) return "Build";
  const lang = EXT[extname(path)] ?? null;
  if (lang === "C" && extname(path) === ".h" && CPP_REPOS.test(project)) return "C++";
  return lang;
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…[cut]` : s ?? "");
const tail = (s, lines, chars) => {
  if (!s) return "";
  let out = s.split("\n").slice(-lines).join("\n");
  if (out.length > chars) out = `…${out.slice(-chars)}`;
  return out;
};
const clean = s => (s ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/!\[[^\]]*\]\([^)]+\)/g, "[image]").replace(/\r/g, "").trim();
const id = (...parts) => createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);

const BOT_LOGIN = /\[bot\]$|^(bors|rustbot|rust-timer|rust-log-analyzer|llvmbot|k8s-ci-robot|k8s-triage-robot|openjdk-notifier|swift-ci|pytorchmergebot|pytorch-bot|facebook-github-bot|copilot|github-actions|codecov|netlify|vercel|mergify|dependabot|webkit-early-warning-system|webkit-commit-queue|ghost|DrahtBot|hashicorp-cla|CLAassistant|cla-bot|sync-by-unito|linux-foundation-easycla|graphite-app|coderabbitai|gemini-code-assist|cursor|sourcery-ai|claude|chatgpt-codex-connector|codspeed-hq|azure-pipelines|dotnet-policy-service|msftbot|dotnet-issue-labeler|google-cla|envoy-repokitteh-bot|repokitteh-read-only|ci-robot|apple-bot)$/i;
const isBotActor = a => !a || a.__typename === "Bot" || BOT_LOGIN.test(a.login ?? "");

const units = [];
const changes = [];

// ---------- GitHub ----------
function githubRole(actor, prAuthor) {
  if (isBotActor(actor)) return "bot";
  return actor.login === prAuthor ? "author" : "reviewer";
}
function loadGithub() {
  const root = join(DATA_DIR, "github");
  if (!existsSync(root)) return;
  for (const repoDir of readdirSync(root)) {
    for (const file of readdirSync(join(root, repoDir))) {
      if (!file.endsWith(".json") || file.startsWith("_")) continue;
      const pr = JSON.parse(readFileSync(join(root, repoDir, file), "utf8"));
      const prAuthor = pr.author?.login;
      const change = {
        source: "github", project: pr.repo, number: pr.number, url: pr.url, title: pr.title,
        author: prAuthor, state: pr.state, integrated: pr.state === "MERGED" || pr.labels?.nodes?.some(l => /^(integrated|merged)$/i.test(l.name)),
        base: pr.baseRefOid, head: pr.headRefOid, files: pr.files?.nodes?.map(f => f.path) ?? [], size: pr.additions + pr.deletions,
        body: clip(clean(pr.body), 1500), createdAt: pr.createdAt,
      };
      changes.push(change);
      const ctx = { source: "github", project: pr.repo, change: pr.number, change_url: pr.url, change_title: pr.title, change_author: prAuthor, change_integrated: change.integrated };
      pr.reviewThreads.nodes.forEach((t, ti) => {
        const cs = t.comments.nodes;
        if (!cs.length) return;
        const first = cs[0];
        const role = githubRole(first.author, prAuthor);
        const replies = cs.slice(1, 6).map(c => ({ role: githubRole(c.author, prAuthor), who: c.author?.login ?? "ghost", body: clip(clean(c.body), 1200) }));
        units.push({
          id: id("gh", pr.repo, pr.number, ti), ...ctx, scope: t.subjectType === "FILE" ? "file" : "line",
          path: t.path, language: language(t.path, pr.repo), line: t.originalLine ?? t.line,
          hunk: tail(first.diffHunk, 30, 2500), commenter: first.author?.login ?? "ghost", commenter_association: first.authorAssociation,
          commenter_role: role, comment: clip(clean(first.body), 3000), replies, url: first.url,
          commit: first.originalCommit?.oid ?? null,
          signals: { resolved: t.isResolved, outdated: t.isOutdated, resolved_by: t.resolvedBy?.login === prAuthor ? "author" : t.resolvedBy ? "reviewer" : null },
        });
      });
      // Review summaries and long conversation comments from reviewers.
      const general = [
        ...pr.reviews.nodes.map(r => ({ ...r, at: r.submittedAt, kind: "review" })),
        ...pr.comments.nodes.map(c => ({ ...c, at: c.createdAt, kind: "comment" })),
      ].sort((a, b) => (a.at < b.at ? -1 : 1));
      general.forEach((g, gi) => {
        const body = clean(g.body);
        if (githubRole(g.author, prAuthor) !== "reviewer" || body.length < 200) return;
        const after = general.slice(gi + 1).filter(x => clean(x.body).length > 0).slice(0, 3);
        units.push({
          id: id("ghg", pr.repo, pr.number, gi), ...ctx, scope: "general", path: null, language: null, line: null, hunk: "",
          commenter: g.author.login, commenter_association: g.authorAssociation, commenter_role: "reviewer",
          comment: clip(body, 3000), review_state: g.state ?? null,
          replies: after.map(x => ({ role: githubRole(x.author, prAuthor), who: x.author?.login ?? "ghost", body: clip(clean(x.body), 1200) })),
          url: pr.url, commit: g.commit?.oid ?? null, signals: {},
        });
      });
    }
  }
}

// ---------- lore (mailing lists) ----------
const emailOf = from => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const nameOf = from => from.replace(/<[^>]+>/, "").replace(/"/g, "").trim().toLowerCase();
const quoteDepth = l => (l.match(/^(\s?>)+/)?.[0].replace(/\s/g, "").length ?? 0);
const unquote = l => l.replace(/^\s?>\s?/, "");
const TRAILER = /^(Reviewed-by|Acked-by|Tested-by|Signed-off-by|Reported-by|Suggested-by|Cc|Link|Fixes):/i;

// Split an email body into (quoted context, reply) units.
function emailUnits(body) {
  let lines = body.replace(/\r/g, "").split("\n");
  const sig = lines.findIndex(l => l === "-- " || l === "--");
  if (sig > 0) lines = lines.slice(0, sig);
  const blocks = [];
  for (const l of lines) {
    const q = quoteDepth(l) > 0;
    const last = blocks.at(-1);
    if (last && last.q === q) last.lines.push(l);
    else blocks.push({ q, lines: [l] });
  }
  const out = [];
  let path = null;
  const pathFrom = ls => {
    for (const l of ls) {
      const m = unquote(l).match(/^(?:diff --git a\/\S+ b\/(\S+)|\+\+\+ b\/(\S+))/);
      if (m) path = m[1] ?? m[2];
    }
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.q) { pathFrom(b.lines); continue; }
    const text = b.lines.join("\n").trim();
    const prose = b.lines.filter(l => l.trim() && !TRAILER.test(l.trim())
      && !/^On .* wrote:$|wrote:$|^(Hi|Hello|Hey)\b.{0,30}$|^Thanks,?$|^Regards,?$|^Cheers,?$|^Best,?$/i.test(l.trim())
      && !/^[[<(]?\s*(\.\.\.|…|snip|snipped|trimmed)\s*[\]>)]?$/i.test(l.trim()));
    const prev = blocks[i - 1];
    if (!prev || !prose.length) continue;
    const context = prev.lines.map(unquote);
    out.push({ context: context.slice(-30).join("\n"), text, path, trailers: b.lines.filter(l => TRAILER.test(l.trim())).map(l => l.trim()) });
  }
  return out;
}
const words = s => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
function matchResponse(unitText, responseBody) {
  const target = words(unitText);
  if (target.size < 3) return null;
  let best = null, score = 0;
  for (const u of emailUnits(responseBody)) {
    const quoted = u.context.split("\n").filter(l => quoteDepth(l) === 0).join(" ");
    const w = words(quoted);
    let hit = 0;
    for (const t of target) if (w.has(t)) hit++;
    const s = hit / target.size;
    if (s > score) { score = s; best = u; }
  }
  return score >= 0.5 ? best.text : null;
}
function loadLore() {
  const root = join(DATA_DIR, "lore");
  if (!existsSync(root)) return;
  for (const list of readdirSync(root)) {
    for (const file of readdirSync(join(root, list))) {
      if (!file.endsWith(".json") || file.startsWith("_")) continue;
      const t = JSON.parse(readFileSync(join(root, list, file), "utf8"));
      const authorEmail = emailOf(t.author);
      const authorName = nameOf(t.author);
      const project = `lore/${list}`;
      const diffFiles = [...t.patch.body.matchAll(/^diff --git a\/\S+ b\/(\S+)/gm)].map(m => m[1]);
      changes.push({
        source: "lore", project, number: t.num, url: t.url, title: t.patch.subject, author: t.author, state: t.laterVersion ? "revised" : "unknown",
        integrated: null, files: diffFiles, size: (t.patch.body.match(/^[+-](?![+-])/gm) ?? []).length, body: clip(t.patch.body.split(/^---$/m)[0], 1500),
        patch: clip(t.patch.body, 60000), createdAt: t.patch.date,
      });
      const ctx = { source: "lore", project, change: t.num, change_url: t.url, change_title: t.patch.subject, change_author: t.author, change_integrated: null };
      t.reviews.forEach((r, ri) => {
        const same = emailOf(r.from) === authorEmail || (authorName.length > 4 && nameOf(r.from) === authorName);
        const parts = emailUnits(r.body);
        const trailers = parts.flatMap(p => p.trailers);
        parts.forEach(u => {
          const replies = [];
          for (const resp of r.responses) {
            const matched = matchResponse(u.text, resp.body);
            if (matched) replies.push({ role: resp.byAuthor || nameOf(resp.from) === authorName ? "author" : "reviewer", who: resp.from, body: clip(matched, 1200) });
          }
          units.push({
            id: id("lore", list, t.num, ri, u.text), ...ctx, scope: u.path ? "line" : "message", path: u.path, language: language(u.path, project),
            line: null, hunk: tail(u.context, 30, 2500), commenter: r.from, commenter_association: null,
            commenter_role: same ? "author" : "reviewer", comment: clip(u.text, 3000), replies, url: r.url, commit: null,
            signals: { later_version: t.laterVersion, reviewer_trailers: trailers, author_responded: r.responses.some(x => x.byAuthor) },
          });
        });
      });
    }
  }
}

// ---------- Gerrit ----------
const GERRIT_BOTS = /Gopher Robot|LUCI|Go Bot|gobot|Kokoro/i;
function loadGerrit() {
  const root = join(DATA_DIR, "gerrit");
  if (!existsSync(root)) return;
  for (const proj of readdirSync(root)) {
    for (const file of readdirSync(join(root, proj))) {
      if (!file.endsWith(".json") || file.startsWith("_")) continue;
      const c = JSON.parse(readFileSync(join(root, proj, file), "utf8"));
      const project = `go/${proj}`;
      changes.push({
        source: "gerrit", project, number: c.number, url: c.url, title: c.subject, author: c.owner.name, state: c.status,
        integrated: c.status === "MERGED", files: c.files.filter(f => !f.startsWith("/")), body: clip(c.message, 1500), patchSets: c.patchSets,
      });
      const ctx = { source: "gerrit", project, change: c.number, change_url: c.url, change_title: c.subject, change_author: c.owner.name, change_integrated: c.status === "MERGED" };
      const role = cm => (GERRIT_BOTS.test(cm.author ?? "") ? "bot" : cm.authorId === c.owner.id ? "author" : "reviewer");
      const byId = new Map(c.comments.map(cm => [cm.id, cm]));
      const rootOf = cm => { let x = cm; while (x.inReplyTo && byId.has(x.inReplyTo)) x = byId.get(x.inReplyTo); return x; };
      const threads = new Map();
      for (const cm of [...c.comments].sort((a, b) => (a.updated < b.updated ? -1 : 1))) {
        const r = rootOf(cm);
        if (!threads.has(r.id)) threads.set(r.id, []);
        threads.get(r.id).push(cm);
      }
      for (const [rid, cms] of threads) {
        const first = byId.get(rid);
        const scope = first.path === "/PATCHSET_LEVEL" ? "general" : first.path === "/COMMIT_MSG" ? "commit_message" : "line";
        units.push({
          id: id("gerrit", proj, c.number, rid), ...ctx, scope, path: first.path.startsWith("/") ? null : first.path,
          language: language(first.path, project), line: first.line ?? null, hunk: tail(first.hunk, 30, 2500),
          commenter: first.author, commenter_association: null, commenter_role: role(first), comment: clip(first.message, 3000),
          replies: cms.filter(x => x.id !== rid).slice(0, 5).map(x => ({ role: role(x), who: x.author, body: clip(x.message, 1200) })),
          url: `${c.url}/comment/${rid}/`, commit: null,
          signals: { resolved: cms.at(-1).unresolved === false, later_patchsets: c.patchSets > first.ps },
        });
      }
    }
  }
}

loadGithub();
loadLore();
loadGerrit();
writeFileSync(join(DATA_DIR, "units.jsonl"), units.map(u => JSON.stringify(u)).join("\n") + "\n");
writeFileSync(join(DATA_DIR, "changes.jsonl"), changes.map(c => JSON.stringify(c)).join("\n") + "\n");
const count = {};
for (const u of units) {
  const k = `${u.source} ${u.commenter_role} ${u.scope}`;
  count[k] = (count[k] ?? 0) + 1;
}
console.log(`${changes.length} changes, ${units.length} units`);
console.table(count);
