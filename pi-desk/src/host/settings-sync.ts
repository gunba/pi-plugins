import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { atomicJson } from "../../manage/store.ts";

/**
 * Pi's general setup, mirrored between a workspace's computers: AGENTS.md, settings (key by key), keybindings, models,
 * prompts, skills and themes. Logins, MCP servers, local extensions, tokens and conversations stay on each computer.
 *
 * Every item carries the time it last changed and the computer that changed it; the newest version wins. Items only
 * one computer has are copied to the others; a deletion spreads only from a computer that had the item. Computers
 * that were offline catch up from any computer online.
 */
export type SyncVersion = { hash: string; time: number; from: string; deleted?: true };
export type SyncManifest = Record<string, SyncVersion>;
export type SyncFile = { key: string; version: SyncVersion; data?: string };

const FILES = ["AGENTS.md", "keybindings.json", "models.json"];
const FOLDERS = ["prompts", "skills", "themes"];
const HOME_FOLDERS = [".agents/skills"];
/** Settings that name this computer's own paths, programs or network, or record what it has seen. */
const LOCAL_SETTINGS = new Set(["extensions", "skills", "prompts", "themes", "lastChangelogVersion", "shellPath", "shellCommandPrefix",
	"npmCommand", "externalEditor", "sessionDir", "httpProxy", "terminal", "images"]);
const MAX_FILE = 1024 * 1024, MAX_ITEMS = 2000, TOMBSTONE_DAYS = 90;
const KEY = /^(agent|home|setting):(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]{1,400}$/;
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export class SettingsSync {
	private state: SyncManifest;
	private readonly statePath: string;
	private readonly agentDir: string;
	private readonly home: string;
	private readonly computer: string;
	private scanned = 0;
	/** The last change that arrived from another computer, for Settings. */
	last?: { key: string; from: string; at: number };
	/** computer: this computer's name, recorded with the changes made here. */
	constructor(agentDir: string, home: string, dataDir: string, computer: string) {
		this.agentDir = agentDir; this.home = home; this.computer = computer;
		this.statePath = join(dataDir, "settings-sync.json");
		try { this.state = JSON.parse(readFileSync(this.statePath, "utf8")).versions ?? {}; } catch { this.state = {}; }
	}
	private path(key: string): string | undefined {
		const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
		if (kind === "setting") return;
		const local = rest.split("/").join(sep);
		return kind === "agent" ? join(this.agentDir, local) : join(this.home, local);
	}
	private allowed(key: string): boolean {
		if (!KEY.test(key)) return false;
		const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
		if (kind === "setting") return !LOCAL_SETTINGS.has(rest);
		if (kind === "home") return HOME_FOLDERS.some(folder => rest.startsWith(`${folder}/`));
		return FILES.includes(rest) || FOLDERS.some(folder => rest.startsWith(`${folder}/`));
	}
	private settings(): Record<string, unknown> | undefined {
		try { const value = JSON.parse(readFileSync(join(this.agentDir, "settings.json"), "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; }
		catch { return undefined; }
	}
	/** What is here now, with when it changed: a file's modification time, settings by settings.json's. */
	private current(): Map<string, { hash: string; time: number }> {
		const found = new Map<string, { hash: string; time: number }>();
		const add = (key: string, path: string) => {
			try {
				const stat = statSync(path);
				if (!stat.isFile() || stat.size > MAX_FILE || found.size >= MAX_ITEMS) return;
				found.set(key, { hash: sha(readFileSync(path)), time: Math.floor(stat.mtimeMs) });
			} catch { /* Gone or unreadable. */ }
		};
		const walk = (prefix: string, folder: string) => {
			let entries; try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
			for (const entry of entries) {
				if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
				if (entry.isDirectory()) walk(`${prefix}${entry.name}/`, join(folder, entry.name));
				else if (entry.isFile()) add(`${prefix}${entry.name}`, join(folder, entry.name));
			}
		};
		for (const file of FILES) add(`agent:${file}`, join(this.agentDir, file));
		for (const folder of FOLDERS) walk(`agent:${folder}/`, join(this.agentDir, folder));
		for (const folder of HOME_FOLDERS) walk(`home:${folder}/`, join(this.home, ...folder.split("/")));
		const settings = this.settings();
		if (settings) {
			const time = Math.floor(statSync(join(this.agentDir, "settings.json")).mtimeMs);
			for (const [key, value] of Object.entries(settings)) if (!LOCAL_SETTINGS.has(key)) found.set(`setting:${key}`, { hash: sha(JSON.stringify(value)), time });
		}
		return found;
	}
	/** Notes this computer's own changes since the last look; returns everything known, deletions included. */
	manifest(): SyncManifest {
		if (Date.now() - this.scanned < 5000) return this.state;
		this.scanned = Date.now();
		const now = this.current(), first = !Object.keys(this.state).length;
		let changed = false;
		for (const [key, item] of now) {
			const known = this.state[key];
			if (known && !known.deleted && known.hash === item.hash) continue;
			// settings.json's date says when any setting last changed, not this one: settings found at the first look are of
			// unknown age (0), so they fill gaps elsewhere but never replace another computer's value. Later edits are timed.
			const age = first && key.startsWith("setting:") ? 0 : Math.max(item.time, (known?.time ?? 0) + 1);
			this.state[key] = { hash: item.hash, time: age, from: this.computer };
			changed = true;
		}
		for (const [key, known] of Object.entries(this.state)) {
			if (known.deleted) {
				if (Date.now() - known.time > TOMBSTONE_DAYS * 86_400_000) { delete this.state[key]; changed = true; }
				continue;
			}
			if (!now.has(key) && this.allowed(key)) { this.state[key] = { hash: "", time: Date.now(), from: this.computer, deleted: true }; changed = true; }
		}
		if (changed) this.save();
		return this.state;
	}
	private save(): void { mkdirSync(dirname(this.statePath), { recursive: true }); atomicJson(this.statePath, { versions: this.state }); }
	private newer(theirs: SyncVersion, ours?: SyncVersion): boolean {
		if (!ours) return !theirs.deleted;
		if (theirs.hash === ours.hash && !!theirs.deleted === !!ours.deleted) return false;
		// Two values of unknown age: each computer keeps its own until one is edited.
		if (!theirs.time && !ours.time) return false;
		return theirs.time > ours.time || theirs.time === ours.time && theirs.from > ours.from;
	}
	/** Another computer's manifest: applies its deletions here and returns the items to fetch from it. */
	compare(remote: unknown): string[] {
		if (!remote || typeof remote !== "object" || Array.isArray(remote)) return [];
		this.manifest();
		const wanted: string[] = [];
		for (const [key, value] of Object.entries(remote as Record<string, SyncVersion>).slice(0, MAX_ITEMS * 2)) {
			if (!this.allowed(key) || !value || typeof value.hash !== "string" || !Number.isFinite(value.time) || typeof value.from !== "string") continue;
			const version: SyncVersion = { hash: value.hash, time: value.time, from: value.from.slice(0, 100), ...(value.deleted ? { deleted: true as const } : {}) };
			if (!this.newer(version, this.state[key])) continue;
			if (version.deleted) this.write(key, version, undefined); else wanted.push(key);
		}
		return wanted.slice(0, 500);
	}
	/** This computer's current content for items another computer asked for. */
	serve(keys: unknown): SyncFile[] {
		if (!Array.isArray(keys)) return [];
		this.manifest();
		const settings = this.settings();
		return keys.slice(0, 500).flatMap((key): SyncFile[] => {
			if (typeof key !== "string" || !this.allowed(key) || !this.state[key] || this.state[key].deleted) return [];
			let data: Buffer;
			if (key.startsWith("setting:")) {
				const name = key.slice(8);
				if (!settings || !(name in settings)) return [];
				data = Buffer.from(JSON.stringify(settings[name]));
			} else try { data = readFileSync(this.path(key)!); } catch { return []; }
			return sha(key.startsWith("setting:") ? data.toString() : data) === this.state[key].hash ? [{ key, version: this.state[key], data: data.toString("base64") }] : [];
		});
	}
	/** Content another computer sent: written when it is still newer than this computer's own. */
	apply(files: unknown, from: string): number {
		if (!Array.isArray(files)) return 0;
		this.manifest();
		let applied = 0;
		for (const file of files.slice(0, 500) as SyncFile[]) {
			if (!file || typeof file.key !== "string" || !this.allowed(file.key) || typeof file.data !== "string" || !file.version) continue;
			const data = Buffer.from(file.data, "base64"), version = file.version;
			if (data.length > MAX_FILE || sha(file.key.startsWith("setting:") ? data.toString() : data) !== version.hash || !this.newer(version, this.state[file.key])) continue;
			if (this.write(file.key, version, data)) { applied++; this.last = { key: file.key, from, at: Date.now() }; }
		}
		return applied;
	}
	private write(key: string, version: SyncVersion, data: Buffer | undefined): boolean {
		try {
			if (key.startsWith("setting:")) {
				const name = key.slice(8), settings = this.settings() ?? {};
				if (data) settings[name] = JSON.parse(data.toString()); else delete settings[name];
				const path = join(this.agentDir, "settings.json");
				writeFileSync(`${path}.sync`, `${JSON.stringify(settings, null, 2)}\n`); renameSync(`${path}.sync`, path);
			} else {
				const path = this.path(key)!;
				if (data) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.sync`, data); renameSync(`${path}.sync`, path); }
				else if (existsSync(path)) rmSync(path, { force: true });
			}
			this.state[key] = version; this.save();
			// The write itself is not a change made here.
			this.scanned = 0;
			return true;
		} catch { return false; }
	}
}
