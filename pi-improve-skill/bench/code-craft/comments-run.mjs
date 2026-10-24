#!/usr/bin/env node
// Run headless pi trials over the code-comments cases: each trial gets its own
// worktree of the pull request at the commit a maintainer reviewed, and checks
// and fixes the change's comments before review.
//
//   node comments-run.mjs --label base --model openai-codex/gpt-6.1-sol --thinking high [--skill DIR] [--jobs 6] [--cases a,b]
//
// Finished trials are skipped. A compact trace of tool calls goes to
// trace.jsonl, the agent's last message to final.md.

import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BENCH } from "./go-env.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const LABEL = opt("label");
const MODEL = opt("model", "openai-codex/gpt-6.1-sol");
const THINKING = opt("thinking", "high");
const SKILL = opt("skill", null) && resolve(opt("skill"));
const JOBS = Number(opt("jobs", 6));
const ONLY = opt("cases", null)?.split(",");
if (!LABEL) throw new Error("--label is required");

const AUTH_EXT = join(homedir(), ".pi/agent/git/github.com/gunba/pi-plugins/node_modules/@gotgenes/pi-anthropic-auth/src/index.ts");
export const PROMPT = `repo/ is a repository checked out at a pull request that is about to go to the project's maintainers for review. PR.md describes it; the change is \`git -C repo diff BASE HEAD\`, where BASE is in BASE.txt. Before it goes out, check the comments and doc comments in this change and fix what needs fixing, the way the project's maintainers would expect. Change only comments and doc comments, not code, and do not commit; leave your edits in the working tree.

When you finish, write COMMENTS.md next to PR.md listing each edit you made and why.`;

const casesDir = join(BENCH, "comments", "cases");
const cases = readdirSync(casesDir).filter(c => existsSync(join(casesDir, c, "case.json")) && (!ONLY || ONLY.includes(c)));
const outRoot = join(BENCH, "comments", "runs", LABEL);
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, "config.json"), JSON.stringify({ model: MODEL, thinking: THINKING, skill: SKILL, prompt: PROMPT }, null, 1));

function runOne(id) {
  const dir = join(outRoot, id);
  if (existsSync(join(dir, "done.json"))) return Promise.resolve("skip");
  const c = JSON.parse(readFileSync(join(casesDir, id, "case.json"), "utf8"));
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(casesDir, id, "PR.md"), join(dir, "PR.md"));
  writeFileSync(join(dir, "BASE.txt"), `${c.base}\n`);
  const repo = join(dir, "repo");
  if (!existsSync(repo)) execFileSync("git", ["-C", c.repo, "worktree", "add", "-q", "--detach", repo, c.commit]);
  const piArgs = ["-p", "--mode", "json", "--no-session", "--no-extensions", "-e", AUTH_EXT, "--no-mcp", "--no-prompt-templates", "--no-skills",
    "--model", MODEL, "--thinking", THINKING];
  if (SKILL) piArgs.push("--skill", SKILL);
  piArgs.push(PROMPT);
  const started = Date.now();
  return new Promise(done => {
    const child = spawn("pi", piArgs, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let buf = "", final = "", err = "";
    const usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
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
          const text = (e.message.content ?? []).filter(x => x.type === "text").map(x => x.text).join("\n");
          if (text) final = text;
          if (e.message.errorMessage) appendFileSync(join(dir, "trace.jsonl"), JSON.stringify({ error: e.message.errorMessage }) + "\n");
        }
      }
    });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => {
      if (final) writeFileSync(join(dir, "final.md"), final);
      writeFileSync(join(dir, "done.json"), JSON.stringify({ code, seconds: Math.round((Date.now() - started) / 1000), usage, stderr: err.slice(-2000) }, null, 1));
      done(code);
    });
  });
}

const queue = [...cases];
let finished = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (queue.length) {
    const id = queue.shift();
    const r = await runOne(id);
    console.error(`[${LABEL}] ${++finished}/${cases.length} ${id}: ${r}`);
  }
}));
