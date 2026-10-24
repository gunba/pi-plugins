#!/usr/bin/env node
// Blind pairwise judging of two trial labels on each case by a headless pi
// session (Claude Opus). The judge sees the change, the maintainers' own tests
// and their review remarks on tests, and the two trials' tests in random order
// as A and B, with the measured results of running each.
//
//   node tests-judge.mjs --runs base,skill [--model anthropic/claude-opus-5-5] [--jobs 6] [--name judge]
//   -> $BENCH/tests/judge/<name>/<case>/{judge.json,order.json}

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BENCH } from "./go-env.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const [X, Y] = opt("runs", "base,skill").split(",");
const MODEL = opt("model", "anthropic/claude-opus-5-5");
const NAME = opt("name", "judge");
const JOBS = Number(opt("jobs", 6));
const AUTH_EXT = join(homedir(), ".pi/agent/git/github.com/gunba/pi-plugins/node_modules/@gotgenes/pi-anthropic-auth/src/index.ts");
const casesDir = join(BENCH, "tests", "cases");

const PROMPT = `You are a maintainer of the project in this directory's case, judging two sets of tests written for the same change. Read:

- PR.md: the change's description; source.diff: the change itself (the code under test).
- maintainer-tests.diff: the tests the project's maintainers actually merged, and remarks.json: what reviewers said about tests on this change. These show what this project expects; a suite need not copy them.
- A.diff and B.diff: the two candidate test suites, with A-notes.md and B-notes.md (their authors' summaries) and A-results.json and B-results.json, measured by running each suite: "with" is the result on the change, three runs in a row (pass, fail, build); "without" is the result with the change's source reverted (a fail or build failure there means the suite detects the change); "hunks" reverts each source hunk alone (killed by a failing test, build failure, or survived).
- Other files of the repository at the change: \`git -C repo.git show CHANGE:<path>\` (CHANGE is in change.txt).

Judge each suite as you would in review. Score each from 1 (poor) to 5 (excellent) on:
- cases: covers the cases the change can meet (variants, boundaries, error paths, the bug's scenario);
- assertions: checks exact results and side effects, with expected values that are right;
- detects: would catch a regression of this change (use the measured results);
- reliability: deterministic, no machine assumptions, cleans up, no bugs in the test code;
- fit: uses the project's harness, helpers, file layout and conventions;
- clarity: small, readable, no needless code.
List the problems you would raise in review for each suite (most important first), each with a severity: blocking, should fix, or nit. Then say which suite you would rather merge, A, B or tie, and whether each would be accepted as is, with minor changes, or needs major rework.

Write judge.json:
{"A": {"scores": {"cases": n, "assertions": n, "detects": n, "reliability": n, "fit": n, "clarity": n}, "problems": [{"severity": "...", "problem": "..."}], "verdict": "accept|minor|major"},
 "B": {...same...}, "prefer": "A|B|tie", "reason": "two or three sentences"}`;

const pick = id => parseInt(createHash("sha1").update(`${NAME}|${id}`).digest("hex").slice(0, 8), 16) % 2 === 0;
const cases = readdirSync(casesDir).filter(id => [X, Y].every(l => existsSync(join(BENCH, "tests", "runs", l, id, "score.json"))));

function judgeOne(id) {
  const dir = join(BENCH, "tests", "judge", NAME, id);
  if (existsSync(join(dir, "judge.json"))) return Promise.resolve("skip");
  mkdirSync(dir, { recursive: true });
  const c = JSON.parse(readFileSync(join(casesDir, id, "case.json"), "utf8"));
  for (const f of ["PR.md", "source.diff", "maintainer-tests.diff", "remarks.json"]) copyFileSync(join(casesDir, id, f), join(dir, f));
  writeFileSync(join(dir, "change.txt"), `${c.change}\n`);
  const order = pick(id) ? { A: X, B: Y } : { A: Y, B: X };
  writeFileSync(join(dir, "order.json"), JSON.stringify(order));
  for (const [slot, label] of Object.entries(order)) {
    const run = join(BENCH, "tests", "runs", label, id);
    const score = JSON.parse(readFileSync(join(run, "score.json"), "utf8"));
    const diff = readFileSync(join(run, "trial.diff"), "utf8");
    const testOnly = diff.split(/^(?=diff --git )/m).filter(p => /_test\.go|\/testdata\//.test(p.split("\n")[0])).join("");
    writeFileSync(join(dir, `${slot}.diff`), testOnly);
    writeFileSync(join(dir, `${slot}-results.json`), JSON.stringify({ with: score.with, without: score.without, hunks: (score.hunks ?? []).map(h => h.status), nonTestFilesChanged: score.nonTestFiles }, null, 1));
    const notes = join(run, "TESTS.md");
    writeFileSync(join(dir, `${slot}-notes.md`), existsSync(notes) ? readFileSync(notes, "utf8") : "(none written)");
  }
  return new Promise(done => {
    const child = spawn("pi", ["-p", "--no-session", "--no-extensions", "-e", AUTH_EXT, "--no-mcp", "--no-prompt-templates", "--no-skills",
      "--model", MODEL, "--thinking", "high", PROMPT.replace(/repo\.git/g, c.repo)], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    child.on("close", code => { writeFileSync(join(dir, "judge.log"), out.slice(-20000)); done(code); });
  });
}

const queue = [...cases];
let n = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (queue.length) {
    const id = queue.shift();
    const r = await judgeOne(id);
    console.error(`[${NAME}] ${++n}/${cases.length} ${id}: ${r}`);
  }
}));
