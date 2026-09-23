import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ID = /^[a-f0-9]{32}$/;
const LIVE_MS = 30_000;

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
	const file = join(dir, `${entry.id}.json`);
	const temp = join(dir, `.${entry.id}.${randomUUID()}.tmp`);
	writeFileSync(temp, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
	renameSync(temp, file);
}

export function removeSession(id: string): void {
	try { unlinkSync(join(directory(), `${id}.json`)); } catch { /* Already removed. */ }
	if (process.platform !== "win32") {
		try { unlinkSync(endpointPath(id)); } catch { /* Already removed. */ }
	}
}

export function listSessions(): LiveSession[] {
	let files: string[];
	try { files = readdirSync(directory()); } catch { return []; }
	const found: LiveSession[] = [];
	for (const file of files) {
		if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
		try {
			const path = join(directory(), file);
			if (!lstatSync(path).isFile()) continue;
			const entry = JSON.parse(readFileSync(path, "utf8")) as LiveSession;
			if (!entry || entry.id !== file.slice(0, -5) ||
				typeof entry.updatedAt !== "number" || Date.now() - entry.updatedAt > LIVE_MS ||
				entry.updatedAt > Date.now() + 5000 ||
				typeof entry.sessionId !== "string" || typeof entry.name !== "string" ||
				typeof entry.cwd !== "string" ||
				(entry.summary !== undefined && typeof entry.summary !== "string") ||
				!["idle", "working", "needs-answer"].includes(entry.state)) continue;
			if (process.platform !== "win32" && (!existsSync(endpointPath(entry.id)) ||
				!lstatSync(endpointPath(entry.id)).isSocket())) continue;
			found.push(entry);
		} catch { /* Ignore an incomplete or retired process record. */ }
	}
	return found.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
