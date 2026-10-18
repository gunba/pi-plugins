#!/usr/bin/env node
// Blind validity judge: a Claude Opus session checks every finding of a review
// against the code and labels it. The judge sees the PR, the diff, the
// repository and the findings, never which condition produced them. Trials run
// on GPT Sol, so the grader is from another family.
//
//   node judge.mjs --runs gpt-baseline-r1,gpt-skill-r1 [--model anthropic/claude-opus-5-5] [--thinking high] [--jobs 4]
//
// Output per run: judge.json [{ n, verdict, reason }], verdict one of
// valid | minor | invalid | unverifiable.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../mining/config.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const RUNS = opt("runs").split(",");
const MODEL = opt("model", "anthropic/claude-opus-5-5");
const THINKING = opt("thinking", "high");
const JOBS = Number(opt("jobs", 4));
// Claude subscription sign-in; without it headless Claude sessions fail as "extra usage".
const AUTH_EXT = join(homedir(), ".pi/agent/git/github.com/gunba/pi-plugins/node_modules/@gotgenes/pi-anthropic-auth/src/index.ts");
const BENCH = join(DATA_DIR, "bench");

const PROMPT = `You are checking another reviewer's findings on a pull request. PR.md has the title and description, change.diff is the change (from git tag BASE to HEAD), and repo/ is the repository at HEAD (a sparse, partial clone: read other files with \`git -C repo show HEAD:<path>\`, search with \`git -C repo grep <pattern> HEAD -- <pathspec>\`, see the old version with \`git -C repo show BASE:<path>\`). findings.md lists the findings, numbered.

For every finding, check its claims against the code and decide:
- valid: the problem is real in this change and a maintainer should act on it;
- minor: true, but not worth a revision (style, taste, negligible risk);
- invalid: the claim is wrong: the code does not behave as described, the case is already handled, or the premise is false;
- unverifiable: cannot be settled from the code available.

Be strict and concrete; read the code each claim refers to. Write findings-verdicts.json in this directory: a JSON array of {"n": <finding number>, "verdict": "...", "reason": "<one sentence>"}, one entry per finding. Do not modify repo/.`;

function splitFindings(md) {
  const lines = md.split("\n");
  const items = [];
  let cur = null;
  const start = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?(?:Issue\s+|Finding\s+)?(\d{1,2})(?:[.):]|\s+[—–-])\s*/i;
  for (const line of lines) {
    const m = line.match(start);
    if (m && (!cur || Number(m[1]) === cur.n + 1 || Number(m[1]) === 1)) { if (cur) items.push(cur); cur = { n: Number(m[1]), text: line }; }
    else if (cur) cur.text += `\n${line}`;
  }
  if (cur) items.push(cur);
  return items.map(i => i.text.trim());
}

const jobs = [];
for (const label of RUNS) {
  const findings = JSON.parse(readFileSync(join(BENCH, "runs", label, "findings.json"), "utf8"));
  for (const run of findings) if (run.findings.length) jobs.push({ label, id: run.case, findings: run.findings });
}

function judgeOne({ label, id, findings }) {
  const dir = join(BENCH, "runs", label, id, "judge");
  if (existsSync(join(dir, "judge.json"))) return Promise.resolve("skip");
  mkdirSync(dir, { recursive: true });
  const src = join(BENCH, "cases", id);
  copyFileSync(join(src, "PR.md"), join(dir, "PR.md"));
  copyFileSync(join(src, "change.diff"), join(dir, "change.diff"));
  if (!existsSync(join(dir, "repo"))) symlinkSync(join(src, "repo"), join(dir, "repo"));
  // Renumber 1..n and drop the review's own summary, so style does not reveal the condition.
  writeFileSync(join(dir, "findings.md"), findings.map((f, i) => `${i + 1}. ${f.replace(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Issue\s+|Finding\s+)?\d{1,2}(?:[.):]|\s+[—–-])\s*/i, "")}`).join("\n\n"));
  const piArgs = ["-p", "--no-session", "--no-extensions", "-e", AUTH_EXT, "--no-mcp", "--no-prompt-templates", "--no-skills", "--model", MODEL, "--thinking", THINKING, PROMPT];
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn("pi", piArgs, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    child.on("close", code => {
      let verdicts = null;
      try { verdicts = JSON.parse(readFileSync(join(dir, "findings-verdicts.json"), "utf8")); } catch {}
      writeFileSync(join(dir, "judge.json"), JSON.stringify({ code, seconds: Math.round((Date.now() - started) / 1000), verdicts, tail: out.slice(-1500) }, null, 1));
      resolve(verdicts ? "ok" : "no verdicts");
    });
  });
}

// Interleave conditions so both progress together.
jobs.sort((a, b) => a.id.localeCompare(b.id) || a.label.localeCompare(b.label));
let done = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (jobs.length) {
    const j = jobs.shift();
    const r = await judgeOne(j);
    console.error(`[judge] ${++done} ${j.label} ${j.id}: ${r}`);
  }
}));
