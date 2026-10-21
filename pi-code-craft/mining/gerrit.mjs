#!/usr/bin/env node
// Mine inline review comments from Gerrit hosts (Go, Chromium). Lists merged
// and abandoned changes with comment counts, samples those with real inline
// review, and stores each change's details, inline comments and the diff
// context around each commented line. Changes already in the code-review
// corpus are not fetched again. Chromium is too large to list whole, so it is
// listed from two days in every month of the window.
//
//   node gerrit.mjs [--per-project 300] [--since 2025-04-01] [--until 2026-09-01]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, GERRIT, REUSE_DIR } from "./config.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const PER_PROJECT = Number(opt("per-project", 300));
const SINCE = opt("since", "2025-04-01");
const UNTIL = opt("until", "2026-09-01");

async function get(host, path, attempt = 0) {
  let res;
  try { res = await fetch(`${host}${path}`); } catch (e) {
    if (attempt < 4) { await new Promise(r => setTimeout(r, 3000 * 2 ** attempt)); return get(host, path, attempt + 1); }
    throw e;
  }
  if (!res.ok) {
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
      return get(host, path, attempt + 1);
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

// Rebuild a unified-diff style hunk around `line` from Gerrit's DiffInfo.
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

const AUTOMATED = /^(\[release-branch|all: |cmd\/dist: |internal\/goexperiment|Roll |Automated |Update .* (version|expectations)|Revert ")/;

async function listProject(host, project) {
  for (const root of [DATA_DIR, REUSE_DIR]) {
    const file = join(root, "gerrit", project.replace("/", "__"), "_list.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  }
  const list = [];
  const add = page => {
    for (const c of page) list.push({ number: c._number, status: c.status, branch: c.branch, owner: c.owner?.email ?? c.owner?.name, comments: c.total_comment_count, insertions: c.insertions, deletions: c.deletions, subject: c.subject });
  };
  const chromium = /chromium/.test(host);
  const windows = [];
  if (chromium) {
    for (let d = new Date(`${SINCE}T00:00:00Z`); d < new Date(`${UNTIL}T00:00:00Z`); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      for (const day of [9, 23]) {
        const a = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day));
        windows.push([a.toISOString().slice(0, 10), new Date(+a + 86400000).toISOString().slice(0, 10)]);
      }
    }
  } else windows.push([SINCE, UNTIL]);
  for (const [after, before] of windows) {
    for (const status of ["merged", "abandoned"]) {
      for (let start = 0; start < 6000; start += 500) {
        const q = encodeURIComponent(`project:${project} status:${status} after:${after} before:${before}${chromium ? " branch:main" : ""}`);
        const page = await get(host, `/changes/?q=${q}&n=500&S=${start}&o=DETAILED_ACCOUNTS`);
        add(page);
        if (!page.at(-1)?._more_changes) break;
      }
    }
  }
  mkdirSync(join(DATA_DIR, "gerrit", project.replace("/", "__")), { recursive: true });
  writeFileSync(join(DATA_DIR, "gerrit", project.replace("/", "__"), "_list.json"), JSON.stringify(list));
  return list;
}

async function mineProject(host, project) {
  const dir = join(DATA_DIR, "gerrit", project.replace("/", "__"));
  const reuse = join(REUSE_DIR, "gerrit", project.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  const list = await listProject(host, project);
  const eligible = list.filter(c => c.comments >= 4 && c.insertions + c.deletions <= 3000 && !AUTOMATED.test(c.subject));
  const pick = shuffle(eligible, 11).slice(0, PER_PROJECT);
  console.error(`${project}: ${list.length} changes, ${eligible.length} eligible, ${pick.length} picked`);
  for (const c of pick) {
    const file = join(dir, `${c.number}.json`);
    if (existsSync(file) || existsSync(join(reuse, `${c.number}.json`))) continue;
    try {
      const change = await get(host, `/changes/${c.number}?o=ALL_REVISIONS&o=DETAILED_ACCOUNTS&o=MESSAGES&o=ALL_FILES&o=ALL_COMMITS`);
      const comments = await get(host, `/changes/${c.number}/comments`);
      const revByPs = Object.fromEntries(Object.entries(change.revisions).map(([sha, r]) => [r._number, { sha, ...r }]));
      const diffs = new Map();
      const flat = [];
      for (const [path, items] of Object.entries(comments)) for (const cm of items) flat.push({ path, ...cm });
      for (const cm of flat) {
        if (cm.in_reply_to || !cm.line || cm.path.startsWith("/")) continue;
        const rev = revByPs[cm.patch_set];
        if (!rev) continue;
        const key = `${cm.patch_set}:${cm.path}`;
        if (!diffs.has(key)) {
          try { diffs.set(key, await get(host, `/changes/${c.number}/revisions/${rev.sha}/files/${encodeURIComponent(cm.path)}/diff?context=ALL&intraline=false`)); }
          catch { diffs.set(key, null); }
        }
        const diff = diffs.get(key);
        if (diff) cm.hunk = hunkAround(diff, cm.line, cm.side);
      }
      const owner = change.owner;
      writeFileSync(file, JSON.stringify({
        project, number: c.number, url: `${host}/c/${project}/+/${c.number}`, status: change.status,
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

const jobs = Object.entries(GERRIT).flatMap(([host, projects]) => projects.map(p => () => mineProject(host, p)));
await Promise.all(jobs.map(job => job().catch(e => console.error(`failed: ${e.message}`))));
console.error("done");
