import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function sessionPath(file: string): string {
	return existsSync(file) ? realpathSync.native(file) : join(realpathSync.native(dirname(resolve(file))), basename(file));
}

/** An OS-backed SQLite lock, not a heartbeat that could expire while Pi is suspended. */
export class SessionLease {
	readonly file: string;
	private db?: DatabaseSync;

	constructor(file: string) {
		this.file = sessionPath(file);
		if (existsSync(this.file) && statSync(this.file).nlink > 1) throw new Error("Hard-linked session files cannot have a unique writer.");
		const directory = join(dirname(this.file), ".pi-ownership");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const identity = process.platform === "win32" ? this.file.toLowerCase() : this.file;
		const lock = join(directory, `${createHash("sha256").update(identity).digest("hex")}.sqlite`);
		const db = new DatabaseSync(lock, { timeout: 0 });
		try {
			db.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
			this.db = db;
		} catch (error) {
			db.close();
			if ([5, 6].includes((error as { errcode?: number }).errcode ?? 0)) {
				throw new Error("This session is already open in another Pi process. Close that session before resuming it here.");
			}
			throw error;
		}
	}

	close(): void {
		const db = this.db;
		this.db = undefined;
		db?.close();
	}
}

interface Ownership { lease: SessionLease; managed: boolean }
const key = Symbol.for("pi-plugins.session-ownership.v1");
const globals = globalThis as typeof globalThis & { [key]?: WeakMap<object, Ownership> };
const owners = globals[key] ??= new WeakMap<object, Ownership>();

/** Share ownership across resource reloads and separately bundled copies of this module. */
export function ownership(manager: object): Ownership | undefined { return owners.get(manager); }
export function attachOwnership(manager: object, lease: SessionLease, managed: boolean): void {
	owners.set(manager, { lease, managed });
}
export function releaseOwnership(manager: object): void {
	owners.get(manager)?.lease.close();
	owners.delete(manager);
}
