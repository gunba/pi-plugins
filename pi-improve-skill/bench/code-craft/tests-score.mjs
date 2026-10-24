#!/usr/bin/env node
// Score test-writing trials by running them, in a separate worktree per run:
//   with     the trial's tests on the change: pass three times in a row?
//   without  the same tests with the change's source reverted: does any fail?
//   hunks    each hunk of the change's source reverted on its own: does a test
//            fail (killed), fail to build (build), or still pass (survived)?
// The maintainers' own tests are scored the same way as a reference.
//
//   node tests-score.mjs --runs base,skill [--jobs 6] [--cases a,b]
//   -> $BENCH/tests/runs/<label>/<case>/score.json, $BENCH/tests/maintainers/<case>/score.json

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BENCH, goEnv } from "./go-env.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const RUNS = opt("runs", "").split(",").filter(Boolean);
const JOBS = Number(opt("jobs", 6));
const ONLY = opt("cases", null)?.split(",");
const casesDir = join(BENCH, "tests", "cases");
const isTest = f => /_test\.go$/.test(f) || /(^|\/)testdata\//.test(f);
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

// The trial's work: everything in the working tree that differs from the change.
function trialDiff(repo) {
  git(repo, "add", "-A", "-N");
  return git(repo, "diff", "--binary", "HEAD");
}

function splitDiff(diff) {
  const files = [];
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const m = part.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (m) files.push({ path: m[2], text: part });
  }
  return files;
}

// Test functions the diff adds or edits, as a -run pattern; run only those
// (all of the package's tests when none can be named). gRPC-Go writes tests
// as methods, `func (s) TestFoo`, which run as subtests Test/Foo.
function runPattern(diff) {
  const plain = new Set(), methods = new Set();
  const add = (recv, name) => (recv ? methods.add(name.replace(/^Test/, "")) : plain.add(name));
  for (const m of diff.matchAll(/^\+func (\(\w+\) )?(Test\w+|Fuzz\w+)\(/gm)) add(m[1], m[2]);
  for (const m of diff.matchAll(/^@@[^@]*@@ func (\([^)]*\) )?(Test\w+)\(/gm)) add(m[1], m[2]);
  if (plain.size && !methods.size) return `^(${[...plain].join("|")})$`;
  if (methods.size && !plain.size) return `^Test$/^(${[...methods].join("|")})$`;
  return plain.size && methods.size ? "." : null;
}

// pkgs: [{ dir, pattern }]. A null pattern means the package's changed test
// files hold no test of their own (helpers, test data for another package):
// it is only compiled.
function goTest(id, cwd, pkgs, count) {
  const out = [];
  let status = "pass";
  for (const { dir: d, pattern } of pkgs) {
    const attempt = pat => {
      const runArgs = ["test", `-count=${count}`, "-timeout", "240s", "-run", pat, "."];
      const r = spawnSync("go", runArgs, { cwd: join(cwd, d), env: goEnv(id), encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 26 });
      return { r, runArgs, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    };
    let { r, runArgs, text } = attempt(pattern ?? "^$");
    // A pattern that matches nothing proves nothing: run the whole package.
    if (pattern && /no tests to run/.test(text)) ({ r, runArgs, text } = attempt("."));
    out.push(`$ (cd ${d} && go ${runArgs.join(" ")})\n${text.slice(-3000)}`);
    if (r.status === 0) continue;
    const build = /\[build failed\]|\[setup failed\]|cannot find package|undefined: |^#\s/m.test(text) && !/^--- FAIL/m.test(text);
    status = build && status !== "fail" ? "build" : "fail";
  }
  return { status, log: out.join("\n") };
}

function hunksOf(sourceDiff) {
  const hunks = [];
  for (const f of splitDiff(sourceDiff)) {
    if (!f.path.endsWith(".go")) continue;
    const [header, ...rest] = f.text.split(/^(?=@@ )/m);
    for (const h of rest) {
      const changed = h.split("\n").slice(1).filter(l => /^[+-]/.test(l)).map(l => l.slice(1).trim());
      if (changed.every(l => l === "" || l.startsWith("//") || l.startsWith("/*") || l.startsWith("*"))) continue;
      hunks.push({ path: f.path, patch: header + h });
    }
  }
  return hunks;
}

function score(id, testsDiff, outDir) {
  const c = JSON.parse(readFileSync(join(casesDir, id, "case.json"), "utf8"));
  const files = splitDiff(testsDiff);
  const tests = files.filter(f => isTest(f.path));
  const nonTest = files.filter(f => !isTest(f.path)).map(f => f.path);
  const testPatch = tests.map(f => f.text).join("");
  // A package runs its own _test.go files; test data belongs to the package
  // above its testdata directory (Prometheus runs promqltest's data from promql).
  const TESTDATA_PKG = { "promql/promqltest": "promql" };
  const pkgOf = p => {
    if (p.endsWith("_test.go")) return dirname(p);
    const d = p.split("/testdata/")[0];
    return TESTDATA_PKG[d] ?? d;
  };
  const pkgDirs = [...new Set(tests.map(f => pkgOf(f.path)))];
  // Each package runs the tests its own changed files add or edit; test data
  // changes run the whole package that reads them.
  const pkgs = pkgDirs.map(dir => {
    const own = tests.filter(f => pkgOf(f.path) === dir);
    const pattern = runPattern(own.filter(f => f.path.endsWith("_test.go")).map(f => f.text).join(""));
    return { dir, pattern: pattern ?? (own.some(f => !f.path.endsWith("_test.go")) ? "." : null) };
  });
  const result = { id, testFiles: tests.map(f => f.path), nonTestFiles: nonTest, packages: pkgs,
    addedLines: (testPatch.match(/^\+(?!\+\+)/gm) ?? []).length };
  if (!pkgDirs.length) { writeFileSync(join(outDir, "score.json"), JSON.stringify({ ...result, with: "none" }, null, 1)); return result; }

  const wt = join(BENCH, "tests", "score-wt", `${outDir.split("/").slice(-2).join("-")}`);
  if (existsSync(wt)) { try { git(c.repo, "worktree", "remove", "--force", wt); } catch { rmSync(wt, { recursive: true, force: true }); } }
  mkdirSync(dirname(wt), { recursive: true });
  git(c.repo, "worktree", "add", "-q", "--detach", wt, c.change);
  const reset = () => { git(wt, "reset", "-q", "--hard", c.change); git(wt, "clean", "-qfd"); };
  const apply = (patch, ...flags) => {
    const r = spawnSync("git", ["-C", wt, "apply", "--whitespace=nowarn", ...flags], { input: patch, encoding: "utf8" });
    return r.status === 0;
  };
  const logs = [];
  reset();
  if (!apply(testPatch)) { result.with = "apply-failed"; }
  else {
    const w = goTest(id, wt, pkgs, 3); result.with = w.status; logs.push(`## with the change\n${w.log}`);
    // Without the change: the source files as they were at the base.
    reset(); apply(testPatch);
    for (const s of c.source) {
      const [status, f] = s.split(" ");
      if (status === "A") rmSync(join(wt, f), { force: true });
      else git(wt, "checkout", c.base, "--", f);
    }
    const wo = goTest(id, wt, pkgs, 1); result.without = wo.status; logs.push(`## without the change\n${wo.log}`);
    // One source hunk reverted at a time.
    const sourceDiff = readFileSync(join(casesDir, id, "source.diff"), "utf8");
    result.hunks = [];
    for (const h of hunksOf(sourceDiff)) {
      reset(); apply(testPatch);
      if (!apply(h.patch, "-R")) { result.hunks.push({ path: h.path, status: "unapplied" }); continue; }
      const r = goTest(id, wt, pkgs, 1);
      result.hunks.push({ path: h.path, status: r.status === "pass" ? "survived" : r.status === "build" ? "build" : "killed" });
    }
  }
  git(c.repo, "worktree", "remove", "--force", wt);
  writeFileSync(join(outDir, "score.json"), JSON.stringify(result, null, 1));
  writeFileSync(join(outDir, "score.log"), logs.join("\n\n"));
  return result;
}

// One job per process (scoring is synchronous); the coordinator runs JOBS at once.
const one = opt("one", null);
if (one) {
  const [label, id] = one.split(":");
  if (label === "maintainers") {
    const ref = join(BENCH, "tests", "maintainers", id);
    mkdirSync(ref, { recursive: true });
    score(id, readFileSync(join(casesDir, id, "maintainer-tests.diff"), "utf8"), ref);
  } else {
    const dir = join(BENCH, "tests", "runs", label, id);
    const diff = trialDiff(join(dir, "repo"));
    writeFileSync(join(dir, "trial.diff"), diff);
    score(id, diff, dir);
  }
  process.exit(0);
}

const cases = readdirSync(casesDir).filter(c => existsSync(join(casesDir, c, "case.json")) && (!ONLY || ONLY.includes(c)));
const jobs = [];
for (const id of cases) {
  if (!existsSync(join(BENCH, "tests", "maintainers", id, "score.json"))) jobs.push(`maintainers:${id}`);
  for (const label of RUNS) {
    const dir = join(BENCH, "tests", "runs", label, id);
    if (existsSync(join(dir, "done.json")) && !existsSync(join(dir, "score.json"))) jobs.push(`${label}:${id}`);
  }
}
const self = new URL(import.meta.url).pathname;
let done = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (jobs.length) {
    const job = jobs.shift();
    await new Promise(res => {
      const child = spawn(process.execPath, [self, "--one", job], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", d => { err += d; });
      child.on("close", code => {
        const [label, id] = job.split(":");
        const f = label === "maintainers" ? join(BENCH, "tests", "maintainers", id, "score.json") : join(BENCH, "tests", "runs", label, id, "score.json");
        const r = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
        console.error(`${++done} ${job}: ${r ? `with=${r.with} without=${r.without} hunks=${(r.hunks ?? []).map(h => h.status[0]).join("")}` : `failed (${code}) ${err.slice(-300)}`}`);
        res();
      });
    });
  }
}));
