#!/usr/bin/env node
// Mine patch reviews from the corpus's kernel.org mailing lists through lore's
// public-inbox git epochs (the web interface sits behind a bot challenge; git does not, and
// is far faster than lore's NNTP server). For each list: shallow-clone the
// newest messages, rebuild patch -> review -> author-response chains, and keep
// patches that a person other than the author reviewed.
//
//   node lore.mjs --corpus <name> [--articles 30000] [--per-list <n>] [list ...]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DATA_DIR, LORE, REUSE_DIR, SAMPLE } from "../corpus.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const ARTICLES = Number(opt("articles", 30000));
const PER_LIST = Number(opt("per-list", SAMPLE.lorePerList ?? 80));
const lists = args.length ? args : Object.keys(LORE);

function git(args, opts = {}) {
  return execFileSync("git", args, { maxBuffer: 1 << 30, ...opts });
}

// Read many blobs in one `git cat-file --batch` process.
function readBlobs(repo, specs) {
  if (!specs.length) return [];
  const out = git(["-C", repo, "cat-file", "--batch"], { input: specs.join("\n") + "\n" });
  const blobs = [];
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString();
    const size = Number(header.split(" ")[2]);
    if (Number.isNaN(size)) { blobs.push(null); at = nl + 1; continue; }
    blobs.push(out.subarray(nl + 1, nl + 1 + size).toString("latin1"));
    at = nl + 1 + size + 1;
  }
  return blobs;
}

const emailOf = from => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const BOTS = /lkp@intel\.com|syzbot|patchwork-bot|noreply|bot@|kernelci|ci_notify|sashiko|robot/i;

function decodeHeader(value) {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, text) => {
    try {
      const bytes = enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return new TextDecoder(/utf-?8/i.test(cs) ? "utf-8" : "latin1").decode(bytes);
    } catch { return text; }
  });
}

function parseArticle(lines) {
  const blank = lines.indexOf("");
  const headerLines = lines.slice(0, blank);
  const headers = {};
  let last = null;
  for (const l of headerLines) {
    if (/^\s/.test(l) && last) headers[last] += ` ${l.trim()}`;
    else { const i = l.indexOf(":"); last = l.slice(0, i).toLowerCase(); headers[last] = l.slice(i + 1).trim(); }
  }
  let raw = lines.slice(blank + 1).join("\n");
  const ctype = headers["content-type"] ?? "";
  const cte = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  if (/multipart\//i.test(ctype)) {
    const boundary = ctype.match(/boundary="?([^";]+)"?/i)?.[1];
    if (boundary) {
      const part = raw.split(`--${boundary}`).find(p => /content-type:\s*text\/plain/i.test(p.slice(0, 400)) || !/content-type:/i.test(p.slice(0, 400)) && p.trim());
      if (part) {
        const sep = part.indexOf("\n\n");
        const ph = part.slice(0, sep);
        raw = part.slice(sep + 2);
        const pcte = ph.match(/content-transfer-encoding:\s*(\S+)/i)?.[1]?.toLowerCase();
        if (pcte === "base64") raw = Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("latin1");
        else if (pcte === "quoted-printable") raw = qp(raw);
      }
    }
  } else if (cte === "base64") raw = Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("latin1");
  else if (cte === "quoted-printable") raw = qp(raw);
  let body;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw, "latin1")); } catch { body = raw; }
  return {
    from: decodeHeader(headers.from ?? ""), subject: decodeHeader(headers.subject ?? ""), date: headers.date,
    msgid: headers["message-id"], inReplyTo: headers["in-reply-to"], body,
  };
}
function qp(s) { return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }

function headersOf(raw) {
  const end = raw.indexOf("\n\n");
  const h = {};
  let last = null;
  for (const l of raw.slice(0, end < 0 ? raw.length : end).split("\n")) {
    if (/^\s/.test(l) && last) h[last] += ` ${l.trim()}`;
    else { const i = l.indexOf(":"); if (i > 0) { last = l.slice(0, i).toLowerCase(); h[last] = l.slice(i + 1).trim(); } }
  }
  return h;
}

async function mineList(list) {
  const epoch = LORE[list];
  const dir = join(DATA_DIR, "lore", list);
  // Reuse a clone another corpus already made.
  const reused = join(REUSE_DIR, "lore-git", `${list}.git`);
  const repo = existsSync(reused) ? reused : join(DATA_DIR, "lore-git", `${list}.git`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(repo)) {
    mkdirSync(join(DATA_DIR, "lore-git"), { recursive: true });
    git(["clone", "-q", "--bare", "--depth", String(ARTICLES), `https://lore.kernel.org/${list}/${epoch}`, repo], { stdio: "ignore" });
  }
  const overCache = join(dir, "_overview.json");
  let over;
  if (existsSync(overCache)) over = JSON.parse(readFileSync(overCache, "utf8"));
  else {
    // Oldest first; one commit per message, the message in blob "m".
    const commits = git(["-C", repo, "rev-list", "--reverse", "HEAD"]).toString().trim().split("\n");
    over = [];
    for (let i = 0; i < commits.length; i += 2000) {
      const batch = commits.slice(i, i + 2000);
      const blobs = readBlobs(repo, batch.map(c => `${c}:m`));
      blobs.forEach((raw, j) => {
        if (!raw) return;
        const h = headersOf(raw);
        if (!h["message-id"]) return;
        const refs = `${h.references ?? ""} ${h["in-reply-to"] ?? ""}`.match(/<[^>]+>/g) ?? [];
        // In-Reply-To names the direct parent; put it last.
        const parent = h["in-reply-to"]?.match(/<[^>]+>/)?.[0];
        const ordered = parent ? [...refs.filter(r => r !== parent), parent] : refs;
        over.push({ num: i + j, commit: batch[j], subject: decodeHeader(h.subject ?? ""), from: decodeHeader(h.from ?? ""), date: h.date, msgid: h["message-id"].match(/<[^>]+>/)?.[0] ?? h["message-id"], refs: ordered });
      });
    }
    writeFileSync(overCache, JSON.stringify(over));
  }
  const byId = new Map(over.map(o => [o.msgid, o]));
  const children = new Map();
  for (const o of over) {
    const parent = o.refs.at(-1);
    if (!parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(o);
  }
  const isPatch = o => /\[[^\]]*PATCH[^\]]*\]/i.test(o.subject) && !/^\s*re:/i.test(o.subject)
    && !/\b0+\/\d+\s*\]/.test(o.subject) && !BOTS.test(o.from);
  // Leave the newest tenth out so conversations have had time to finish.
  const cutoff = Math.floor(over.length * 0.9);
  const candidates = [];
  for (const p of over) {
    if (p.num > cutoff || !isPatch(p)) continue;
    const author = emailOf(p.from);
    const reviews = (children.get(p.msgid) ?? []).filter(r => emailOf(r.from) !== author && !BOTS.test(r.from));
    if (!reviews.length) continue;
    candidates.push({ p, reviews });
  }
  const step = Math.max(1, candidates.length / PER_LIST);
  const pick = [];
  for (let i = 0; i < candidates.length && pick.length < PER_LIST; i += step) pick.push(candidates[Math.floor(i)]);
  console.error(`${list}: ${over.length} messages, ${candidates.length} reviewed patches, ${pick.length} picked`);
  const body = o => {
    const [raw] = readBlobs(repo, [`${o.commit}:m`]);
    return raw ? parseArticle(raw.replace(/\r/g, "").split("\n")) : null;
  };
  for (const { p, reviews } of pick) {
    const file = join(dir, `${p.num}.json`);
    if (existsSync(file) || existsSync(join(REUSE_DIR, "lore", list, `${p.num}.json`))) continue;
    const patch = body(p);
    if (!patch) continue;
    const author = emailOf(p.from);
    const out = { list, num: p.num, url: `https://lore.kernel.org/${list}/${p.msgid.replace(/[<>]/g, "")}/`, author: p.from, patch, reviews: [] };
    for (const r of reviews.slice(0, 4)) {
      const review = body(r);
      if (!review) continue;
      const responses = [];
      for (const reply of (children.get(r.msgid) ?? []).slice(0, 4)) {
        const m = body(reply);
        if (m) responses.push({ ...m, byAuthor: emailOf(reply.from) === author });
      }
      out.reviews.push({ ...review, url: `https://lore.kernel.org/${list}/${r.msgid.replace(/[<>]/g, "")}/`, responses });
    }
    const stem = p.subject.replace(/\[[^\]]*\]/g, "").trim();
    out.laterVersion = over.some(o => o.num > p.num && isPatchLike(o) && emailOf(o.from) === author && o.subject.replace(/\[[^\]]*\]/g, "").trim() === stem);
    writeFileSync(file, JSON.stringify(out));
  }
}
const isPatchLike = o => /\[[^\]]*PATCH[^\]]*\]/i.test(o.subject) && !/^\s*re:/i.test(o.subject);

for (const list of lists) {
  try { await mineList(list); } catch (e) { console.error(`${list} failed: ${e.stack}`); }
}
console.error("done");
