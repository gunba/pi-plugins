#!/usr/bin/env node
// Join units with their Jev labels, settle roles and outcomes, split changes
// into train and holdout, and write:
//   skills/code-review/references/exemplars.jsonl  high-value reviews (train only)
//   skills/code-review/references/rejected.jsonl   comments authors rejected, with the rebuttal
//   $DATA_DIR/labelled.jsonl                       every unit with final labels (analysis, benchmark)
//   $DATA_DIR/stats.json                           the tables the skill's numbers come from
//
//   node build.mjs

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DATA_DIR } from "./config.mjs";

// The skill lives in Pi's skills folder, which Desk mirrors to the user's other computers.
const REFS = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "skills", "code-review", "references");

function readLabels(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (line.trim()) { const o = JSON.parse(line); out.set(o.id, o); }
    }
  }
  return out;
}
const labels = readLabels(join(DATA_DIR, "jev", "out"));
const moves = readLabels(join(DATA_DIR, "jev", "moves-out"));
const units = readFileSync(join(DATA_DIR, "units.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));

const DONE = /^\s*(done|fixed|ack|acknowledged|good catch|changed|updated|applied|will fix|will do|addressed)\b/i;
const AI_REVIEWERS = /^(copilot-pull-request-reviewer|chatgpt-codex-connector|gemini-code-assist|coderabbitai|claude|cursor)$|bpf-ci/i;
const holdout = u => parseInt(createHash("sha1").update(`${u.source}|${u.project}|${u.change}`).digest("hex").slice(0, 8), 16) % 100 < 15;

const labelled = [];
for (const u of units) {
  const j = labels.get(u.id);
  if (!j) continue;
  u.commenter ??= "unknown";
  // Metadata decides authorship on GitHub and Gerrit; Jev catches automation
  // (bots, AI reviewers, humans typing bot commands) and, on mailing lists,
  // authors writing from another address.
  let role = "reviewer";
  if (u.commenter_role === "author") role = "author";
  else if (u.commenter_role === "bot" || (j.speaker === "automation" && (j.speaker_p.automation ?? 0) >= 0.6)) role = "automation";
  else if (u.source === "lore" && j.speaker === "author" && (j.speaker_p.author ?? 0) >= 0.8) role = "author";
  const ai = AI_REVIEWERS.test(u.commenter) || (u.commenter === "github-actions" && u.comment.startsWith("Claude:"));
  let outcome = j.outcome;
  if (outcome === "unknown") {
    if (u.replies.some(r => r.role === "author" && DONE.test(r.body ?? ""))) outcome = "accepted";
    else if (u.source === "github" && u.signals.outdated && u.signals.resolved) outcome = "likely_accepted";
  }
  const accepted = outcome === "accepted" || outcome === "likely_accepted";
  // Kernel authors usually answer review with a new version rather than a reply.
  const landed = accepted || (u.source === "lore" && outcome === "unknown" && u.signals.later_version === true);
  const m = moves.get(u.id);
  const highValue = role === "reviewer" && ["finding", "suggestion", "question"].includes(j.kind)
    && j.depth >= 2 && j.severity >= 1.5 && j.concrete >= 0.6 && landed;
  labelled.push({
    ...u, role, ai, outcome, accepted, landed, high_value: highValue, split: holdout(u) ? "holdout" : "train",
    kind: j.kind, topic: j.topic, depth: j.depth, severity: j.severity, concrete: j.concrete,
    proposes_fix: j.proposes_fix, beyond_diff: j.beyond_diff, move: m?.move ?? null,
  });
}
writeFileSync(join(DATA_DIR, "labelled.jsonl"), labelled.map(u => JSON.stringify(u)).join("\n") + "\n");

// ---------- stats ----------
const count = (items, key) => items.reduce((acc, x) => { const k = key(x); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const pct = (n, d) => Math.round((n / Math.max(1, d)) * 1000) / 10;
const train = labelled.filter(u => u.split === "train");
const humans = train.filter(u => u.role === "reviewer");
const substantive = humans.filter(u => ["finding", "suggestion", "question"].includes(u.kind));
const hv = substantive.filter(u => u.high_value);
const known = items => items.filter(u => u.outcome !== "unknown");
const rate = (items, pred) => { const k = known(items); return pct(k.filter(pred).length, k.length); };
const deepHumans = humans.filter(u => u.move);
const stats = {
  corpus: {
    changes: new Set(labelled.map(u => `${u.source}|${u.project}|${u.change}`)).size,
    units: labelled.length, projects: new Set(labelled.map(u => u.project)).size,
    by_source: count(labelled, u => u.source), by_role: count(labelled, u => u.role),
    train_reviewer_units: humans.length, substantive: substantive.length, high_value: hv.length,
  },
  kinds: Object.fromEntries(["finding", "suggestion", "question", "nit", "ack", "process"].map(k => {
    const g = humans.filter(u => u.kind === k);
    return [k, { share: pct(g.length, humans.length), accepted: rate(g, u => u.accepted), rejected: rate(g, u => u.outcome === "rejected"), explained: rate(g, u => u.outcome === "explained") }];
  })),
  topics: Object.fromEntries(Object.keys(count(substantive, u => u.topic)).map(t => {
    const g = substantive.filter(u => u.topic === t);
    return [t, { share: pct(g.length, substantive.length), high_value_share: pct(hv.filter(u => u.topic === t).length, hv.length), accepted: rate(g, u => u.accepted), rejected: rate(g, u => u.outcome === "rejected") }];
  })),
  moves: Object.fromEntries(Object.keys(count(deepHumans, u => u.move)).map(m => {
    const g = deepHumans.filter(u => u.move === m);
    const h = hv.filter(u => u.move === m).length;
    const share = pct(g.length, deepHumans.length);
    const hvShare = pct(h, hv.filter(u => u.move).length);
    return [m, { share, high_value_share: hvShare, lift: Math.round((hvShare / Math.max(0.01, share)) * 100) / 100, accepted: rate(g, u => u.accepted), rejected: rate(g, u => u.outcome === "rejected") }];
  })),
  context: {
    high_value_beyond_diff: pct(hv.filter(u => u.beyond_diff >= 0.5).length, hv.length),
    substantive_beyond_diff: pct(substantive.filter(u => u.beyond_diff >= 0.5).length, substantive.length),
    high_value_concrete: pct(hv.filter(u => u.concrete >= 0.5).length, hv.length),
    substantive_concrete: pct(substantive.filter(u => u.concrete >= 0.5).length, substantive.length),
    high_value_proposes_fix: pct(hv.filter(u => u.proposes_fix >= 0.5).length, hv.length),
  },
  ai_vs_humans: (() => {
    const out = {};
    const aiUnits = labelled.filter(u => u.ai && ["finding", "suggestion", "question", "nit"].includes(u.kind));
    for (const [name, g] of Object.entries(Object.groupBy(aiUnits, u => u.commenter.replace(/^github-actions$/, "claude (systemd)")))) {
      const projects = new Set(g.map(u => u.project));
      const peers = labelled.filter(u => u.role === "reviewer" && !u.ai && projects.has(u.project) && ["finding", "suggestion", "question", "nit"].includes(u.kind) && u.scope !== "general");
      out[name] = {
        n: g.length, rejected: rate(g, u => u.outcome === "rejected"), peers_rejected: rate(peers, u => u.outcome === "rejected"),
        question_share: pct(g.filter(u => u.kind === "question").length, g.length), peers_question_share: pct(peers.filter(u => u.kind === "question").length, peers.length),
        design_share: pct(g.filter(u => u.topic === "design").length, g.length), peers_design_share: pct(peers.filter(u => u.topic === "design").length, peers.length),
      };
    }
    return out;
  })(),
};
writeFileSync(join(DATA_DIR, "stats.json"), JSON.stringify(stats, null, 1));

// ---------- reference pool ----------
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");
// Comments that instruct an AI assistant (or quote an injection payload) would
// read as instructions to the agent that later prints them.
const ADDRESSES_AI = /@(copilot|claude|codex|gemini|coderabbitai|cursor)\b|ignore (all|everything|any) (previous|above|prior)/i;
// Human accounts relaying an AI reviewer's analysis (netdev's AI review
// format, "robot voice", "Codex is saying") are not examples of human review.
const RELAYS_AI = /^\s*\[Severity:|robot voice|AI review|\b(codex|claude|copilot|gemini|chatgpt|llm) (is saying|says|points out|found|suggests)|mix of my head and claude/i;
const quotedShare = s => { const ls = s.split("\n").filter(l => l.trim()); return ls.filter(l => /^\s*>/.test(l)).length / Math.max(1, ls.length); };
const reviewerName = s => s.replace(/<[^>]+>/, "").replace(/"/g, "").trim();
const exemplar = u => ({
  id: u.id, project: u.project, url: u.url, language: u.language ?? (u.source === "lore" ? "C" : null), path: u.path,
  move: u.move, topic: u.topic, kind: u.kind, depth: u.depth, severity: u.severity, reviewer: reviewerName(u.commenter),
  context: clip(u.hunk.split("\n").slice(-14).join("\n"), 1200), comment: clip(u.comment, 1400),
  reply: clip(u.replies.find(r => r.role === "author")?.body ?? "", 400), outcome: u.outcome,
});
const pool = hv
  .filter(u => u.comment.length >= 60 && quotedShare(u.comment) < 0.5 && !ADDRESSES_AI.test(u.comment) && !RELAYS_AI.test(u.comment))
  .sort((a, b) => (b.depth + b.severity) - (a.depth + a.severity))
  .map(exemplar);
writeFileSync(join(REFS, "exemplars.jsonl"), pool.map(e => JSON.stringify(e)).join("\n") + "\n");

const rejected = train
  .filter(u => (u.role === "reviewer" || u.ai) && u.outcome === "rejected" && ["finding", "suggestion"].includes(u.kind)
    && u.replies.some(r => r.role === "author" && (r.body ?? "").length >= 20) && u.comment.length >= 60 && !ADDRESSES_AI.test(u.comment))
  .map(u => ({ ...exemplar(u), ai: u.ai }));
writeFileSync(join(REFS, "rejected.jsonl"), rejected.map(e => JSON.stringify(e)).join("\n") + "\n");

console.log(`${labelled.length} labelled units; ${pool.length} exemplars; ${rejected.length} rejected comments`);
console.log(JSON.stringify(stats.corpus));
