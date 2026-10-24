#!/usr/bin/env node
// Run headless pi reviews over the benchmark cases.
//
//   node run.mjs --label sonnet-baseline --model anthropic/claude-sonnet-5-5 --thinking high [--skill DIR] [--jobs 6] [--cases a,b]
//
// Each run gets a fresh working folder (<run>/w) with PR.md, change.diff and a
// symlink to the case's repository, and writes review.md there; a review an
// agent writes one level up (after a stray `cd ..`) stays inside <run>. A
// compact trace of tool calls and usage goes to trace.jsonl. Finished runs
// are skipped.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, copyFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../../mining/code-review/config.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const LABEL = opt("label");
const MODEL = opt("model", "anthropic/claude-sonnet-5-5");
const THINKING = opt("thinking", "high");
const SKILL = opt("skill", null);
const JOBS = Number(opt("jobs", 6));
const ONLY = opt("cases", null)?.split(",");
if (!LABEL) throw new Error("--label is required");

const BENCH = join(DATA_DIR, "bench");
const AUTH_EXT = join(homedir(), ".pi/agent/git/github.com/gunba/pi-plugins/node_modules/@gotgenes/pi-anthropic-auth/src/index.ts");
export const PROMPT = `Review the pull request in this directory. PR.md has its title and description, change.diff is the change (from git tag BASE to HEAD), and repo/ is the repository at HEAD. repo/ is a sparse, partial clone: read files outside the checked-out directories with \`git -C repo show HEAD:<path>\`, search with \`git -C repo grep <pattern> HEAD -- <pathspec>\`, and see a file before the change with \`git -C repo show BASE:<path>\`. Do not modify repo/.

Write your review to review.md: each issue you would raise with the author as a separate numbered item, with its file and line.`;

const cases = readdirSync(join(BENCH, "cases")).filter(c => existsSync(join(BENCH, "cases", c, "case.json")) && (!ONLY || ONLY.includes(c)));
const outRoot = join(BENCH, "runs", LABEL);
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, "config.json"), JSON.stringify({ model: MODEL, thinking: THINKING, skill: SKILL, prompt: PROMPT }, null, 1));

function runOne(id) {
  const dir = join(outRoot, id);
  if (existsSync(join(dir, "done.json"))) return Promise.resolve("skip");
  const work = join(dir, "w");
  mkdirSync(work, { recursive: true });
  const src = join(BENCH, "cases", id);
  copyFileSync(join(src, "PR.md"), join(work, "PR.md"));
  copyFileSync(join(src, "change.diff"), join(work, "change.diff"));
  if (!existsSync(join(work, "repo"))) symlinkSync(join(src, "repo"), join(work, "repo"));
  const piArgs = ["-p", "--mode", "json", "--no-session", "--no-extensions", "-e", AUTH_EXT, "--no-mcp", "--no-prompt-templates", "--no-skills",
    "--model", MODEL, "--thinking", THINKING];
  if (SKILL) piArgs.push("--skill", SKILL);
  piArgs.push(PROMPT);
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn("pi", piArgs, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
    let final = "";
    child.stdout.on("data", d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "tool_execution_start") appendFileSync(join(dir, "trace.jsonl"), JSON.stringify({ t: Date.now() - started, tool: e.toolName, args: e.args }) + "\n");
        if (e.type === "message_end" && e.message?.role === "assistant") {
          const u = e.message.usage ?? {};
          usage.input += u.input ?? 0; usage.output += u.output ?? 0; usage.cacheRead += u.cacheRead ?? 0; usage.cost += u.cost?.total ?? 0;
          const text = (e.message.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
          if (text) final = text;
          if (e.message.errorMessage) appendFileSync(join(dir, "trace.jsonl"), JSON.stringify({ error: e.message.errorMessage }) + "\n");
        }
      }
    });
    let err = "";
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => {
      if (final) writeFileSync(join(dir, "final.md"), final);
      writeFileSync(join(dir, "done.json"), JSON.stringify({ code, seconds: Math.round((Date.now() - started) / 1000), usage, final: final.slice(0, 2000), stderr: err.slice(-2000) }, null, 1));
      resolve(code);
    });
  });
}

const queue = [...cases];
let finished = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (queue.length) {
    const id = queue.shift();
    const r = await runOne(id);
    finished++;
    console.error(`[${LABEL}] ${finished}/${cases.length} ${id}: ${r}`);
  }
}));
