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

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";

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

function expandUserPath(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function resolveUserPath(p) {
  return resolve(expandUserPath(p));
}

function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.trim();
  if (env) return resolveUserPath(env);
  return join(homedir(), ".pi", "agent");
}

function codexDir() {
  const env = process.env.CODEX_HOME && process.env.CODEX_HOME.trim();
  if (env) return resolveUserPath(env);
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

const TEXT_BASENAMES = new Set([
  "AGENTS.md", "SKILL.md", "README.md", "settings.json", "models.json", "subagents.json", "mcp.json",
  ".gitignore", ".npmrc", ".yarnrc", ".env.example", ".env.sample",
]);
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".conf", ".css", ".csv", ".cts", ".env", ".html", ".ini", ".js", ".json", ".jsonc",
  ".jsx", ".log", ".md", ".mdx", ".mjs", ".mts", ".ps1", ".py", ".sh", ".toml", ".ts",
  ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function hasKnownTextName(name) {
  const base = basename(name);
  return TEXT_BASENAMES.has(base) || TEXT_EXTENSIONS.has(extname(base).toLowerCase());
}

function decodeUtf8(buf) {
  try { return UTF8_DECODER.decode(buf); } catch { return null; }
}

function hasBinaryControlChars(text) {
  const sample = text.slice(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd) return true;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) return true;
  }
  return false;
}

function decodeTextData(name, buf) {
  const text = decodeUtf8(buf);
  if (text === null) return null;
  if (hasKnownTextName(name)) return text;
  return hasBinaryControlChars(text) ? null : text;
}

const SECRET_FILE_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", ".netrc", "auth.json", "credentials", "credentials.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts",
]);
const SECRET_PATH_PATTERNS = [
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])(secret|secrets|private|token|tokens)(\.|[\\/]|$)/i,
  /\.(key|pem|p12|pfx|crt|cer|der)$/i,
];
const SECRET_VALUE_PATTERNS = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "secret-like assignment", re: /\b(?:api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:-]{16,}/i },
];

function isSecretArchivePath(name) {
  const normalized = name.replace(/\\/g, "/");
  const base = basename(normalized).toLowerCase();
  return SECRET_FILE_BASENAMES.has(base) || SECRET_PATH_PATTERNS.some((re) => re.test(normalized));
}

function scanTextForSecrets(name, text, warnings) {
  for (const pat of SECRET_VALUE_PATTERNS) {
    if (pat.re.test(text)) warnings.push(`possible ${pat.name} in ${name}; review before sharing`);
  }
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
  if (isSecretArchivePath(archiveName)) { warnings.push(`skipped secret-like file: ${archiveName}`); return; }
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
  return typeof v === "string" && /^([A-Za-z]:[\\/]|\/|~[\\/])/.test(v);
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function pathExistsOrWillExist(value, stagedTargets) {
  if (!looksAbsolute(value)) return false;
  const expanded = expandUserPath(value);
  if (/^[A-Za-z]:[\\/]/.test(expanded) && process.platform !== "win32") return false;
  const abs = resolve(expanded);
  return existsSync(expanded) || existsSync(abs) || stagedTargets.has(toFwd(abs));
}

function trimPathCandidate(value) {
  return value.replace(/[),.;:]+$/g, "");
}

function scanTextForMissingPaths(field, text, flag) {
  const re = /(?:[A-Za-z]:[\\/][^\s"'`<>|{}\[\]]+|~[\\/][^\s"'`<>|{}\[\]]+|\/[A-Za-z0-9._~@%+=:,/\\-]+)/g;
  for (const match of text.matchAll(re)) {
    const raw = trimPathCandidate(match[0]);
    if (!raw || raw === "/") continue;
    const before = match.index > 0 ? text[match.index - 1] : "";
    if (before === ":") continue; // URL path component, e.g. https://host/path
    flag(field, raw, "Absolute path found in exported text and not present on this machine; review or translate it.");
  }
}

function normalizePackageEntry(entry, index) {
  let source;
  let filters = null;
  if (typeof entry === "string") source = entry.trim();
  else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    source = typeof entry.source === "string" ? entry.source.trim() : "";
    filters = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "source"));
  } else {
    throw new Error(`settings.packages[${index}] must be a string or object with a source field`);
  }
  if (!source) throw new Error(`settings.packages[${index}] is missing a source`);
  return { source, filters };
}

function packageKind(source) {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:") || source.startsWith("git+") || /^ssh:\/\//i.test(source) || /^https?:\/\//i.test(source)) return "git";
  if (source.startsWith("file:")) return "local";
  if (isAbsolute(expandUserPath(source)) || /^([A-Za-z]:[\\/]|~[\\/]|\.\.?[\\/])/.test(source)) return "local";
  return "local";
}

function packagePlan(settings) {
  const pkgs = settings && Array.isArray(settings.packages) ? settings.packages : [];
  return pkgs.map((entry, index) => {
    const { source, filters } = normalizePackageEntry(entry, index);
    const kind = packageKind(source);
    const note = kind === "local"
      ? "Local/relative source — likely won't resolve on another machine; install manually or repoint it."
      : "Reinstalled by `pi update`.";
    return { package: source, source, kind, note, ...(filters && Object.keys(filters).length ? { filters } : {}) };
  });
}

// Scan already-detokenized config/text for absolute paths that don't exist here.
function reviewScan(settings, mcp, stagedEntries = []) {
  const items = [];
  const seen = new Set();
  const stagedTargets = new Set(stagedEntries.map((s) => toFwd(resolve(s.target))));
  const flag = (field, value, note) => {
    if (typeof value !== "string" || !value.trim()) return;
    const v = trimPathCandidate(value.trim());
    if (!looksAbsolute(v)) return;
    if (pathExistsOrWillExist(v, stagedTargets)) return;
    const key = `${field}\0${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ field, value: v, note });
  };
  const flagLocalPackage = (field, source) => {
    if (looksAbsolute(source)) flag(field, source, "Local package source path not found on this machine; install manually or repoint it.");
    else if (packageKind(source) === "local") {
      const key = `${field}\0${source}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ field, value: source, note: "Relative/local package source from the source machine; confirm or repoint it before reinstalling." });
      }
    }
  };

  if (settings) {
    flag("settings.shellPath", settings.shellPath, "Shell binary not found on this machine; clear it or set the local shell.");
    if (Array.isArray(settings.npmCommand)) {
      settings.npmCommand.forEach((v, i) => flag(`settings.npmCommand[${i}]`, v, "npm/runtime path not found; use the local one or a bare command name."));
    }
    for (const key of ["skills", "prompts", "extensions"]) {
      if (Array.isArray(settings[key])) settings[key].forEach((v, i) => flag(`settings.${key}[${i}]`, v, "Referenced directory not present on this machine."));
    }
    for (const [i, p] of packagePlan(settings).entries()) flagLocalPackage(`settings.packages[${i}]`, p.source);
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

  for (const s of stagedEntries) {
    if (typeof s.text === "string") scanTextForMissingPaths(`files.${s.rel}`, s.text, flag);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function timestamp() {
  const d = new Date();
  const z = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}${z(d.getMilliseconds(), 3)}-${randomBytes(3).toString("hex")}`;
}

function resolveOutPath(out, platform) {
  const fname = `pi-settings-${platform}-${timestamp()}.zip`;
  if (!out) {
    const desktop = join(homedir(), "Desktop");
    const base = existsSync(desktop) ? desktop : homedir();
    return join(base, fname);
  }
  const abs = resolveUserPath(out);
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
    const text = decodeTextData(archiveName, raw);
    if (text !== null) {
      scanTextForSecrets(archiveName, text, warnings);
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
    excluded: ["npm/ (node_modules — run `pi update`)", "bin/", "sessions/", "*caches*", "auth.json and secret-like files (*.pem, *.key, .env, .ssh/, tokens)"],
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
  const abs = resolveUserPath(zipPath);
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
  const decoded = decodeTextData(entry.name, entry.data);
  if (decoded !== null) {
    text = detokenizeText(decoded, r);
    data = Buffer.from(text, "utf8");
  }
  return { rel, target, data, text, mode: entry.mode };
}

function parseStagedJson(staged, rel) {
  const item = staged.find((s) => s.rel === rel);
  if (!item) return null;
  if (typeof item.text !== "string") throw new Error(`${rel} is not valid UTF-8 text after extraction`);
  try { return JSON.parse(item.text); }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${rel}: ${msg}`);
  }
}

function validateStagedDestinations(staged, targetDir) {
  const seen = new Set();
  const root = resolve(targetDir);
  for (const s of staged) {
    const rel = relative(root, s.target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refusing destination outside Pi agent home: ${s.rel}`);
    if (seen.has(s.target)) throw new Error(`Bundle contains duplicate destination: ${s.rel}`);
    seen.add(s.target);
    if (existsSync(s.target)) {
      const st = lstatSync(s.target);
      if (st.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${rel}`);
      if (!st.isFile()) throw new Error(`Refusing to overwrite non-file path: ${rel}`);
    }
  }
}

function writeStagedTransactional(staged, targetDir, backupDir, opts) {
  validateStagedDestinations(staged, targetDir);
  const applied = staged.map((s) => relative(targetDir, s.target));
  const backedUp = [];

  for (const s of staged) {
    if (existsSync(s.target)) backedUp.push(relative(targetDir, s.target));
  }
  if (opts.dryRun) return { applied, backedUp };

  mkdirSync(targetDir, { recursive: true });
  const backups = new Map();
  for (const s of staged) {
    if (!existsSync(s.target)) continue;
    const rel = relative(targetDir, s.target);
    const backupPath = join(backupDir, rel);
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(s.target, backupPath);
    backups.set(s.target, backupPath);
  }

  const committed = [];
  const tempPaths = [];
  try {
    for (const s of staged) {
      mkdirSync(dirname(s.target), { recursive: true });
      const tmp = join(dirname(s.target), `.${basename(s.target)}.settings-sync-${timestamp()}.tmp`);
      tempPaths.push(tmp);
      writeFileSync(tmp, s.data);
      if (process.platform !== "win32") { try { chmodSync(tmp, s.mode || 0o644); } catch {} }
      try {
        renameSync(tmp, s.target);
      } catch (err) {
        if (process.platform === "win32" && existsSync(s.target)) {
          unlinkSync(s.target);
          renameSync(tmp, s.target);
        } else {
          throw err;
        }
      }
      const idx = tempPaths.indexOf(tmp);
      if (idx >= 0) tempPaths.splice(idx, 1);
      committed.push({ target: s.target, backupPath: backups.get(s.target) || null });
    }
  } catch (err) {
    for (const c of committed.reverse()) {
      try {
        if (c.backupPath) copyFileSync(c.backupPath, c.target);
        else if (existsSync(c.target)) unlinkSync(c.target);
      } catch {}
    }
    for (const tmp of tempPaths) { try { rmSync(tmp, { force: true }); } catch {} }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Apply failed and was rolled back: ${msg}`);
  }

  return { applied, backedUp };
}

function cmdInspect(zipPath) {
  const { abs, entries, manifest } = loadBundle(zipPath);
  const r = roots();
  const targetDir = agentDir();
  const homeEntries = entries.filter((e) => e.name.startsWith("home/"));
  const staged = homeEntries.map((e) => stageEntry(e, r, targetDir));
  const settings = parseStagedJson(staged, "settings.json");
  const mcp = parseStagedJson(staged, "mcp.json");
  const packages = packagePlan(settings);

  return {
    ok: true,
    bundle: abs,
    source: manifest.source,
    createdAt: manifest.createdAt,
    target: { platform: process.platform, piHome: r.piHome, home: r.home, codexHome: r.codexHome },
    fileCount: homeEntries.length,
    entries: homeEntries.map((e) => ({ path: e.name.replace(/^home\//, ""), bytes: e.data.length })),
    packages,
    reviewItems: reviewScan(settings, mcp, staged),
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
  const settings = parseStagedJson(staged, "settings.json");
  const mcp = parseStagedJson(staged, "mcp.json");
  const packages = packagePlan(settings);
  const reviewItems = reviewScan(settings, mcp, staged);
  const backupDir = join(targetDir, "backups", `settings-sync-${timestamp()}`);
  const { applied, backedUp } = writeStagedTransactional(staged, targetDir, backupDir, opts);

  return {
    ok: true,
    bundle: abs,
    dryRun: !!opts.dryRun,
    targetDir,
    applied,
    backedUp,
    backupDir: backedUp.length ? backupDir : null,
    packages,
    reviewItems,
    nextSteps: ["Run `pi update` to reinstall packages/extensions (node_modules are not bundled).", "Resolve any reviewItems for this OS.", "Re-authenticate (auth.json is never bundled)."],
  };
}

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
