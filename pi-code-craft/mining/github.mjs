#!/usr/bin/env node
// Mine reviewed pull requests from GitHub with the GraphQL API. Stage 1 lists
// closed PRs in a date window with cheap counts; stage 2 fetches full review
// data for a random sample of eligible PRs. Each PR is cached as one JSON file
// (PRs already in the code-review corpus are not fetched again), so reruns
// resume where they stopped.
//
//   node github.mjs [--review 350] [--added 250] [--agents 250] [--since 2025-04-01] [--until 2026-09-01] [--only review|added|agents]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, GITHUB, REUSE_DIR } from "./config.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const PER = { review: Number(opt("review", 350)), added: Number(opt("added", 250)), agents: Number(opt("agents", 250)) };
const SINCE = opt("since", "2025-04-01");
const UNTIL = opt("until", "2026-09-01");
const ONLY = opt("only", null);
const token = process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

async function graphql(query, variables = {}, attempt = 0) {
  let res, text;
  try {
    res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    text = await res.text();
  } catch (e) {
    if (attempt < 6) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); return graphql(query, variables, attempt + 1); }
    throw e;
  }
  let body;
  try { body = JSON.parse(text); } catch { body = { errors: [{ message: text.slice(0, 200) }] }; }
  const limited = res.status === 403 || res.status === 429 || res.status >= 500
    || body.errors?.some(e => /rate limit|timeout|something went wrong/i.test(e.message));
  if (limited && attempt < 8) {
    const reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
    const wait = res.headers.get("x-ratelimit-remaining") === "0" && reset > Date.now()
      ? reset - Date.now() + 2000
      : res.status === 403 || res.status === 429 ? 60000 * (attempt + 1) : 3000 * 2 ** attempt;
    console.error(`  retry in ${Math.round(wait / 1000)}s: ${res.status} ${(body.errors?.[0]?.message ?? "").slice(0, 80)}`);
    await new Promise(r => setTimeout(r, wait));
    return graphql(query, variables, attempt + 1);
  }
  if (body.errors && !body.data) throw new Error(body.errors.map(e => e.message).join("; "));
  return body.data;
}

const ACTOR = "author{login __typename}";
const PR_FIELDS = `number title body url state createdAt mergedAt closedAt additions deletions changedFiles
  ${ACTOR} authorAssociation baseRefName baseRefOid headRefOid
  labels(first:20){nodes{name}}
  files(first:100){nodes{path additions deletions}}
  commits(first:1){totalCount}
  reviews(first:40){nodes{${ACTOR} authorAssociation state body submittedAt commit{oid}}}
  comments(first:60){nodes{${ACTOR} authorAssociation body createdAt}}
  reviewThreads(first:80){totalCount nodes{ isResolved isOutdated path line originalLine startLine originalStartLine diffSide subjectType resolvedBy{login}
    comments(first:15){nodes{ id ${ACTOR} authorAssociation body createdAt diffHunk outdated url originalCommit{oid} commit{oid} replyTo{id} }} }}`;

const detailQuery = n => `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ p: pullRequest(number:${n}){${PR_FIELDS}} } }`;

function shuffle(items, seed) {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const integrated = pr => pr.state === "MERGED" || pr.labels.nodes.some(l => /^(integrated|merged)$/i.test(l.name));

// Half-month slices sample the whole window evenly, including repositories
// that close thousands of PRs a month.
function slices() {
  const out = [];
  for (let d = new Date(`${SINCE}T00:00:00Z`); d < new Date(`${UNTIL}T00:00:00Z`);) {
    const a = d.toISOString().slice(0, 10);
    const next = d.getUTCDate() === 1 ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 16)) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    out.push(`${a}..${new Date(next - 86400000).toISOString().slice(0, 10)}`);
    d = next;
  }
  return out;
}

const SEARCH = `query($q:String!,$after:String){ search(query:$q,type:ISSUE,first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{ ... on PullRequest {
    number state createdAt additions deletions changedFiles author{login} repository{nameWithOwner}
    reviewThreads{totalCount} reviews{totalCount} labels(first:15){nodes{name}} } } } }`;

async function search(q, maxPages) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(SEARCH, { q, after });
    for (const pr of data.search.nodes) {
      if (!pr.number) continue;
      out.push({
        repo: pr.repository.nameWithOwner, number: pr.number, state: pr.state, integrated: integrated(pr), createdAt: pr.createdAt,
        size: pr.additions + pr.deletions, files: pr.changedFiles, threads: pr.reviewThreads.totalCount,
        reviews: pr.reviews.totalCount, author: pr.author?.login ?? null,
      });
    }
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return out;
}

const repoDir = (root, repo) => join(root, "github", repo.replace("/", "__"));
const cached = (repo, n) => existsSync(join(repoDir(DATA_DIR, repo), `${n}.json`)) || existsSync(join(repoDir(REUSE_DIR, repo), `${n}.json`));

async function listRepo(repo) {
  for (const root of [DATA_DIR, REUSE_DIR]) {
    const file = join(repoDir(root, repo), "_list.json");
    if (existsSync(file)) {
      const list = JSON.parse(readFileSync(file, "utf8"));
      if (list.length) return list;
    }
  }
  const found = new Map();
  for (const range of slices()) {
    for (const pr of await search(`repo:${repo} is:pr is:closed created:${range}`, 2)) found.set(pr.number, pr);
  }
  mkdirSync(repoDir(DATA_DIR, repo), { recursive: true });
  writeFileSync(join(repoDir(DATA_DIR, repo), "_list.json"), JSON.stringify([...found.values()]));
  return [...found.values()];
}

async function fetchPr(repo, n, extra = {}) {
  if (cached(repo, n)) return;
  const [owner, name] = repo.split("/");
  try {
    const data = await graphql(detailQuery(n), { owner, name });
    const pr = data.repository?.p;
    if (!pr) return;
    mkdirSync(repoDir(DATA_DIR, repo), { recursive: true });
    writeFileSync(join(repoDir(DATA_DIR, repo), `${n}.json`), JSON.stringify({ repo, ...extra, ...pr }));
  } catch (e) { console.error(`  ${repo}#${n} failed: ${e.message.slice(0, 200)}`); }
}

// Fetch a job's PRs a few at a time; GitHub allows far more concurrent
// requests than one worker sends one by one.
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); }));
}

const eligible = (p, minThreads) => p.threads >= minThreads && p.size <= 3000 && p.files <= 40 && p.files >= 1;

async function mineRepo(repo, per) {
  const list = await listRepo(repo);
  const pick = shuffle(list.filter(p => eligible(p, 3)), 7).slice(0, per);
  const todo = pick.filter(p => !cached(repo, p.number));
  console.error(`${repo}: ${list.length} listed, ${pick.length} picked, ${todo.length} to fetch`);
  await pool(todo, 4, p => fetchPr(repo, p.number));
}

// Agent-authored PRs: listed per query (month slices), tagged with the agent.
async function listAgents(spec) {
  const key = `${spec.tag}${spec.repo ? `-${spec.repo.replace("/", "__")}` : ""}`;
  const file = join(DATA_DIR, "github", "_agents", `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const scopes = spec.repo ? [`repo:${spec.repo}`] : (() => {
    const all = [...GITHUB.review, ...GITHUB.added];
    const groups = [];
    for (let i = 0; i < all.length; i += 7) groups.push(all.slice(i, i + 7).map(r => `repo:${r}`).join(" "));
    return groups;
  })();
  const found = new Map();
  for (const scope of scopes) {
    for (const range of slices()) {
      for (const pr of await search(`${scope} is:pr is:closed ${spec.q} created:${range}`, 3)) found.set(`${pr.repo}#${pr.number}`, { ...pr, agent: spec.tag });
    }
  }
  mkdirSync(join(DATA_DIR, "github", "_agents"), { recursive: true });
  writeFileSync(file, JSON.stringify([...found.values()]));
  return [...found.values()];
}

async function mineAgents(spec, per) {
  const list = await listAgents(spec);
  const pick = shuffle(list.filter(p => eligible(p, 2)), 13).slice(0, per);
  const todo = pick.filter(p => !cached(p.repo, p.number));
  console.error(`${spec.tag} ${spec.repo ?? "(top projects)"}: ${list.length} listed, ${pick.length} picked, ${todo.length} to fetch`);
  await pool(todo, 4, p => fetchPr(p.repo, p.number, { agent: spec.tag }));
}

const jobs = [];
if (!ONLY || ONLY === "agents") for (const spec of GITHUB.agents) jobs.push(() => mineAgents(spec, spec.repo ? PER.agents : PER.agents * 2));
if (!ONLY || ONLY === "added") for (const repo of GITHUB.added) jobs.push(() => mineRepo(repo, PER.added));
if (!ONLY || ONLY === "review") for (const repo of GITHUB.review) jobs.push(() => mineRepo(repo, PER.review));
const workers = Array.from({ length: Math.min(6, jobs.length) }, async () => {
  while (jobs.length) {
    const job = jobs.shift();
    try { await job(); } catch (e) { console.error(`job failed: ${e.message}`); }
  }
});
await Promise.all(workers);
console.error("done");
