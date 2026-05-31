#!/usr/bin/env node
// pi-settings-sync engine.
//
// One self-contained Node script (no runtime dependencies) that powers both the
// programmatic /pi-export command and the agent-driven import skill.
//
//   node pi-settings-sync.mjs export  [--out <dir|file.zip>] [--json]
//   node pi-settings-sync.mjs inspect <bundle.zip>           [--json]
//   node pi-settings-sync.mjs apply   <bundle.zip> [--dry-run] [--json]
//
// Portability model: only the user-level Pi config (~/.pi/agent) travels.
// Machine/OS-specific roots (the Pi home, the user home, the Codex home) are
// rewritten to sentinels on export and expanded to the *target* machine's roots
// on apply, so a Linux<->Windows round trip keeps working. Regenerable trees
// (npm/ node_modules, native bin/, caches) and per-machine history (sessions/,
// knowledge bases) are never bundled; `pi update` rebuilds them.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Format + scope constants
// ---------------------------------------------------------------------------

const FORMAT = "pi-settings-sync";
const FORMAT_VERSION = 1;

// Portable, user-level config worth carrying between machines.
const ALLOW_FILES = ["settings.json", "models.json", "subagents.json", "AGENTS.md"];
const ALLOW_DIRS = ["skills", "agents", "themes", "prompts"];
// mcp.json is portable too, but kept explicit so the review scanner always sees it.
const ALLOW_FILES_ALWAYS = ["mcp.json"];

// Never recurse into these inside an allowed directory.
const EXCLUDE_DIR_NAMES = new Set(["node_modules", ".git", ".DS_Store"]);
// Guard against accidentally bundling something huge from a settings subtree.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Path sentinels. Deliberately synthetic so they cannot collide with real config text.
const TOKENS = {
  PI_HOME: "@PI_SETTINGS_SYNC::PI_HOME@",
  CODEX_HOME: "@PI_SETTINGS_SYNC::CODEX_HOME@",
  HOME: "@PI_SETTINGS_SYNC::HOME@",
};

// ---------------------------------------------------------------------------
// Path roots
// ---------------------------------------------------------------------------

const toFwd = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");

function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.trim();
  if (env) return resolve(env.startsWith("~/") ? join(homedir(), env.slice(2)) : env);
  return join(homedir(), ".pi", "agent");
}

function codexDir() {
  const env = process.env.CODEX_HOME && process.env.CODEX_HOME.trim();
  if (env) return resolve(env.startsWith("~/") ? join(homedir(), env.slice(2)) : env);
  return join(homedir(), ".codex");
}

// Roots for the *current* machine, longest-first so PI_HOME/CODEX_HOME win over HOME.
function roots() {
  return {
    home: toFwd(homedir()),
    piHome: toFwd(agentDir()),
    codexHome: toFwd(codexDir()),
  };
}

// ---------------------------------------------------------------------------
// Tokenize / detokenize
// ---------------------------------------------------------------------------

// Every separator/escaping variant a root might appear as inside a config file.
function rootVariants(root) {
  const fwd = root;
  const back = root.replace(/\//g, "\\");
  const backEsc = back.replace(/\\/g, "\\\\"); // JSON-escaped Windows path
  return [...new Set([fwd, back, backEsc])];
}

function tokenizeText(text, r) {
  let out = text;
  // Order matters: PI_HOME and CODEX_HOME are nested under HOME.
  for (const [token, root] of [
    [TOKENS.PI_HOME, r.piHome],
    [TOKENS.CODEX_HOME, r.codexHome],
    [TOKENS.HOME, r.home],
  ]) {
    for (const variant of rootVariants(root)) out = out.split(variant).join(token);
  }
  return out;
}

function detokenizeText(text, r) {
  // Always emit forward slashes: valid on POSIX and accepted by Node on Windows,
  // and JSON-safe (no backslash escaping needed).
  return text
    .split(TOKENS.PI_HOME).join(r.piHome)
    .split(TOKENS.CODEX_HOME).join(r.codexHome)
    .split(TOKENS.HOME).join(r.home);
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Minimal zero-dependency ZIP (store/deflate)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const deflated = deflateRawSync(f.data, { level: 9 });
    const store = deflated.length >= f.data.length;
    const method = store ? 0 : 8;
    const body = store ? f.data : deflated;
    const mode = (f.mode ?? 0o644) & 0o7777;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(((mode << 16) >>> 0), 38); // external attrs: unix mode
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdStart = offset;
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

function readZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid zip (end-of-central-directory not found)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`Corrupt local header for ${name}`);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const body = buf.slice(start, start + compSize);
    const data = method === 0 ? body : inflateRawSync(body);
    out.push({ name, data, mode: (extAttr >>> 16) & 0o7777 });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collect (export side)
// ---------------------------------------------------------------------------

function collectFile(absPath, archiveName, out, warnings) {
  let st;
  try { st = lstatSync(absPath); } catch { return; }
  if (st.isSymbolicLink()) { warnings.push(`skipped symlink: ${archiveName}`); return; }
  if (!st.isFile()) return;
  if (st.size > MAX_FILE_BYTES) { warnings.push(`skipped large file (${st.size} bytes): ${archiveName}`); return; }
  out.push({ absPath, archiveName, mode: st.mode & 0o7777 });
}

function collectDir(absDir, archiveBase, out, warnings) {
  let entries;
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (EXCLUDE_DIR_NAMES.has(e.name)) continue;
    const abs = join(absDir, e.name);
    const name = `${archiveBase}/${e.name}`;
    if (e.isSymbolicLink()) { warnings.push(`skipped symlink: ${name}`); continue; }
    if (e.isDirectory()) collectDir(abs, name, out, warnings);
    else if (e.isFile()) collectFile(abs, name, out, warnings);
  }
}

function collectExport(dir) {
  const out = [];
  const warnings = [];
  for (const f of [...ALLOW_FILES, ...ALLOW_FILES_ALWAYS]) {
    const abs = join(dir, f);
    if (existsSync(abs)) collectFile(abs, `home/${f}`, out, warnings);
  }
  for (const d of ALLOW_DIRS) {
    const abs = join(dir, d);
    if (existsSync(abs)) collectDir(abs, `home/${d}`, out, warnings);
  }
  return { out, warnings };
}

// ---------------------------------------------------------------------------
// Review scan (machine-specific values that won't auto-translate)
// ---------------------------------------------------------------------------

function looksAbsolute(v) {
  return typeof v === "string" && /^([A-Za-z]:[\\/]|\/)/.test(v);
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// Scan already-detokenized config objects for absolute paths that don't exist here.
function reviewScan(settings, mcp) {
  const items = [];
  const flag = (field, value, note) => {
    if (looksAbsolute(value) && !existsSync(value)) items.push({ field, value, note });
  };

  if (settings) {
    flag("settings.shellPath", settings.shellPath, "Shell binary not found on this machine; clear it or set the local shell.");
    if (Array.isArray(settings.npmCommand)) {
      settings.npmCommand.forEach((v, i) => flag(`settings.npmCommand[${i}]`, v, "npm/runtime path not found; use the local one or a bare command name."));
    }
    for (const key of ["skills", "prompts", "extensions"]) {
      if (Array.isArray(settings[key])) settings[key].forEach((v, i) => flag(`settings.${key}[${i}]`, v, "Referenced directory not present on this machine."));
    }
  }

  if (mcp && mcp.mcpServers && typeof mcp.mcpServers === "object") {
    for (const [srv, cfg] of Object.entries(mcp.mcpServers)) {
      if (!cfg || typeof cfg !== "object") continue;
      flag(`mcp.${srv}.command`, cfg.command, "MCP server binary not found; install it or fix the path.");
      if (Array.isArray(cfg.args)) cfg.args.forEach((v, i) => flag(`mcp.${srv}.args[${i}]`, v, "MCP arg path not found on this machine."));
      if (cfg.env && typeof cfg.env === "object") {
        for (const [k, v] of Object.entries(cfg.env)) flag(`mcp.${srv}.env.${k}`, v, "MCP env path not found on this machine.");
      }
    }
  }
  return items;
}

function packagePlan(settings) {
  const pkgs = settings && Array.isArray(settings.packages) ? settings.packages : [];
  return pkgs.map((p) => {
    const kind = p.startsWith("npm:") ? "npm" : p.startsWith("git:") ? "git" : "local";
    return { package: p, kind, note: kind === "local" ? "Local/relative source — likely won't resolve on another machine; install manually." : "Reinstalled by `pi update`." };
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function timestamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function resolveOutPath(out, platform) {
  const fname = `pi-settings-${platform}-${timestamp()}.zip`;
  if (!out) {
    const desktop = join(homedir(), "Desktop");
    const base = existsSync(desktop) ? desktop : homedir();
    return join(base, fname);
  }
  const abs = resolve(out);
  if (/\.zip$/i.test(abs)) return abs;
  return join(abs, fname); // treat as directory
}

function cmdExport(opts) {
  const dir = agentDir();
  if (!existsSync(dir)) throw new Error(`Pi agent home not found: ${dir}`);
  const r = roots();
  const { out: collected, warnings } = collectExport(dir);

  let tokenizedCount = 0;
  const files = collected.map(({ absPath, archiveName, mode }) => {
    const raw = readFileSync(absPath);
    let data = raw;
    if (isProbablyText(raw)) {
      const text = raw.toString("utf8");
      const tok = tokenizeText(text, r);
      if (tok !== text) tokenizedCount++;
      data = Buffer.from(tok, "utf8");
    }
    return { name: archiveName, data, mode };
  });

  const settings = readJson(join(dir, "settings.json"));
  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    source: { platform: process.platform, hostname: hostname(), piHome: r.piHome, codexHome: r.codexHome, home: r.home },
    tokens: TOKENS,
    packages: settings && Array.isArray(settings.packages) ? settings.packages : [],
    excluded: ["npm/ (node_modules — run `pi update`)", "bin/", "sessions/", "*caches*", "auth.json (secrets, excluded by design)"],
    entries: files.map((f) => ({ path: f.name, bytes: f.data.length, mode: f.mode, sha256: createHash("sha256").update(f.data).digest("hex") })),
  };

  const all = [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), mode: 0o644 }, ...files];
  const zip = buildZip(all);
  const outPath = resolveOutPath(opts.out, process.platform);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zip);

  return { ok: true, zipPath: outPath, fileCount: files.length, bytes: zip.length, tokenizedCount, warnings, excluded: manifest.excluded };
}

function loadBundle(zipPath) {
  const abs = resolve(zipPath);
  if (!existsSync(abs)) throw new Error(`Bundle not found: ${abs}`);
  if (lstatSync(abs).isDirectory()) throw new Error(`Expected a .zip bundle, got a directory: ${abs}`);
  const entries = readZip(readFileSync(abs));
  const manEntry = entries.find((e) => e.name === "manifest.json");
  if (!manEntry) throw new Error("Bundle is missing manifest.json — not a pi-settings-sync bundle.");
  const manifest = JSON.parse(manEntry.data.toString("utf8"));
  if (manifest.format !== FORMAT) throw new Error(`Unexpected bundle format: ${manifest.format}`);
  if (manifest.formatVersion > FORMAT_VERSION) throw new Error(`Bundle format v${manifest.formatVersion} is newer than this engine (v${FORMAT_VERSION}). Update pi-plugins.`);
  return { abs, entries, manifest };
}

// Map a `home/...` archive entry to its detokenized text + target absolute path.
function stageEntry(entry, r, targetDir) {
  const rel = entry.name.replace(/^home\//, "");
  const target = resolve(join(targetDir, rel));
  // zip-slip guard
  const guard = resolve(targetDir) + sep;
  if (target !== resolve(targetDir) && !target.startsWith(guard)) throw new Error(`Refusing path traversal: ${entry.name}`);
  let data = entry.data;
  let text = null;
  if (isProbablyText(entry.data)) {
    text = detokenizeText(entry.data.toString("utf8"), r);
    data = Buffer.from(text, "utf8");
  }
  return { rel, target, data, text, mode: entry.mode };
}

function cmdInspect(zipPath) {
  const { abs, entries, manifest } = loadBundle(zipPath);
  const r = roots();
  const homeEntries = entries.filter((e) => e.name.startsWith("home/"));

  // Detokenize the two config files in-memory to scan for machine-specific values.
  let settings = null, mcp = null;
  for (const e of homeEntries) {
    if (e.name === "home/settings.json" && isProbablyText(e.data)) settings = safeParse(detokenizeText(e.data.toString("utf8"), r));
    if (e.name === "home/mcp.json" && isProbablyText(e.data)) mcp = safeParse(detokenizeText(e.data.toString("utf8"), r));
  }

  return {
    ok: true,
    bundle: abs,
    source: manifest.source,
    createdAt: manifest.createdAt,
    target: { platform: process.platform, piHome: r.piHome, home: r.home, codexHome: r.codexHome },
    fileCount: homeEntries.length,
    entries: homeEntries.map((e) => ({ path: e.name.replace(/^home\//, ""), bytes: e.data.length })),
    packages: packagePlan(settings),
    reviewItems: reviewScan(settings, mcp),
    excluded: manifest.excluded || [],
  };
}

function cmdApply(zipPath, opts) {
  const { abs, entries, manifest } = loadBundle(zipPath);
  const r = roots();
  const targetDir = agentDir();
  const homeEntries = entries.filter((e) => e.name.startsWith("home/"));

  // Integrity check against manifest checksums (verifies the *stored*/tokenized bytes).
  const sums = new Map((manifest.entries || []).map((e) => [e.path, e.sha256]));
  for (const e of homeEntries) {
    const want = sums.get(e.name);
    if (want && createHash("sha256").update(e.data).digest("hex") !== want) throw new Error(`Checksum mismatch for ${e.name} — bundle is corrupt.`);
  }

  const staged = homeEntries.map((e) => stageEntry(e, r, targetDir));

  const backupDir = join(targetDir, "backups", `settings-sync-${timestamp()}`);
  const applied = [];
  const backedUp = [];

  if (!opts.dryRun) mkdirSync(targetDir, { recursive: true });

  for (const s of staged) {
    if (existsSync(s.target)) {
      const rel = relative(targetDir, s.target);
      const backupPath = join(backupDir, rel);
      if (!opts.dryRun) { mkdirSync(dirname(backupPath), { recursive: true }); copyFileSync(s.target, backupPath); }
      backedUp.push(rel);
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(s.target), { recursive: true });
      writeFileSync(s.target, s.data);
      if (process.platform !== "win32") { try { chmodSync(s.target, s.mode || 0o644); } catch {} }
    }
    applied.push(relative(targetDir, s.target));
  }

  // Recompute review from what was (or would be) written.
  const settings = safeParse(staged.find((s) => s.rel === "settings.json")?.text);
  const mcp = safeParse(staged.find((s) => s.rel === "mcp.json")?.text);

  return {
    ok: true,
    bundle: abs,
    dryRun: !!opts.dryRun,
    targetDir,
    applied,
    backedUp,
    backupDir: backedUp.length ? backupDir : null,
    packages: packagePlan(settings),
    reviewItems: reviewScan(settings, mcp),
    nextSteps: ["Run `pi update` to reinstall packages/extensions (node_modules are not bundled).", "Resolve any reviewItems for this OS.", "Re-authenticate (auth.json is never bundled)."],
  };
}

function safeParse(t) { if (!t) return null; try { return JSON.parse(t); } catch { return null; } }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--out") flags.out = argv[++i];
    else if (a.startsWith("--out=")) flags.out = a.slice(6);
    else pos.push(a);
  }
  return { flags, pos };
}

function printHuman(cmd, res) {
  const lines = [];
  if (cmd === "export") {
    lines.push(`Exported ${res.fileCount} file(s) -> ${res.zipPath}`);
    lines.push(`Size: ${(res.bytes / 1024).toFixed(1)} KB  |  Path-rewritten files: ${res.tokenizedCount}`);
    if (res.warnings?.length) lines.push(`Warnings: ${res.warnings.join("; ")}`);
    lines.push(`Excluded: ${res.excluded.join(", ")}`);
  } else if (cmd === "inspect") {
    lines.push(`Bundle: ${res.bundle}`);
    lines.push(`From ${res.source.platform} (${res.source.hostname}) at ${res.createdAt}`);
    lines.push(`Into ${res.target.platform} home ${res.target.piHome}`);
    lines.push(`Files: ${res.fileCount}`);
    if (res.packages.length) lines.push(`Packages: ${res.packages.map((p) => p.package).join(", ")}`);
    if (res.reviewItems.length) { lines.push(`Review (${res.reviewItems.length}):`); for (const it of res.reviewItems) lines.push(`  - ${it.field} = ${it.value}  (${it.note})`); }
    else lines.push("Review: none");
  } else if (cmd === "apply") {
    lines.push(`${res.dryRun ? "[dry-run] would apply" : "Applied"} ${res.applied.length} file(s) -> ${res.targetDir}`);
    if (res.backedUp.length) lines.push(`Backed up ${res.backedUp.length} existing file(s) -> ${res.backupDir}`);
    if (res.reviewItems.length) { lines.push(`Review (${res.reviewItems.length}):`); for (const it of res.reviewItems) lines.push(`  - ${it.field} = ${it.value}  (${it.note})`); }
    lines.push(`Next: ${res.nextSteps.join(" ")}`);
  }
  console.log(lines.join("\n"));
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);
  try {
    let res;
    if (cmd === "export") res = cmdExport({ out: flags.out });
    else if (cmd === "inspect") { if (!pos[0]) throw new Error("Usage: inspect <bundle.zip>"); res = cmdInspect(pos[0]); }
    else if (cmd === "apply") { if (!pos[0]) throw new Error("Usage: apply <bundle.zip> [--dry-run]"); res = cmdApply(pos[0], { dryRun: flags.dryRun }); }
    else { throw new Error(`Unknown command: ${cmd || "(none)"}. Use export | inspect | apply.`); }

    if (flags.json) console.log(JSON.stringify(res));
    else printHuman(cmd, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`error: ${msg}`);
    process.exit(1);
  }
}

main();
