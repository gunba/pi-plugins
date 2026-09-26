import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";

export function readOptional(path: string): string | undefined {
	try { return readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Cooperate with Pi's settings writer using the same renewable directory locks. */
export async function withFileLocks<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
	const releases: (() => Promise<void>)[] = [];
	try {
		for (const path of [...new Set(paths)].sort()) {
			mkdirSync(dirname(path), { recursive: true });
			releases.push(await lockfile.lock(path, {
				realpath: false, retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
			}));
		}
		return await operation();
	} finally {
		for (const release of releases.reverse()) await release();
	}
}

/** Caller holds the lock. Preserve file permissions and retry Windows rename contention. */
export async function replaceFile(path: string, text: string | undefined): Promise<void> {
	if (text === undefined) {
		try { unlinkSync(path); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return;
	}
	const temp = `${path}.${randomUUID()}.tmp`;
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : path.endsWith(".json") ? 0o600 : 0o644;
	writeFileSync(temp, text, { mode, flag: "wx" });
	try {
		for (let attempt = 0; ; attempt++) {
			try { renameSync(temp, path); return; }
			catch (error) {
				if (!["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt === 9) throw error;
				await delay(50 * (attempt + 1));
			}
		}
	} finally { rmSync(temp, { force: true }); }
}

export async function writeCheckedFile(path: string, before: string | undefined, after: string): Promise<void> {
	await withFileLocks([path], async () => {
		if (readOptional(path) !== before) throw new Error(`File changed while it was being edited: ${path}. Reopen it before saving.`);
		await replaceFile(path, after);
	});
}
