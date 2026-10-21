#!/usr/bin/env node
// Summarise test-writing trials: measured results per label (and for the
// maintainers' own tests), and the judge's verdicts.
//
//   node tests-report.mjs --runs base,skill [--judge judge]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH } from "./go-env.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const RUNS = opt("runs", "base,skill").split(",");
const JUDGE = opt("judge", "judge");
const casesDir = join(BENCH, "tests", "cases");
const cases = readdirSync(casesDir).filter(id => RUNS.every(l => existsSync(join(BENCH, "tests", "runs", l, id, "score.json"))));
const read = f => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");

function measured(label, dirOf) {
  const rows = cases.map(id => ({ id, s: read(join(dirOf(id), "score.json")), done: read(join(dirOf(id), "done.json")), trace: join(dirOf(id), "trace.jsonl") }));
  const s = rows.map(r => r.s).filter(Boolean);
  const hunks = s.flatMap(x => x.hunks ?? []).filter(h => h.status !== "unapplied");
  const out = {
    label, cases: s.length,
    passes: pct(s.filter(x => x.with === "pass").length, s.length),
    detects: pct(s.filter(x => x.with === "pass" && ["fail", "build"].includes(x.without)).length, s.length),
    detectsByAssertion: pct(s.filter(x => x.with === "pass" && x.without === "fail").length, s.length),
    hunksKilled: pct(hunks.filter(h => h.status === "killed").length, hunks.length),
    hunksCaught: pct(hunks.filter(h => h.status !== "survived").length, hunks.length),
    nonTestEdits: s.filter(x => x.nonTestFiles.length).length,
    addedLines: Math.round(s.reduce((a, x) => a + x.addedLines, 0) / Math.max(1, s.length)),
  };
  const done = rows.map(r => r.done).filter(Boolean);
  if (done.length) {
    out.minutes = Math.round(done.reduce((a, d) => a + d.seconds, 0) / done.length / 6) / 10;
    out.cost = Math.round(done.reduce((a, d) => a + d.usage.cost, 0) * 100) / 100;
    out.readSkill = rows.filter(r => existsSync(r.trace) && /test-writing\/SKILL\.md/.test(readFileSync(r.trace, "utf8"))).length;
  }
  return out;
}

console.table([...RUNS.map(l => measured(l, id => join(BENCH, "tests", "runs", l, id))), measured("maintainers", id => join(BENCH, "tests", "maintainers", id))]);

const perCase = cases.map(id => {
  const row = { case: id };
  for (const l of RUNS) { const s = read(join(BENCH, "tests", "runs", l, id, "score.json")); row[l] = s ? `${s.with}/${s.without ?? "-"}/${(s.hunks ?? []).map(h => h.status[0]).join("")}` : "-"; }
  const m = read(join(BENCH, "tests", "maintainers", id, "score.json"));
  row.maintainers = m ? `${m.with}/${m.without ?? "-"}/${(m.hunks ?? []).map(h => h.status[0]).join("")}` : "-";
  return row;
});
console.log("with / without / hunks (k killed, b build, s survived)");
console.table(perCase);

const judged = cases.map(id => ({ id, j: read(join(BENCH, "tests", "judge", JUDGE, id, "judge.json")), o: read(join(BENCH, "tests", "judge", JUDGE, id, "order.json")) })).filter(r => r.j && r.o);
if (judged.length) {
  const tally = Object.fromEntries([...RUNS, "tie"].map(k => [k, 0]));
  const scores = Object.fromEntries(RUNS.map(l => [l, {}]));
  const verdicts = Object.fromEntries(RUNS.map(l => [l, {}]));
  const problems = Object.fromEntries(RUNS.map(l => [l, {}]));
  for (const { j, o } of judged) {
    tally[j.prefer === "tie" ? "tie" : o[j.prefer]]++;
    for (const slot of ["A", "B"]) {
      const l = o[slot];
      for (const [k, v] of Object.entries(j[slot].scores)) (scores[l][k] ??= []).push(v);
      verdicts[l][j[slot].verdict] = (verdicts[l][j[slot].verdict] ?? 0) + 1;
      for (const p of j[slot].problems ?? []) problems[l][p.severity] = (problems[l][p.severity] ?? 0) + 1;
    }
  }
  console.log(`judge "${JUDGE}": ${judged.length} cases; preferred:`, tally);
  console.table(RUNS.map(l => ({ label: l, ...Object.fromEntries(Object.entries(scores[l]).map(([k, v]) => [k, Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100])) })));
  console.table(RUNS.map(l => ({ label: l, ...verdicts[l], ...Object.fromEntries(Object.entries(problems[l]).map(([k, v]) => [`problems ${k}`, v])) })));
}
