#!/usr/bin/env node
// Mine reviewed pull requests from GitHub repositories with the GraphQL API.
// Stage 1 lists closed/merged PRs in a date window with cheap counts; stage 2
// fetches full review data for a random sample of eligible PRs. Each PR is
// cached as one JSON file, so reruns resume where they stopped.
//
//   node github.mjs [--per-repo 150] [--since 2025-04-01] [--until 2026-09-01] [repo ...]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, REPOS } from "./config.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const PER_REPO = Number(opt("per-repo", 150));
const SINCE = opt("since", "2025-04-01");
const UNTIL = opt("until", "2026-09-01");
const repos = args.length ? args : REPOS.github;
const token = process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

async function graphql(query, variables = {}, attempt = 0) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { errors: [{ message: text.slice(0, 200) }] }; }
  const limited = res.status === 403 || res.status === 429 || res.status >= 500
    || body.errors?.some(e => /rate limit|timeout|something went wrong/i.test(e.message));
  if (limited && attempt < 6) {
    const reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
    const wait = res.headers.get("x-ratelimit-remaining") === "0" && reset > Date.now()
      ? reset - Date.now() + 2000
      : res.status === 403 ? 60000 * (attempt + 1) : 3000 * 2 ** attempt;
    console.error(`  retry in ${Math.round(wait / 1000)}s: ${res.status} ${(body.errors?.[0]?.message ?? '').slice(0, 80)}`);
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
  comments(first:50){nodes{${ACTOR} authorAssociation body createdAt}}
  reviewThreads(first:60){totalCount nodes{ isResolved isOutdated path line originalLine startLine originalStartLine diffSide subjectType resolvedBy{login}
    comments(first:15){nodes{ id ${ACTOR} authorAssociation body createdAt diffHunk outdated url originalCommit{oid} commit{oid} replyTo{id} }} }}`;

function detailQuery(numbers) {
  const parts = numbers.map(n => `p${n}: pullRequest(number:${n}){${PR_FIELDS}}`).join("\n");
  return `query($owner:String!,$name:String!){ rateLimit{remaining resetAt cost} repository(owner:$owner,name:$name){ ${parts} } }`;
}

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

const integrated = pr => pr.state === "MERGED"
  || pr.labels.nodes.some(l => /^(integrated|merged)$/i.test(l.name));

// Half-month search slices sample the whole window evenly, including
// repositories that close thousands of PRs a month.
function slices() {
  const out = [];
  for (let d = new Date(`${SINCE}T00:00:00Z`); d < new Date(`${UNTIL}T00:00:00Z`);) {
    const a = d.toISOString().slice(0, 10);
    const mid = d.getUTCDate() === 1 ? 16 : null;
    const next = mid ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 16)) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const b = new Date(next - 86400000).toISOString().slice(0, 10);
    out.push(`${a}..${b}`);
    d = next;
  }
  return out;
}

const SEARCH = `query($q:String!){ rateLimit{remaining resetAt}
  search(query:$q,type:ISSUE,first:50){ nodes{ ... on PullRequest {
    number state createdAt additions deletions changedFiles author{login}
    reviewThreads{totalCount} reviews{totalCount} labels(first:15){nodes{name}} } } } }`;

async function listEligible(repo) {
  const cache = join(DATA_DIR, "github", repo.replace("/", "__"), "_list.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const found = new Map();
  for (const range of slices()) {
    const data = await graphql(SEARCH, { q: `repo:${repo} is:pr is:closed created:${range}` });
    for (const pr of data.search.nodes) {
      if (!pr.number) continue;
      found.set(pr.number, {
        number: pr.number, state: pr.state, integrated: integrated(pr), createdAt: pr.createdAt,
        size: pr.additions + pr.deletions, files: pr.changedFiles, threads: pr.reviewThreads.totalCount,
        reviews: pr.reviews.totalCount, author: pr.author?.login ?? null,
      });
    }
  }
  mkdirSync(join(DATA_DIR, "github", repo.replace("/", "__")), { recursive: true });
  writeFileSync(cache, JSON.stringify([...found.values()]));
  return [...found.values()];
}

async function mineRepo(repo) {
  const [owner, name] = repo.split("/");
  const dir = join(DATA_DIR, "github", repo.replace("/", "__"));
  const all = await listEligible(repo);
  // Reviewable changes with real line-level review. Closed-but-unintegrated
  // PRs are kept: rejected approaches carry some of the best review.
  const eligible = all.filter(p => p.threads >= 3 && p.size <= 3000 && p.files <= 40 && p.files >= 1);
  const pick = shuffle(eligible, 7).slice(0, PER_REPO);
  const todo = pick.filter(p => !existsSync(join(dir, `${p.number}.json`)));
  console.error(`${repo}: ${all.length} in window, ${eligible.length} eligible, ${pick.length} picked, ${todo.length} to fetch`);
  for (let i = 0; i < todo.length; i += 1) {
    const batch = todo.slice(i, i + 1).map(p => p.number);
    let data;
    try {
      data = await graphql(detailQuery(batch), { owner, name });
    } catch (error) {
      // A batch can exceed GitHub's response limits; fall back to one PR at a time.
      for (const n of batch) {
        try {
          const one = await graphql(detailQuery([n]), { owner, name });
          writeFileSync(join(dir, `${n}.json`), JSON.stringify({ repo, ...one.repository[`p${n}`] }));
        } catch (e) { console.error(`  ${repo}#${n} failed: ${e.message.slice(0, 200)}`); }
      }
      continue;
    }
    for (const n of batch) {
      const pr = data.repository[`p${n}`];
      if (pr) writeFileSync(join(dir, `${n}.json`), JSON.stringify({ repo, ...pr }));
    }
  }
}

const queue = [...repos];
const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
  while (queue.length) {
    const repo = queue.shift();
    try { await mineRepo(repo); } catch (e) { console.error(`${repo} failed: ${e.message}`); }
  }
});
await Promise.all(workers);
console.error("done");
