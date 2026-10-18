#!/usr/bin/env node
// Build benchmark cases from held-out GitHub pull requests: the code as it
// stood when a reviewer made a high-value comment, and the comments made on
// that commit as ground truth.
//
//   node cases.mjs select       -> $BENCH/candidates.jsonl (+ findable-in.jsonl for Jev)
//   node cases.mjs build [N] [set]  -> $BENCH/cases/<id>/{case.json,change.diff,PR.md,repo/}
//                                  (a named set takes only PRs not built yet)
//
// Between the two steps, Jev answers "findable" for each ground-truth comment
// (classify.codemode.js with NAME="findable", QUESTIONS="../bench/findable.json").

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../mining/config.mjs";

const BENCH = join(DATA_DIR, "bench");
mkdirSync(BENCH, { recursive: true });
const readJsonl = f => readFileSync(f, "utf8").trim().split("\n").map(l => JSON.parse(l));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });

const SECONDARY = u => u.role === "reviewer" && ["finding", "suggestion", "question"].includes(u.kind)
  && u.landed && u.depth >= 1.5 && u.severity >= 1 && u.scope === "line";

function select() {
  const units = readJsonl(join(DATA_DIR, "labelled.jsonl")).filter(u => u.split === "holdout" && u.source === "github");
  const changes = new Map(readJsonl(join(DATA_DIR, "changes.jsonl")).map(c => [`${c.project}#${c.number}`, c]));
  const byPr = Object.groupBy(units, u => `${u.project}#${u.change}`);
  const out = [];
  for (const [key, list] of Object.entries(byPr)) {
    const change = changes.get(key);
    if (!change || change.size > 1000) continue;
    const hv = list.filter(u => u.high_value && u.scope === "line" && u.commit);
    if (!hv.length) continue;
    // The commit carrying the most high-value comments is the reviewed state.
    const byCommit = Object.groupBy(hv, u => u.commit);
    const [commit] = Object.entries(byCommit).sort((a, b) => b[1].length - a[1].length)[0];
    const truth = list.filter(u => u.commit === commit && SECONDARY(u));
    out.push({
      key, project: change.project, number: change.number, title: change.title, body: change.body, size: change.size, commit,
      truth: truth.map(u => ({ id: u.id, primary: u.high_value, path: u.path, line: u.line, hunk: u.hunk, comment: u.comment, move: u.move, topic: u.topic, depth: u.depth, severity: u.severity, url: u.url, reviewer: u.commenter })),
    });
  }
  writeFileSync(join(BENCH, "candidates.jsonl"), out.map(c => JSON.stringify(c)).join("\n") + "\n");
  // Jev input: can this comment be found from the code alone?
  const dir = join(DATA_DIR, "jev", "findable-in");
  mkdirSync(dir, { recursive: true });
  const rows = out.flatMap(c => c.truth.map(t => JSON.stringify({ id: t.id, state: {
    project: c.project, change_title: c.title, file: t.path, code_context: t.hunk, reviewer_comment: t.comment,
  } })));
  for (let i = 0, n = 0; i < rows.length; n++) {
    let size = 0; const chunk = [];
    while (i < rows.length && size + rows[i].length < 100_000) { size += rows[i].length + 1; chunk.push(rows[i++]); }
    writeFileSync(join(dir, `${String(n).padStart(4, "0")}.jsonl`), chunk.join("\n") + "\n");
  }
  console.log(`${out.length} candidate PRs, ${rows.length} ground-truth comments`);
}

function findable() {
  const dir = join(DATA_DIR, "jev", "findable-out");
  const map = new Map();
  for (const f of readdirSync(dir)) for (const o of readJsonl(join(dir, f))) map.set(o.id, o.findable);
  return map;
}

function gh(path, accept) {
  const args = ["api", path];
  if (accept) args.push("-H", `Accept: ${accept}`);
  return sh("gh", args);
}

// A named set builds only PRs not already built (a fresh confirmation set) and
// lists its case ids in $BENCH/set-<name>.txt for run.mjs --cases.
function build(limit, setName) {
  const found = findable();
  const candidates = readJsonl(join(BENCH, "candidates.jsonl"));
  const built = new Set(existsSync(join(BENCH, "cases")) ? readdirSync(join(BENCH, "cases")) : []);
  const idOf = c => `${c.project.replace("/", "__")}__${c.number}`;
  const usable = candidates
    .map(c => ({ ...c, truth: c.truth.filter(t => (found.get(t.id) ?? 0) >= 0.5) }))
    .filter(c => c.truth.some(t => t.primary))
    .filter(c => !setName || !built.has(idOf(c)));
  // At most two PRs per repository; prefer more ground truth.
  usable.sort((a, b) => b.truth.filter(t => t.primary).length - a.truth.filter(t => t.primary).length || a.key.localeCompare(b.key));
  const perRepo = {};
  const picked = [];
  for (const c of usable) {
    if ((perRepo[c.project] ?? 0) >= 2) continue;
    perRepo[c.project] = (perRepo[c.project] ?? 0) + 1;
    picked.push(c);
    if (picked.length >= limit) break;
  }
  console.log(`${usable.length} usable PRs; building ${picked.length}`);
  if (setName) writeFileSync(join(BENCH, `set-${setName}.txt`), picked.map(idOf).join(","));
  for (const c of picked) {
    const id = `${c.project.replace("/", "__")}__${c.number}`;
    const dir = join(BENCH, "cases", id);
    if (existsSync(join(dir, "case.json"))) continue;
    mkdirSync(dir, { recursive: true });
    try {
      const raw = JSON.parse(readFileSync(join(DATA_DIR, "github", c.project.replace("/", "__"), `${c.number}.json`), "utf8"));
      // The base tip recorded at merge time does not contain the PR (unlike the
      // branch today when the PR was merged with a merge commit).
      const cmp = JSON.parse(gh(`repos/${c.project}/compare/${raw.baseRefOid}...${c.commit}`));
      const base = cmp.merge_base_commit.sha;
      const diff = gh(`repos/${c.project}/compare/${base}...${c.commit}`, "application/vnd.github.diff");
      writeFileSync(join(dir, "change.diff"), diff);
      const files = [...diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)].map(m => m[2]);
      // Sparse, blobless clone at the reviewed commit; the merge base is
      // fetched too so `git diff BASE HEAD` and `git show BASE:path` work.
      const repo = join(dir, "repo");
      sh("git", ["init", "-q", repo]);
      sh("git", ["-C", repo, "remote", "add", "origin", `https://github.com/${c.project}.git`]);
      sh("git", ["-C", repo, "config", "remote.origin.promisor", "true"]);
      sh("git", ["-C", repo, "config", "remote.origin.partialclonefilter", "blob:none"]);
      sh("git", ["-C", repo, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", c.commit, base]);
      const dirs = new Set();
      for (const f of files) {
        const parts = f.split("/");
        dirs.add(parts.slice(0, Math.max(1, parts.length - 1)).join("/"));
        if (parts.length > 2) dirs.add(parts.slice(0, parts.length - 2).join("/"));
      }
      sh("git", ["-C", repo, "sparse-checkout", "set", "--cone", ...[...dirs].filter(d => !d.includes(".") || d.split("/").length > 1)]);
      sh("git", ["-C", repo, "checkout", "-q", c.commit]);
      sh("git", ["-C", repo, "tag", "BASE", base]);
      writeFileSync(join(dir, "PR.md"), `# ${c.title}\n\n${raw.body ?? ""}\n`);
      writeFileSync(join(dir, "case.json"), JSON.stringify({ id, project: c.project, number: c.number, url: raw.url, title: c.title, commit: c.commit, base, files, truth: c.truth }, null, 1));
      console.log(`  ${id}: ${files.length} files, ${c.truth.length} ground truth (${c.truth.filter(t => t.primary).length} primary)`);
    } catch (e) {
      console.error(`  ${id} failed: ${e.message.slice(0, 300)}`);
    }
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "select") select();
else if (cmd === "build") build(Number(arg ?? 32), process.argv[4]);
else console.log("usage: node cases.mjs select | build [N] [set-name]");
