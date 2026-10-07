import { closeSync, existsSync, openSync, readSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionView } from "../shared/protocol.ts";
import { isOpenSession } from "../shared/workspace.ts";
import { publishFileSync } from "./file-publication.ts";

export function parseSessionHeader(text: string): { cwd: string; id: string } {
	const header = JSON.parse(text.split("\n", 1)[0]!);
	if (header.type !== "session" || typeof header.cwd !== "string" || typeof header.id !== "string") throw new Error("Not a Pi session file.");
	return { cwd: header.cwd, id: header.id };
}

export function readSessionHeader(file: string): { cwd: string; id: string } {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(65_536);
		const text = buffer.subarray(0, readSync(fd, buffer)).toString("utf8");
		return parseSessionHeader(text);
	} finally { closeSync(fd); }
}

/** Small references/preferences only; Pi's JSONL files remain the transcript. */
export class SessionCatalog {
	private file: string;
	constructor(directory: string) { this.file = join(directory, "sessions.json"); }
	read(): SessionView[] {
		if (!existsSync(this.file)) return [];
		const value = JSON.parse(readFileSync(this.file, "utf8"));
		if (value.version !== 1 || !Array.isArray(value.sessions)) throw new Error("Invalid Desk session catalog.");
		return value.sessions.map((item: SessionView) => {
			if (typeof item.key !== "string" || typeof item.cwd !== "string") throw new Error("Invalid Desk session reference.");
			return { ...item, agentId: item.file && existsSync(item.file) ? readSessionHeader(item.file).id : item.agentId,
				state: "closed", interrupted: isOpenSession(item),
				controls: item.controls?.map(control => control.state === "running"
					? { ...control, state: "interrupted", error: "The host stopped before the outcome was recorded. Check saved history; this operation was not replayed." }
					: control),
				error: item.state === "closed" ? item.error : "Pi was interrupted. Resume to continue; unfinished work was not replayed." };
		});
	}
	write(sessions: SessionView[]): void {
		const records = sessions.map(view => ({
			key: view.key, agentId: view.snapshot?.id ?? view.agentId,
			cwd: view.snapshot?.cwd ?? view.cwd, created: view.created, state: view.state,
			file: view.snapshot?.file ?? view.file, name: view.snapshot?.name ?? view.name,
			title: view.snapshot?.title ?? view.title,
			leaf: view.snapshot ? view.snapshot.leaf : view.leaf,
			pinned: view.pinned, interrupted: view.interrupted, error: view.error,
			controls: view.controls, activation: view.activation,
		}));
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify({ version: 1, sessions: records }), { flag: "wx", mode: 0o600 });
			publishFileSync(temporary, this.file);
		} finally {
			try { unlinkSync(temporary); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Catalog temporary-file cleanup failed:", error); }
		}
	}
}
