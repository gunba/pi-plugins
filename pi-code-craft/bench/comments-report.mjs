#!/usr/bin/env node
// Summarise the code-comments benchmark: maintainers' remarks each label
// fixed, and the judge's verdict on every edit.
//
//   node comments-report.mjs --runs base,skill [--judge judge]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH } from "./go-env.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const RUNS = opt("runs", "base,skill").split(",");
const JUDGE = opt("judge", "judge");
const dir = join(BENCH, "comments", "judge", JUDGE);
const rows = readdirSync(dir).map(id => ({ id, j: existsSync(join(dir, id, "judge.json")) ? JSON.parse(readFileSync(join(dir, id, "judge.json"), "utf8")) : null, o: JSON.parse(readFileSync(join(dir, id, "order.json"), "utf8")) })).filter(r => r.j);
const t = Object.fromEntries(RUNS.map(l => [l, { yes: 0, partly: 0, no: 0, useful: 0, neutral: 0, harmful: 0, harms: {}, codeChanged: 0 }]));
const prefer = Object.fromEntries([...RUNS, "tie"].map(k => [k, 0]));
let remarks = 0;
for (const { id, j, o } of rows) {
  prefer[j.prefer === "tie" ? "tie" : o[j.prefer]]++;
  for (const r of j.remarks ?? []) { remarks++; for (const s of ["A", "B"]) t[o[s]][r[s]] = (t[o[s]][r[s]] ?? 0) + 1; }
  for (const s of ["A", "B"]) {
    for (const e of j[s].edits ?? []) {
      t[o[s]][e.verdict] = (t[o[s]][e.verdict] ?? 0) + 1;
      if (e.verdict === "harmful") { const k = (e.harm || "other").toLowerCase(); t[o[s]].harms[k] = (t[o[s]].harms[k] ?? 0) + 1; }
    }
  }
}
console.log(`${rows.length} cases, ${remarks} maintainer remarks; preferred:`, prefer);
console.table(RUNS.map(l => ({ label: l, fixed: t[l].yes, partly: t[l].partly, missed: t[l].no, "edits useful": t[l].useful, neutral: t[l].neutral, harmful: t[l].harmful })));
for (const l of RUNS) console.log(l, "harm kinds:", t[l].harms);
