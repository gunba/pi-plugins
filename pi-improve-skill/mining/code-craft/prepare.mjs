#!/usr/bin/env node
// Write Jev classifier inputs: units.jsonl -> jev/<name>-in/NNNN.jsonl chunks of
// { id, state } under 110 KB each (codemode reads one chunk per read call).
// Units already classified (jev/<name>-out/*.jsonl) are skipped.
//
//   node prepare.mjs                          first pass: reviewer units on test files or that
//                                             mention tests or comments -> jev/in
//   node prepare.mjs --ids ids.json --name tests   (only these units) -> jev/tests-in
//   node prepare.mjs --sample 60 --name check      a random sample of the first pass for hand checks

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const NAME = arg("name");
const SAMPLE = Number(arg("sample") ?? 0);
const ONLY = arg("ids") ? new Set(JSON.parse(readFileSync(arg("ids"), "utf8"))) : null;
const units = readFileSync(join(DATA_DIR, "units.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));

// Clipping can split a surrogate pair; the classifier rejects lone surrogates.
const wellFormed = value => JSON.parse(JSON.stringify(value), (_, v) => (typeof v === "string" ? v.toWellFormed() : v));

export function stateOf(u) {
  const speaker = r => (r.role === "author" ? "change author" : r.role === "bot" ? "bot" : r.who === u.commenter ? "same reviewer" : "another reviewer");
  const signals = {};
  for (const k of ["outdated", "resolved", "later_version", "later_patchsets"]) if (u.signals[k] !== undefined) signals[k] = u.signals[k];
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

const candidate = u => u.commenter_role === "reviewer" && u.comment.trim().length >= 12
  && (u.test_path || u.mentions_test || u.mentions_comment);
const pickFrom = ONLY ? units.filter(u => ONLY.has(u.id)) : units.filter(candidate);

const done = new Set();
const outDir = join(DATA_DIR, "jev", NAME ? `${NAME}-out` : "out");
if (existsSync(outDir)) {
  for (const f of readdirSync(outDir)) for (const l of readFileSync(join(outDir, f), "utf8").split("\n")) if (l) done.add(JSON.parse(l).id);
}

let list = pickFrom.filter(u => !done.has(u.id));
if (SAMPLE) {
  let s = 42;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const copy = [...list];
  list = Array.from({ length: Math.min(SAMPLE, copy.length) }, () => copy.splice(Math.floor(rand() * copy.length), 1)[0]);
}
const inDir = join(DATA_DIR, "jev", NAME ? `${NAME}-in` : "in");
rmSync(inDir, { recursive: true, force: true });
mkdirSync(inDir, { recursive: true });
let chunk = [], size = 0, n = 0;
const flush = () => {
  if (!chunk.length) return;
  writeFileSync(join(inDir, `${String(n++).padStart(4, "0")}.jsonl`), chunk.join("\n") + "\n");
  chunk = []; size = 0;
};
for (const u of list) {
  const line = JSON.stringify({ id: u.id, state: stateOf(u) });
  if (size + line.length > 110_000) flush();
  chunk.push(line); size += line.length + 1;
}
flush();
console.log(`${list.length} units to classify in ${n} chunks (${done.size} already done, ${pickFrom.length} selected)`);
