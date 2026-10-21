#!/usr/bin/env node
// Blind pairwise judging of two code-comments trial labels on each case by a
// headless pi session (Claude Opus). The judge sees the change, the comment
// remarks the maintainers made on it, and the two trials' edits in random
// order as A and B.
//
//   node comments-judge.mjs --runs base,skill [--model anthropic/claude-opus-5-5] [--jobs 6] [--name judge]
//   -> $BENCH/comments/judge/<name>/<case>/{judge.json,order.json}

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
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
const casesDir = join(BENCH, "comments", "cases");

const PROMPT = `You are a maintainer of the project in this case, judging two attempts to fix the comments and doc comments in a pull request before review. Read:

- PR.md and change.diff: the pull request as it stood when the maintainers reviewed it.
- remarks.json: the remarks the maintainers made on its comments at that point. They are the known problems; there may be others.
- A.diff and B.diff: the two attempts' edits, with A-notes.md and B-notes.md (their authors' summaries).
- Other files: \`git -C repo.git show COMMIT:<path>\` (COMMIT is in commit.txt).

For each maintainer remark, say whether each attempt fixed it: yes, partly or no. Then judge every edit each attempt made: useful (fixes a real problem or adds a contract, reason or warning a reader needs), neutral, or harmful (wrong, narrates the change or its history, repeats the code, too long for its place, changes code, or breaks the project's comment conventions), with the kind of harm. Finally say which attempt you would rather merge, A, B or tie.

Write judge.json:
{"remarks": [{"remark": "short", "A": "yes|partly|no", "B": "yes|partly|no"}],
 "A": {"edits": [{"where": "path:line", "verdict": "useful|neutral|harmful", "harm": "kind or empty", "note": "short"}]},
 "B": {...same...}, "prefer": "A|B|tie", "reason": "two or three sentences"}`;

const pick = id => parseInt(createHash("sha1").update(`${NAME}|${id}`).digest("hex").slice(0, 8), 16) % 2 === 0;
const cases = readdirSync(casesDir).filter(id => [X, Y].every(l => existsSync(join(BENCH, "comments", "runs", l, id, "done.json"))));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

function judgeOne(id) {
  const dir = join(BENCH, "comments", "judge", NAME, id);
  if (existsSync(join(dir, "judge.json"))) return Promise.resolve("skip");
  mkdirSync(dir, { recursive: true });
  const c = JSON.parse(readFileSync(join(casesDir, id, "case.json"), "utf8"));
  for (const f of ["PR.md", "change.diff", "remarks.json"]) copyFileSync(join(casesDir, id, f), join(dir, f));
  writeFileSync(join(dir, "commit.txt"), `${c.commit}\n`);
  const order = pick(id) ? { A: X, B: Y } : { A: Y, B: X };
  writeFileSync(join(dir, "order.json"), JSON.stringify(order));
  for (const [slot, label] of Object.entries(order)) {
    const run = join(BENCH, "comments", "runs", label, id);
    const repo = join(run, "repo");
    git(repo, "add", "-A", "-N");
    writeFileSync(join(dir, `${slot}.diff`), git(repo, "diff", "HEAD"));
    const notes = join(run, "COMMENTS.md");
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
