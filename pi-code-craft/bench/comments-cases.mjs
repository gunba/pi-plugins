#!/usr/bin/env node
// Build code-comments benchmark cases from held-out pull requests where a
// maintainer raised a problem with a comment that the author then fixed. Each
// case is the pull request at the commit the maintainer reviewed; the
// maintainers' comment remarks on that commit are kept aside for judging.
//
//   node comments-cases.mjs [N]   -> $BENCH/comments/cases/<id>/{case.json,PR.md,change.diff,remarks.json}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../mining/config.mjs";
import { BENCH } from "./go-env.mjs";

const N = Number(process.argv[2] ?? 20);
const PROJECTS = ["grpc/grpc-go", "prometheus/prometheus", "scikit-learn/scikit-learn", "astral-sh/ruff", "tokio-rs/tokio", "bitcoin/bitcoin", "envoyproxy/envoy", "bytecodealliance/wasmtime", "openssl/openssl"];
const MOVES = ["wrong_or_stale", "document_contract", "api_docs", "explain_why", "unclear", "redundant", "change_narrative", "too_long"];
const readJsonl = f => readFileSync(f, "utf8").trim().split("\n").map(l => JSON.parse(l));
const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

const labelled = readJsonl(join(DATA_DIR, "labelled.jsonl"));
const changes = new Map(readJsonl(join(DATA_DIR, "changes.jsonl")).map(c => [`${c.project}#${c.number}`, c]));
const seeds = labelled.filter(u => u.area === "comments" && u.split === "holdout" && u.landed && u.source === "github" && u.commit && u.path
  && MOVES.includes(u.move) && u.concrete >= 0.5 && PROJECTS.includes(u.project));
// One case per pull request, at the commit with the most comment remarks.
const byPr = Object.groupBy(seeds, u => `${u.project}#${u.change}`);
const picks = Object.entries(byPr).map(([key, list]) => {
  const [commit, at] = Object.entries(Object.groupBy(list, u => u.commit)).sort((a, b) => b[1].length - a[1].length)[0];
  return { key, commit, at };
}).filter(p => (changes.get(p.key)?.size ?? 9999) <= 1500).slice(0, N);

for (const { key, commit } of picks) {
  const [project, n] = key.split("#");
  const id = `${project.replace("/", "-")}-${n}`;
  const out = join(BENCH, "comments", "cases", id);
  if (existsSync(join(out, "case.json"))) continue;
  const change = changes.get(key);
  const repo = join(BENCH, "repos", `${project.replace("/", "__")}.git`);
  if (!existsSync(repo)) execFileSync("git", ["clone", "--bare", "--filter=blob:none", "-q", `https://github.com/${project}.git`, repo]);
  try {
    git(repo, "fetch", "-q", "origin", `pull/${n}/head:refs/bench/pr-${n}`, change.base);
    git(repo, "cat-file", "-e", `${commit}^{commit}`);
  } catch {
    try { git(repo, "fetch", "-q", "origin", commit); } catch { console.error(`${id}: reviewed commit unavailable`); continue; }
  }
  const base = git(repo, "merge-base", change.base, commit).trim();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "change.diff"), git(repo, "diff", "--no-renames", base, commit));
  const body = (change.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  writeFileSync(join(out, "PR.md"), `# ${change.title}\n\n${body}\n`);
  // Every comment remark people made on that commit, whatever its outcome.
  const remarks = labelled.filter(u => u.project === project && String(u.change) === n && u.commit === commit && u.area === "comments")
    .map(u => ({ path: u.path, line: u.line, move: u.move, outcome: u.outcome, comment: u.comment, code: u.hunk.split("\n").slice(-8).join("\n") }));
  writeFileSync(join(out, "remarks.json"), JSON.stringify(remarks, null, 1));
  writeFileSync(join(out, "case.json"), JSON.stringify({ id, key, project, repo, base, commit, remarks: remarks.length }, null, 1));
  console.error(`${id}: ${remarks.length} comment remarks`);
}
