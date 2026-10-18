#!/usr/bin/env node
// Mine inline review comments from Gerrit (Go's go-review.googlesource.com).
// Lists submitted and abandoned changes in a date window with comment counts,
// samples those with real inline review, and stores each change's details,
// inline comments and the diff context around each commented line.
//
//   node gerrit.mjs [--per-project 120] [--since 2025-04-01] [--until 2026-09-01]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, REPOS } from "./config.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const PER_PROJECT = Number(opt("per-project", 120));
const SINCE = opt("since", "2025-04-01");
const UNTIL = opt("until", "2026-09-01");
const HOST = REPOS.gerrit.go;
const PROJECTS = ["go", "tools", "crypto", "net"];

async function get(path, attempt = 0) {
  const res = await fetch(`${HOST}${path}`);
  if (!res.ok) {
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
      return get(path, attempt + 1);
    }
    throw new Error(`${res.status} ${path}`);
  }
  return JSON.parse((await res.text()).replace(/^\)\]\}'\n/, ""));
}

function shuffle(items, seed) {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Rebuild a unified-diff style hunk around `line` (new side) from Gerrit's DiffInfo.
function hunkAround(diff, line, side, radius = 6) {
  const rows = [];
  let a = 0, b = 0;
  for (const chunk of diff.content ?? []) {
    for (const t of chunk.ab ?? []) rows.push({ t: " ", text: t, a: ++a, b: ++b });
    for (const t of chunk.a ?? []) rows.push({ t: "-", text: t, a: ++a, b: null });
    for (const t of chunk.b ?? []) rows.push({ t: "+", text: t, a: null, b: ++b });
    if (chunk.skip) { a += chunk.skip; b += chunk.skip; rows.push({ t: "@", text: `... ${chunk.skip} unchanged lines ...`, a: null, b: null }); }
  }
  const key = side === "PARENT" ? "a" : "b";
  const at = rows.findIndex(r => r[key] === line);
  if (at < 0) return null;
  return rows.slice(Math.max(0, at - radius * 2), at + 1).map(r => `${r.t}${r.text}`).join("\n");
}

async function mineProject(project) {
  const dir = join(DATA_DIR, "gerrit", project);
  mkdirSync(dir, { recursive: true });
  const listFile = join(dir, "_list.json");
  let list;
  if (existsSync(listFile)) list = JSON.parse(readFileSync(listFile, "utf8"));
  else {
    list = [];
    for (const status of ["merged", "abandoned"]) {
      for (let start = 0; start < 6000; start += 500) {
        const q = encodeURIComponent(`project:${project} status:${status} after:${SINCE} before:${UNTIL}`);
        const page = await get(`/changes/?q=${q}&n=500&S=${start}&o=DETAILED_ACCOUNTS`);
        for (const c of page) list.push({ number: c._number, status: c.status, owner: c.owner?.email ?? c.owner?.name, comments: c.total_comment_count, insertions: c.insertions, deletions: c.deletions, subject: c.subject });
        if (!page.at(-1)?._more_changes) break;
      }
    }
    writeFileSync(listFile, JSON.stringify(list));
  }
  const eligible = list.filter(c => c.comments >= 4 && c.insertions + c.deletions <= 3000 && !/^\[release-branch|^all: |^cmd\/dist: |^internal\/goexperiment/.test(c.subject));
  const pick = shuffle(eligible, 11).slice(0, PER_PROJECT);
  console.error(`${project}: ${list.length} changes, ${eligible.length} eligible, ${pick.length} picked`);
  for (const c of pick) {
    const file = join(dir, `${c.number}.json`);
    if (existsSync(file)) continue;
    try {
      const change = await get(`/changes/${c.number}?o=ALL_REVISIONS&o=DETAILED_ACCOUNTS&o=MESSAGES&o=ALL_FILES&o=ALL_COMMITS`);
      const comments = await get(`/changes/${c.number}/comments`);
      const revByPs = Object.fromEntries(Object.entries(change.revisions).map(([sha, r]) => [r._number, { sha, ...r }]));
      const diffs = new Map();
      const flat = [];
      for (const [path, list] of Object.entries(comments)) {
        for (const cm of list) flat.push({ path, ...cm });
      }
      // Context for each thread root (comment without in_reply_to) on a line.
      for (const cm of flat) {
        if (cm.in_reply_to || !cm.line || cm.path.startsWith("/")) continue;
        const rev = revByPs[cm.patch_set];
        if (!rev) continue;
        const key = `${cm.patch_set}:${cm.path}`;
        if (!diffs.has(key)) {
          try { diffs.set(key, await get(`/changes/${c.number}/revisions/${rev.sha}/files/${encodeURIComponent(cm.path)}/diff?context=ALL&intraline=false`)); }
          catch { diffs.set(key, null); }
        }
        const diff = diffs.get(key);
        if (diff) cm.hunk = hunkAround(diff, cm.line, cm.side);
      }
      const owner = change.owner;
      writeFileSync(file, JSON.stringify({
        project, number: c.number, url: `${HOST}/c/${project}/+/${c.number}`, status: change.status,
        subject: change.subject, owner: { name: owner.name, email: owner.email, id: owner._account_id },
        message: revByPs[1]?.commit?.message ?? change.revisions[change.current_revision]?.commit?.message,
        patchSets: Object.keys(revByPs).length,
        files: Object.keys(revByPs[Object.keys(revByPs).length]?.files ?? {}),
        messages: (change.messages ?? []).map(m => ({ author: m.author?.name, authorId: m.author?._account_id, tag: m.tag, ps: m._revision_number, message: m.message })),
        comments: flat.map(cm => ({ id: cm.id, path: cm.path, line: cm.line, side: cm.side, ps: cm.patch_set, author: cm.author?.name, authorId: cm.author?._account_id, inReplyTo: cm.in_reply_to, unresolved: cm.unresolved, updated: cm.updated, message: cm.message, hunk: cm.hunk })),
      }));
    } catch (e) { console.error(`  ${project}/${c.number}: ${e.message}`); }
  }
}

for (const p of PROJECTS) await mineProject(p);
console.error("done");
