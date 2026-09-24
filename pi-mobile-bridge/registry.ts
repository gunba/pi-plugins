import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ID = /^[a-f0-9]{32}$/;
const RECORD = /^([a-f0-9]{32})\.[a-z0-9]{12}\.[a-z0-9]{8}\.[a-f0-9]{8}\.json$/;
const RETIRED_RECORD = /^(?:[a-f0-9]{32}\.json|\.[a-f0-9]{32}\.[a-f0-9-]{36}\.tmp)$/;
const LIVE_MS = 30_000;
let generation = 0;

export interface LiveSession {
	id: string;
	sessionId: string;
	name: string;
	cwd: string;
	state: "idle" | "working" | "needs-answer";
	summary?: string;
	updatedAt: number;
}

function directory(): string {
	return join(getAgentDir(), "mobile-bridge");
}

export function ensureRegistryDirectory(): void {
	mkdirSync(directory(), { recursive: true, mode: 0o700 });
	const info = lstatSync(directory());
	if (!info.isDirectory() || info.isSymbolicLink() ||
		(process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
		throw new Error("Phone bridge directory must be private");
	}
}

export function endpointPath(id: string): string {
	if (!ID.test(id)) throw new Error("Invalid local session ID");
	return process.platform === "win32" ? `\\\\.\\pipe\\pi-mobile-${id}` : join(directory(), `${id}.sock`);
}

export function newInstanceId(): string {
	return randomUUID().replaceAll("-", "");
}

export function saveSession(entry: LiveSession): void {
	const dir = directory();
	ensureRegistryDirectory();
	if (!ID.test(entry.id)) throw new Error("Invalid local session ID");
	const stamp = Date.now().toString(36).padStart(12, "0");
	const serial = (generation++).toString(36).padStart(8, "0");
	const file = join(dir, `${entry.id}.${stamp}.${serial}.${randomUUID().slice(0, 8)}.json`);
	try {
		// An immutable generation avoids replacing a file another Windows process
		// is reading. Readers can fall back to the previous complete generation.
		writeFileSync(file, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
	} catch (error) {
		try { unlinkSync(file); } catch { /* A later sweep can remove it. */ }
		throw error;
	}
	try {
		const older = readdirSync(dir).filter(name => RECORD.test(name) && name.startsWith(`${entry.id}.`)).sort().reverse().slice(4);
		for (const name of older) {
			try { unlinkSync(join(dir, name)); } catch { /* A reader may still hold this generation. */ }
		}
	} catch { /* Pruning is not part of publication. */ }
}

export function removeSession(id: string): void {
	if (!ID.test(id)) return;
	try {
		for (const name of readdirSync(directory())) {
			if (!RECORD.test(name) || !name.startsWith(`${id}.`)) continue;
			try { unlinkSync(join(directory(), name)); } catch { /* A reader may still hold it. */ }
		}
	} catch { /* Already removed. */ }
	if (process.platform !== "win32") {
		try { unlinkSync(endpointPath(id)); } catch { /* Already removed. */ }
	}
}

export function listSessions(): LiveSession[] {
	let files: string[];
	try { files = readdirSync(directory()); } catch { return []; }
	const found = new Map<string, LiveSession>();
	for (const file of files.sort()) {
		const match = RECORD.exec(file);
		if (!match) {
			if (RETIRED_RECORD.test(file)) {
				try {
					const path = join(directory(), file);
					if (Date.now() - lstatSync(path).mtimeMs > 3_600_000) unlinkSync(path);
				} catch { /* A legacy process or file scanner may still hold it. */ }
			}
			continue;
		}
		try {
			const path = join(directory(), file);
			const info = lstatSync(path);
			if (!info.isFile()) continue;
			if (Date.now() - info.mtimeMs > 3_600_000) {
				try { unlinkSync(path); } catch { /* Best-effort crash cleanup. */ }
				continue;
			}
			const entry = JSON.parse(readFileSync(path, "utf8")) as LiveSession;
			if (!entry || entry.id !== match[1] ||
				typeof entry.updatedAt !== "number" || Date.now() - entry.updatedAt > LIVE_MS ||
				entry.updatedAt > Date.now() + 5000 ||
				typeof entry.sessionId !== "string" || typeof entry.name !== "string" ||
				typeof entry.cwd !== "string" ||
				(entry.summary !== undefined && typeof entry.summary !== "string") ||
				!["idle", "working", "needs-answer"].includes(entry.state)) continue;
			if (process.platform !== "win32" && (!existsSync(endpointPath(entry.id)) ||
				!lstatSync(endpointPath(entry.id)).isSocket())) continue;
			found.set(entry.id, entry);
		} catch { /* Ignore an incomplete or retired process record. */ }
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
