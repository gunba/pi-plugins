#!/usr/bin/env node
// Build test-writing benchmark cases from held-out Go changes that came with
// tests and drew review remarks on them. Each case is the repository at the
// change's base with the change's non-test files applied as one commit; the
// maintainers' tests are kept aside for scoring and judging.
//
//   node tests-cases.mjs            -> $BENCH/tests/cases/<id>/{case.json,PR.md,maintainer-tests.diff,remarks.json}
//
// Repositories are blobless clones in $BENCH/repos; each case gets a branch
// case/<id> there. The Go toolchain and caches live in $BENCH (see go-env.mjs).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../mining/config.mjs";
import { BENCH, goEnv } from "./go-env.mjs";

export const CASES = [
  "grpc/grpc-go#9357", "grpc/grpc-go#8895", "grpc/grpc-go#8573", "grpc/grpc-go#8970", "grpc/grpc-go#8385", "grpc/grpc-go#9189",
  "prometheus/prometheus#18680", "prometheus/prometheus#17161", "prometheus/prometheus#18557", "prometheus/prometheus#18067",
  "etcd-io/etcd#21863", "etcd-io/etcd#21545", "etcd-io/etcd#20564",
  "go/tools#669495", "go/tools#770861", "go/tools#763920", "go/tools#669997", "go/crypto#759900",
];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts }).trim();
const git = (repo, ...args) => sh("git", ["-C", repo, ...args]);
export const isTest = f => /_test\.go$/.test(f) || /(^|\/)testdata\//.test(f);
const readJsonl = f => readFileSync(f, "utf8").trim().split("\n").map(l => JSON.parse(l));

function repoFor(project) {
  const name = project.replace("/", "__");
  const dir = join(BENCH, "repos", `${name}.git`);
  if (!existsSync(dir)) {
    mkdirSync(join(BENCH, "repos"), { recursive: true });
    const url = project.startsWith("go/") ? `https://go.googlesource.com/${project.slice(3)}` : `https://github.com/${project}.git`;
    sh("git", ["clone", "--bare", "--filter=blob:none", "-q", url, dir]);
  }
  return dir;
}

async function gerritCommits(project, number) {
  const res = await fetch(`https://go-review.googlesource.com/changes/${number}?o=CURRENT_REVISION&o=CURRENT_COMMIT`);
  const c = JSON.parse((await res.text()).replace(/^\)\]\}'\n/, ""));
  const rev = c.revisions[c.current_revision];
  return { head: c.current_revision, base: rev.commit.parents[0].commit, ref: rev.ref };
}

const changes = new Map(readJsonl(join(DATA_DIR, "changes.jsonl")).map(c => [`${c.project}#${c.number}`, c]));
const labelled = readJsonl(join(DATA_DIR, "labelled.jsonl"));

for (const key of CASES) {
  const [project, n] = key.split("#");
  const id = key.replace(/[/#]/g, "-");
  const out = join(BENCH, "tests", "cases", id);
  if (existsSync(join(out, "case.json"))) { console.error(`${id}: built`); continue; }
  const change = changes.get(key);
  const repo = repoFor(project);
  let base, head;
  if (project.startsWith("go/")) {
    const g = await gerritCommits(project, n);
    git(repo, "fetch", "-q", "origin", g.ref);
    head = g.head; base = g.base;
  } else {
    git(repo, "fetch", "-q", "origin", `pull/${n}/head:refs/bench/pr-${n}`, change.base);
    head = git(repo, "rev-parse", `refs/bench/pr-${n}`);
    base = git(repo, "merge-base", change.base, head);
  }
  const files = git(repo, "diff", "--name-status", "--no-renames", base, head).split("\n").filter(Boolean).map(l => l.split("\t"));
  const source = files.filter(([, f]) => !isTest(f));
  const tests = files.filter(([, f]) => isTest(f));
  // case/<id>: base plus the change's non-test files, as one commit.
  const wt = join(BENCH, "tests", "wt", id);
  mkdirSync(join(BENCH, "tests", "wt"), { recursive: true });
  if (existsSync(wt)) sh("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  git(repo, "worktree", "add", "-q", "--detach", wt, base);
  for (const [status, f] of source) {
    if (status === "D") sh("git", ["-C", wt, "rm", "-q", f]);
    else sh("git", ["-C", wt, "checkout", head, "--", f]);
  }
  sh("git", ["-C", wt, "-c", "user.name=bench", "-c", "user.email=bench@example.com", "commit", "-q", "-m", `${change.title}\n\n(The change under test; its tests are not included.)`]);
  const changeSha = git(wt, "rev-parse", "HEAD");
  git(repo, "branch", "-f", `case/${id}`, changeSha);
  sh("git", ["-C", repo, "worktree", "remove", "--force", wt]);

  mkdirSync(out, { recursive: true });
    // Diffs are written untrimmed: a trailing blank context line is part of the patch.
  const rawDiff = (...a) => execFileSync("git", ["-C", repo, "diff", "--no-renames", ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
  writeFileSync(join(out, "maintainer-tests.diff"), rawDiff(base, head, "--", ...tests.map(([, f]) => f)));
  writeFileSync(join(out, "source.diff"), rawDiff(base, changeSha));
  const body = (change.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  writeFileSync(join(out, "PR.md"), `# ${change.title}\n\n${body}\n`);
  const remarks = labelled.filter(u => u.project === project && String(u.change) === n && u.area === "tests")
    .map(u => ({ path: u.path, move: u.move, kind: u.kind, outcome: u.outcome, comment: u.comment, reply: u.replies.find(r => r.role === "author")?.body ?? "" }));
  writeFileSync(join(out, "remarks.json"), JSON.stringify(remarks, null, 1));
  writeFileSync(join(out, "case.json"), JSON.stringify({ id, key, project, repo, base, head, change: changeSha, branch: `case/${id}`, source: source.map(([s, f]) => `${s} ${f}`), tests: tests.map(([s, f]) => `${s} ${f}`) }, null, 1));
  console.error(`${id}: ${source.length} source files, ${tests.length} test files, ${remarks.length} test remarks`);
}

// Warm the module and build caches for the packages each change touches, so
// trials and scoring do not each download the world.
for (const key of CASES) {
  const id = key.replace(/[/#]/g, "-");
  const c = JSON.parse(readFileSync(join(BENCH, "tests", "cases", id, "case.json"), "utf8"));
  const wt = join(BENCH, "tests", "wt", `${id}-warm`);
  if (existsSync(wt)) continue;
  git(c.repo, "worktree", "add", "-q", "--detach", wt, c.change);
  const dirs = [...new Set(c.source.map(s => s.split(" ")[1]).filter(f => f.endsWith(".go")).map(f => f.replace(/\/[^/]+$/, "") || "."))];
  for (const d of dirs) {
    // Run inside the package directory: Go finds its module from there, which
    // matters in repositories with several modules (etcd, x/tools).
    try { sh("go", ["test", "-count=1", "-run", "^$", "."], { cwd: join(wt, d), env: goEnv(id), stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { console.error(`${id}: warm ${d} failed: ${String(e.stderr ?? e.message).slice(0, 300)}`); }
  }
  sh("git", ["-C", c.repo, "worktree", "remove", "--force", wt]);
  console.error(`${id}: warmed ${dirs.join(", ")}`);
}
