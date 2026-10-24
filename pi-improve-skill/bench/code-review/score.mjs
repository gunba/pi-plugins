#!/usr/bin/env node
// Score benchmark runs against the maintainers' comments.
//
//   node score.mjs prepare <label> [<label> ...]   split reviews into findings; write Jev inputs
//   (run classify.codemode.js with NAME="match",   CORPUS="code-review", QUESTIONS="../../bench/code-review/match.json")
//   (run classify.codemode.js with NAME="profile", CORPUS="code-review", QUESTIONS="questions.json")
//   node score.mjs report <label> [<label> ...]    recall, findings per review, comment profile
//
// A ground-truth comment counts as found when Jev judges that some finding in
// the review raises the same problem. "Primary" ground truth is the
// high-value comments; "all" adds the other landed comments on that commit.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../mining/code-review/config.mjs";

const BENCH = join(DATA_DIR, "bench");
const JEV = join(DATA_DIR, "jev");
const hash = (...p) => createHash("sha1").update(p.join("|")).digest("hex").slice(0, 16);
const readJsonl = f => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const wellFormed = v => JSON.parse(JSON.stringify(v), (_, x) => (typeof x === "string" ? x.toWellFormed() : x));

function readReview(runDir) {
  // An agent that answers in its final message instead of the file still reviewed.
  for (const p of [join(runDir, "w", "review.md"), join(runDir, "review.md"), join(runDir, "final.md")]) if (existsSync(p)) return readFileSync(p, "utf8");
  return null;
}

// Numbered items at the start of a line ("1.", "1)", "### 1.", "**1.**", "## 1 —");
// text before the first item is the summary and is not a finding.
export function splitFindings(md) {
  const lines = md.split("\n");
  const items = [];
  let cur = null;
  const start = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?(?:Issue\s+|Finding\s+)?(\d{1,2})(?:[.):]|\s+[—–-])\s*/i;
  for (const line of lines) {
    const m = line.match(start);
    if (m && (!cur || Number(m[1]) === cur.n + 1 || Number(m[1]) === 1)) {
      if (cur) items.push(cur);
      cur = { n: Number(m[1]), text: line };
    } else if (cur) cur.text += `\n${line}`;
  }
  if (cur) items.push(cur);
  if (items.length) return items.map(i => i.text.trim().slice(0, 3000));
  // Fallback: level-3 headings.
  return md.split(/\n(?=###\s)/).slice(1).map(s => s.trim().slice(0, 3000));
}

function prepare(labels) {
  const cases = Object.fromEntries(readdirSync(join(BENCH, "cases")).filter(c => existsSync(join(BENCH, "cases", c, "case.json")))
    .map(c => [c, JSON.parse(readFileSync(join(BENCH, "cases", c, "case.json"), "utf8"))]));
  const done = new Set([...readOut("match").keys(), ...readOut("profile").keys()]);
  const match = [], profile = [];
  for (const label of labels) {
    const findingsOut = [];
    for (const id of Object.keys(cases)) {
      // Score only the cases this label ran (sets differ between labels).
      if (!existsSync(join(BENCH, "runs", label, id, "done.json"))) continue;
      const md = readReview(join(BENCH, "runs", label, id));
      if (md == null) { findingsOut.push({ label, case: id, missing: true, findings: [] }); continue; }
      const findings = splitFindings(md);
      findingsOut.push({ label, case: id, findings });
      const c = cases[id];
      findings.forEach((f, fi) => {
        const pid = hash("profile", label, id, fi, f);
        if (!done.has(pid)) profile.push({ id: pid, state: wellFormed({ project: c.project, change_title: c.title, file: "(see finding)", language: null, code_context: "(none)", commenter_account: "reviewer", commenter_is_change_author: false, reviewer_comment: f, replies: [], signals: {} }) });
        for (const t of c.truth) {
          const mid = hash("match", label, id, t.id, fi, f);
          if (!done.has(mid)) match.push({ id: mid, state: wellFormed({ project: c.project, file: t.path, line: t.line, code_context: t.hunk, reviewer_comment: t.comment, agent_finding: f }) });
        }
      });
    }
    writeFileSync(join(BENCH, "runs", label, "findings.json"), JSON.stringify(findingsOut));
  }
  writeChunks("match", match);
  writeChunks("profile", profile);
  console.log(`${match.length} pairs and ${profile.length} findings to classify`);
}

function writeChunks(name, rows) {
  const dir = join(JEV, `${name}-in`);
  mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir).length;
  let chunk = [], size = 0, n = existing;
  const flush = () => { if (chunk.length) writeFileSync(join(dir, `${String(n++).padStart(4, "0")}.jsonl`), chunk.join("\n") + "\n"); chunk = []; size = 0; };
  for (const r of rows) {
    const line = JSON.stringify(r);
    if (size + line.length > 100_000) flush();
    chunk.push(line); size += line.length + 1;
  }
  flush();
}

function readOut(name) {
  const dir = join(JEV, `${name}-out`);
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) for (const o of readJsonl(join(dir, f))) map.set(o.id, o);
  return map;
}

function report(labels) {
  const match = readOut("match"), profile = readOut("profile");
  const cases = Object.fromEntries(readdirSync(join(BENCH, "cases")).filter(c => existsSync(join(BENCH, "cases", c, "case.json")))
    .map(c => [c, JSON.parse(readFileSync(join(BENCH, "cases", c, "case.json"), "utf8"))]));
  const rows = {};
  const perCase = {};
  for (const label of labels) {
    const runs = JSON.parse(readFileSync(join(BENCH, "runs", label, "findings.json"), "utf8"));
    let pFound = 0, pTotal = 0, aFound = 0, aTotal = 0, nFind = 0, missing = 0, unscored = 0, pSoft = 0, aSoft = 0;
    const kinds = {}, depth = [], sev = [];
    let seconds = 0, cost = 0, tools = 0;
    const verdicts = { valid: 0, minor: 0, invalid: 0, unverifiable: 0 };
    let judged = 0;
    for (const run of runs) {
      const c = cases[run.case];
      if (run.missing) missing++;
      const done = JSON.parse(readFileSync(join(BENCH, "runs", label, run.case, "done.json"), "utf8"));
      seconds += done.seconds; cost += done.usage.cost;
      const trace = join(BENCH, "runs", label, run.case, "trace.jsonl");
      tools += existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).length : 0;
      nFind += run.findings.length;
      const judgeFile = join(BENCH, "runs", label, run.case, "judge", "judge.json");
      if (existsSync(judgeFile)) {
        const j = JSON.parse(readFileSync(judgeFile, "utf8"));
        for (const v of j.verdicts ?? []) if (v.verdict in verdicts) { verdicts[v.verdict]++; judged++; }
      }
      const found = c.truth.map(t => run.findings.some((f, fi) => {
        const m = match.get(hash("match", label, run.case, t.id, fi, f));
        if (!m) unscored++;
        return m && m.same_issue >= 0.5;
      }));
      // Soft recall: the best match probability per ground-truth comment, which
      // does not flip on matches that sit near the 0.5 threshold.
      const best = c.truth.map(t => Math.max(0, ...run.findings.map((f, fi) => match.get(hash("match", label, run.case, t.id, fi, f))?.same_issue ?? 0)));
      c.truth.forEach((t, i) => {
        aTotal++; if (found[i]) aFound++; aSoft += best[i];
        if (t.primary) { pTotal++; if (found[i]) pFound++; pSoft += best[i]; }
      });
      perCase[run.case] ??= {};
      perCase[run.case][label] = `${found.filter((x, i) => x && c.truth[i].primary).length}/${c.truth.filter(t => t.primary).length} p, ${found.filter(Boolean).length}/${c.truth.length} all, ${run.findings.length} f`;
      run.findings.forEach((f, fi) => {
        const p = profile.get(hash("profile", label, run.case, fi, f));
        if (!p) return;
        kinds[p.kind] = (kinds[p.kind] ?? 0) + 1; depth.push(p.depth); sev.push(p.severity);
      });
    }
    const n = runs.length;
    const mean = a => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
    const kTot = Object.values(kinds).reduce((a, b) => a + b, 0);
    rows[label] = {
      runs: n, missing, unscored,
      primary_recall: `${pFound}/${pTotal} = ${Math.round((pFound / pTotal) * 1000) / 10}%`,
      all_recall: `${aFound}/${aTotal} = ${Math.round((aFound / aTotal) * 1000) / 10}%`,
      primary_soft: `${Math.round((pSoft / pTotal) * 1000) / 10}%`, all_soft: `${Math.round((aSoft / aTotal) * 1000) / 10}%`,
      findings_per_review: Math.round((nFind / n) * 10) / 10,
      found_per_10_findings: Math.round((aFound / Math.max(1, nFind)) * 100) / 10,
      nit_share: `${Math.round(((kinds.nit ?? 0) / Math.max(1, kTot)) * 100)}%`,
      question_share: `${Math.round(((kinds.question ?? 0) / Math.max(1, kTot)) * 100)}%`,
      mean_depth: mean(depth), mean_severity: mean(sev),
      judged, valid: `${Math.round((verdicts.valid / Math.max(1, judged)) * 100)}%`, minor: `${Math.round((verdicts.minor / Math.max(1, judged)) * 100)}%`,
      invalid: `${Math.round((verdicts.invalid / Math.max(1, judged)) * 100)}%`, valid_per_review: Math.round((verdicts.valid / n) * 10) / 10,
      median_like_seconds: Math.round(seconds / n), cost_per_review: Math.round((cost / n) * 100) / 100, tool_calls_per_review: Math.round((tools / n) * 10) / 10,
    };
  }
  console.table(rows);
  console.table(perCase);
}

const [cmd, ...labels] = process.argv.slice(2);
if (cmd === "prepare") prepare(labels);
else if (cmd === "report") report(labels);
else console.log("usage: node score.mjs prepare|report <label> ...");
