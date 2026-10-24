#!/usr/bin/env node
// Join units with their Jev labels, settle outcomes, split changes into train
// and holdout, and write:
//   skills/test-writing/references/exemplars.jsonl    high-value test reviews (train only)
//   skills/test-writing/references/agents.jsonl       test reviews of agent-written changes (train only)
//   skills/test-writing/references/rejected.jsonl     test remarks authors declined, with the reply
//   skills/code-comments/references/exemplars.jsonl   high-value comment reviews (train only)
//   skills/code-comments/references/rejected.jsonl    comment remarks authors declined, with the reply
//   $DATA_DIR/labelled.jsonl                          every test or comment unit with final labels
//   $DATA_DIR/stats.json                              the tables the skills' numbers come from
//
//   node build.mjs

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DATA_DIR } from "./config.mjs";

// The skills live in Pi's skills folder, which Desk mirrors to the user's other computers.
const SKILLS = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "skills");
const REFS = { tests: join(SKILLS, "test-writing", "references"), comments: join(SKILLS, "code-comments", "references") };

function readLabels(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) if (line.trim()) { const o = JSON.parse(line); out.set(o.id, o); }
  return out;
}
const base = readLabels(join(DATA_DIR, "jev", "out"));
const testMoves = readLabels(join(DATA_DIR, "jev", "tests-out"));
const commentMoves = readLabels(join(DATA_DIR, "jev", "comments-out"));
const rebuttals = readLabels(join(DATA_DIR, "jev", "rebuttal-out"));
const units = readFileSync(join(DATA_DIR, "units.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));

const DONE = /^\s*(done|fixed|ack|acknowledged|good catch|changed|updated|applied|will fix|will do|addressed|added|removed)\b/i;
const holdout = u => parseInt(createHash("sha1").update(`${u.source}|${u.project}|${u.change}`).digest("hex").slice(0, 8), 16) % 100 < 15;
const SUBSTANTIVE = ["finding", "suggestion", "question"];

const labelled = [];
for (const u of units) {
  const j = base.get(u.id);
  if (!j) continue;
  const m = testMoves.get(u.id) ?? commentMoves.get(u.id);
  if (!m) continue;
  if (!(j.speaker === "reviewer" && (j.speaker_p.reviewer ?? 0) >= 0.5)) continue;
  let outcome = j.outcome;
  if (outcome === "unknown") {
    if (u.replies.some(r => r.role === "author" && DONE.test(r.body ?? ""))) outcome = "accepted";
    else if (u.source === "github" && u.signals.outdated && u.signals.resolved) outcome = "likely_accepted";
    else if (u.source === "gerrit" && u.signals.resolved && u.signals.later_patchsets) outcome = "likely_accepted";
  }
  const accepted = outcome === "accepted" || outcome === "likely_accepted";
  // Kernel authors usually answer review with a new version rather than a reply.
  const landed = accepted || (u.source === "lore" && outcome === "unknown" && u.signals.later_version === true);
  const area = testMoves.has(u.id) ? "tests" : "comments";
  const highValue = SUBSTANTIVE.includes(j.kind) && landed && j.depth >= 1.5 && j.concrete >= 0.6
    && j.severity >= (area === "tests" ? 1.5 : 1.2);
  labelled.push({
    ...u, area, subject: j.subject, kind: j.kind, depth: j.depth, severity: j.severity, concrete: j.concrete,
    outcome, accepted, landed, high_value: highValue, move: m.move, move_p: m.move_p[m.move] ?? null,
    rejection: rebuttals.get(u.id)?.reason ?? null, split: holdout(u) ? "holdout" : "train",
  });
}
writeFileSync(join(DATA_DIR, "labelled.jsonl"), labelled.map(u => JSON.stringify(u)).join("\n") + "\n");

// ---------- stats ----------
const count = (items, key) => items.reduce((acc, x) => { const k = key(x); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const pct = (n, d) => Math.round((n / Math.max(1, d)) * 1000) / 10;
const known = items => items.filter(u => u.outcome !== "unknown");
const rate = (items, pred) => { const k = known(items); return pct(k.filter(pred).length, k.length); };
const train = labelled.filter(u => u.split === "train");
const AGENTS = ["copilot", "claude-code"];

function moveTable(items) {
  const hv = items.filter(u => u.high_value);
  return Object.fromEntries(Object.entries(count(items, u => u.move)).sort((a, b) => b[1] - a[1]).map(([m, n]) => {
    const g = items.filter(u => u.move === m);
    const share = pct(n, items.length), hvShare = pct(hv.filter(u => u.move === m).length, hv.length);
    return [m, { n, share, high_value_share: hvShare, lift: Math.round((hvShare / Math.max(0.1, share)) * 100) / 100, landed: rate(g, u => u.landed), rejected: rate(g, u => u.outcome === "rejected") }];
  }));
}

// Agent-written changes against people's changes in the same projects, so the
// comparison is not a comparison of projects.
function agentsVsPeople(area) {
  const items = train.filter(u => u.area === area && (SUBSTANTIVE.includes(u.kind) || u.kind === "nit"));
  const agentProjects = new Set(items.filter(u => AGENTS.includes(u.agent)).map(u => u.project));
  const peopleProjects = new Set(items.filter(u => !u.agent).map(u => u.project));
  const shared = [...agentProjects].filter(p => peopleProjects.has(p));
  const ag = items.filter(u => AGENTS.includes(u.agent) && shared.includes(u.project));
  const pe = items.filter(u => !u.agent && shared.includes(u.project));
  const changesOf = (pred) => {
    const all = new Set(units.filter(u => shared.includes(u.project) && pred(u)).map(u => `${u.project}#${u.change}`));
    const withArea = new Set(items.filter(u => shared.includes(u.project) && pred(u)).map(u => `${u.project}#${u.change}`));
    return { reviewed_changes: all.size, with_remarks: withArea.size, remarks_per_change: Math.round((items.filter(u => shared.includes(u.project) && pred(u)).length / Math.max(1, all.size)) * 100) / 100 };
  };
  // Shares count changes, not remarks: one busy PR must not decide a row.
  const key = u => `${u.project}#${u.change}`;
  const agChanges = new Set(ag.map(key)).size, peChanges = new Set(pe.map(key)).size;
  const moves = [...new Set(items.map(u => u.move))].map(m => {
    const a = new Set(ag.filter(u => u.move === m).map(key)).size, p = new Set(pe.filter(u => u.move === m).map(key)).size;
    return [m, {
      agent_changes: a, agent_projects: new Set(ag.filter(u => u.move === m).map(u => u.project)).size,
      agent: pct(a, agChanges), people: pct(p, peChanges),
      ratio: Math.round((a / Math.max(1, agChanges)) / Math.max(0.001, p / Math.max(1, peChanges)) * 100) / 100,
    }];
  }).sort((x, y) => y[1].ratio - x[1].ratio);
  return {
    projects: shared, agent_units: ag.length, people_units: pe.length,
    agent_changes_with_remarks: agChanges, people_changes_with_remarks: peChanges,
    agent_changes: changesOf(u => AGENTS.includes(u.agent)), people_changes: changesOf(u => !u.agent),
    moves: Object.fromEntries(moves),
  };
}

function languages(area) {
  const items = train.filter(u => u.area === area && SUBSTANTIVE.includes(u.kind) && u.language);
  return Object.fromEntries(Object.entries(count(items, u => u.language)).filter(([, n]) => n >= 150).sort((a, b) => b[1] - a[1]).map(([lang, n]) => {
    const g = items.filter(u => u.language === lang);
    return [lang, { n, top: Object.entries(count(g, u => u.move)).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, k]) => `${m} ${pct(k, n)}%`) }];
  }));
}

const stats = {
  corpus: {
    changes: new Set(units.map(u => `${u.source}|${u.project}|${u.change}`)).size,
    units: units.length, projects: new Set(units.map(u => u.project)).size,
    classified: base.size, by_subject: count([...base.values()].filter(j => j.speaker === "reviewer"), j => j.subject),
    labelled: labelled.length, train: train.length,
    agent_changes: count([...new Map(units.filter(u => u.agent).map(u => [`${u.project}#${u.change}`, u.agent])).values()], a => a),
  },
  tests: {
    substantive: train.filter(u => u.area === "tests" && SUBSTANTIVE.includes(u.kind)).length,
    high_value: train.filter(u => u.area === "tests" && u.high_value).length,
    moves: moveTable(train.filter(u => u.area === "tests" && SUBSTANTIVE.includes(u.kind))),
    agents_vs_people: agentsVsPeople("tests"),
    languages: languages("tests"),
    rejections: count(train.filter(u => u.area === "tests" && u.rejection), u => u.rejection),
  },
  comments: {
    substantive: train.filter(u => u.area === "comments" && (SUBSTANTIVE.includes(u.kind) || u.kind === "nit")).length,
    high_value: train.filter(u => u.area === "comments" && u.high_value).length,
    moves: moveTable(train.filter(u => u.area === "comments" && (SUBSTANTIVE.includes(u.kind) || u.kind === "nit"))),
    agents_vs_people: agentsVsPeople("comments"),
    rejections: count(train.filter(u => u.area === "comments" && u.rejection), u => u.rejection),
  },
};
writeFileSync(join(DATA_DIR, "stats.json"), JSON.stringify(stats, null, 1));

// ---------- reference pools ----------
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");
// An address to a coding agent ("@copilot fix X") is kept as a neutral marker;
// injection-shaped text is dropped, since an agent later prints these.
const INJECTION = /ignore (all|everything|any) (previous|above|prior)|system prompt|you are (now )?(an?|the) (ai|assistant|agent)/i;
const RELAYS_AI = /^\s*\[Severity:|robot voice|AI review|\b(codex|claude|copilot|gemini|chatgpt|llm) (is saying|says|points out|found|suggests)/i;
const neutral = s => s.replace(/@(copilot|claude|codex)(\+[\w.-]+)?/gi, "@agent");
const quotedShare = s => { const ls = s.split("\n").filter(l => l.trim()); return ls.filter(l => /^\s*>/.test(l)).length / Math.max(1, ls.length); };
const reviewerName = s => s.replace(/<[^>]+>/, "").replace(/"/g, "").trim();
const exemplar = u => ({
  id: u.id, project: u.project, url: u.url, language: u.language ?? (u.source === "lore" ? "C" : null), path: u.path,
  move: u.move, kind: u.kind, depth: u.depth, severity: u.severity, reviewer: reviewerName(u.commenter), agent: u.agent ?? null,
  context: clip(u.hunk.split("\n").slice(-14).join("\n"), 1200), comment: clip(neutral(u.comment), 1400),
  reply: clip(neutral(u.replies.find(r => r.role === "author")?.body ?? ""), 400), outcome: u.outcome, rejection: u.rejection,
});
const usable = u => u.comment.length >= 40 && quotedShare(u.comment) < 0.5 && !INJECTION.test(u.comment) && !RELAYS_AI.test(u.comment);
const byWeight = (a, b) => (b.depth + b.severity) - (a.depth + a.severity);
const write = (dir, name, rows) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), rows.map(e => JSON.stringify(e)).join("\n") + "\n"); return rows.length; };

const sizes = {};
// Comment remarks rarely reach the high-value bar (a wrong comment misleads;
// it seldom breaks anything), so their pool takes every concrete remark that
// landed, high-value ones first.
// The strongest remarks only, so the skills stay small to install.
const POOL_SIZE = { tests: 1200, comments: 800 };
const inPool = { tests: u => u.high_value, comments: u => u.landed && u.concrete >= 0.5 && u.depth >= 1 && (SUBSTANTIVE.includes(u.kind) || u.kind === "nit") };
for (const area of ["tests", "comments"]) {
  const pool = train.filter(u => u.area === area && inPool[area](u) && usable(u))
    .sort((a, b) => (b.high_value - a.high_value) || byWeight(a, b)).slice(0, POOL_SIZE[area]).map(exemplar);
  sizes[`${area}/exemplars`] = write(REFS[area], "exemplars.jsonl", pool);
  const rejected = train.filter(u => u.area === area && u.outcome === "rejected" && SUBSTANTIVE.includes(u.kind) && usable(u)
    && u.replies.some(r => r.role === "author" && (r.body ?? "").length >= 20)).map(exemplar);
  sizes[`${area}/rejected`] = write(REFS[area], "rejected.jsonl", rejected);
}
// What reviewers corrected in tests that coding agents wrote.
const agentPool = train.filter(u => u.area === "tests" && AGENTS.includes(u.agent) && SUBSTANTIVE.includes(u.kind) && u.landed
  && u.concrete >= 0.5 && u.depth >= 1.2 && usable(u)).sort(byWeight).slice(0, 600).map(exemplar);
sizes["tests/agents"] = write(REFS.tests, "agents.jsonl", agentPool);

console.log(`${labelled.length} labelled units (${train.length} train)`);
console.log(sizes);
