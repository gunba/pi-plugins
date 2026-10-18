#!/usr/bin/env node
// Write Jev classifier inputs: units.jsonl -> jev/in/NNNN.jsonl chunks of
// { id, state } under 110 KB each (codemode reads one chunk per read call).
// Units already classified (jev/out/*.jsonl) are skipped.
//
//   node prepare.mjs [--sample N]   (sample: a stratified validation set in jev/sample.jsonl)
//   node prepare.mjs --ids ids.json --name moves   (only these units, into jev/moves-in, skipping jev/moves-out)

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const sampleIdx = process.argv.indexOf("--sample");
const SAMPLE = sampleIdx > 0 ? Number(process.argv[sampleIdx + 1]) : 0;
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const NAME = arg("name");
const ONLY = arg("ids") ? new Set(JSON.parse(readFileSync(arg("ids"), "utf8"))) : null;
const units = readFileSync(join(DATA_DIR, "units.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));

// Clipping can split a surrogate pair; the classifier rejects lone surrogates.
const wellFormed = value => JSON.parse(JSON.stringify(value), (_, v) => (typeof v === "string" ? v.toWellFormed() : v));

export function stateOf(u) {
  const speaker = r => (r.role === "author" ? "change author" : r.role === "bot" ? "bot" : r.who === u.commenter ? "same reviewer" : "another reviewer");
  const signals = {};
  if (u.signals.outdated !== undefined) signals.outdated = u.signals.outdated;
  if (u.signals.resolved !== undefined) signals.resolved = u.signals.resolved;
  if (u.signals.later_version !== undefined) signals.later_version = u.signals.later_version;
  if (u.signals.later_patchsets !== undefined) signals.later_patchsets = u.signals.later_patchsets;
  return wellFormed({
    project: u.project,
    change_title: u.change_title,
    file: u.path ?? (u.scope === "general" ? "(whole change)" : u.scope),
    language: u.language,
    code_context: u.hunk || "(none: comment on the whole change)",
    commenter_account: u.commenter,
    commenter_is_change_author: u.commenter_role === "author",
    reviewer_comment: u.comment,
    replies: u.replies.map(r => ({ speaker: speaker(r), text: r.body })),
    signals,
  });
}

const done = new Set();
const outDir = join(DATA_DIR, "jev", NAME ? `${NAME}-out` : "out");
if (existsSync(outDir)) {
  for (const f of readdirSync(outDir)) {
    for (const l of readFileSync(join(outDir, f), "utf8").split("\n")) if (l) done.add(JSON.parse(l).id);
  }
}

if (SAMPLE) {
  // Stratified by source and metadata role so every kind of unit is checked.
  const groups = new Map();
  for (const u of units) {
    const k = `${u.source}:${u.commenter_role}:${u.scope === "general" ? "general" : "line"}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  let s = 42;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = [];
  const per = Math.ceil(SAMPLE / groups.size);
  for (const [, list] of groups) {
    const copy = [...list];
    for (let i = 0; i < per && copy.length; i++) pick.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  mkdirSync(join(DATA_DIR, "jev"), { recursive: true });
  writeFileSync(join(DATA_DIR, "jev", "sample.jsonl"), pick.slice(0, SAMPLE).map(u => JSON.stringify({ id: u.id, state: stateOf(u) })).join("\n") + "\n");
  console.log(`sample: ${Math.min(SAMPLE, pick.length)} units from ${groups.size} groups`);
} else {
  const inDir = join(DATA_DIR, "jev", NAME ? `${NAME}-in` : "in");
  rmSync(inDir, { recursive: true, force: true });
  mkdirSync(inDir, { recursive: true });
  let chunk = [], size = 0, n = 0, total = 0;
  const flush = () => {
    if (!chunk.length) return;
    writeFileSync(join(inDir, `${String(n++).padStart(4, "0")}.jsonl`), chunk.join("\n") + "\n");
    chunk = []; size = 0;
  };
  for (const u of units) {
    if (done.has(u.id) || !u.comment.trim() || (ONLY && !ONLY.has(u.id))) continue;
    const line = JSON.stringify({ id: u.id, state: stateOf(u) });
    if (size + line.length > 110_000) flush();
    chunk.push(line); size += line.length + 1; total++;
  }
  flush();
  console.log(`${total} units to classify in ${n} chunks (${done.size} already done)`);
}
