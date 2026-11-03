import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { CHUNK_BYTES } from "../shared/attachments.ts";
import { FILE_DOWNLOAD_LIMIT } from "../shared/files.ts";
import { openDesktopFile, runsCode, type DesktopFileAction } from "./desktop-files.ts";

/**
 * A file on another of Jordan's computers, which a browser on this one fetched and hands to this computer's Desk in
 * pieces, to save in Downloads and open here.
 */
export type OpenHereCommand =
	| { kind: "begin"; name: string; size: number }
	| { kind: "chunk"; id: string; offset: number; base64: string }
	| { kind: "finish"; id: string; sha256: string };

/** Files on their way at once, and how long one waits for its next piece. */
const RECEIVING = 4, IDLE_MS = 10 * 60_000;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** A name that stays inside the folder and is valid on Windows and Linux: no folders, controls or reserved names. */
export function downloadName(name: string): string {
	let value = String(name).split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
	if (!value) value = "download";
	if (RESERVED.test(value)) value = `_${value}`;
	const extension = extname(value).slice(0, 20);
	return value.length > 200 ? `${value.slice(0, 200 - extension.length)}${extension}` : value;
}

/**
 * Saves files a browser on this computer brought from another computer, then opens them with their usual app.
 * Only that browser may call it (host-api.ts). A program or script is saved and its folder shown instead of run.
 */
export class OpenHere {
	private readonly receiving = new Map<string, { name: string; size: number; part: string; written: number; touched: number }>();
	private readonly folder: string;
	private readonly launch: (path: string, action: DesktopFileAction) => Promise<void>;
	constructor(folder = join(homedir(), "Downloads"), launch = openDesktopFile) { this.folder = folder; this.launch = launch; }

	async command(command: OpenHereCommand): Promise<unknown> {
		for (const [id, item] of this.receiving) if (item.touched < Date.now() - IDLE_MS) { this.receiving.delete(id); await rm(item.part, { force: true }); }
		if (command.kind === "begin") {
			const name = downloadName(command.name);
			if (!Number.isSafeInteger(command.size) || command.size < 0 || command.size > FILE_DOWNLOAD_LIMIT) throw new Error("Files opened here are limited to 128 MiB.");
			if (this.receiving.size >= RECEIVING) throw new Error("Four files are already on their way here. Open this one when they have.");
			await mkdir(this.folder, { recursive: true });
			const id = randomUUID(), part = join(this.folder, `.${id}.desk-download`);
			await (await open(part, "wx", 0o600)).close();
			this.receiving.set(id, { name, size: command.size, part, written: 0, touched: Date.now() });
			return { id };
		}
		const item = this.receiving.get(command.id);
		if (!item) throw new Error("This file stopped arriving. Open it again.");
		item.touched = Date.now();
		if (command.kind === "chunk") {
			if (typeof command.base64 !== "string" || command.base64.length > CHUNK_BYTES / 3 * 4 + 4) throw new Error("Invalid file piece.");
			const chunk = Buffer.from(command.base64, "base64");
			// A piece whose acknowledgement was lost arrives again.
			if (command.offset + chunk.length === item.written && command.offset < item.written) return { offset: item.written };
			if (command.offset !== item.written || !chunk.length || item.written + chunk.length > item.size) throw new Error("Invalid file position.");
			const file = await open(item.part, "r+");
			try { await file.write(chunk, 0, chunk.length, command.offset); } finally { await file.close(); }
			item.written += chunk.length;
			return { offset: item.written };
		}
		this.receiving.delete(command.id);
		try {
			if (item.written !== item.size) throw new Error("The file did not arrive completely. Open it again.");
			const bytes = await readFile(item.part), digest = createHash("sha256").update(bytes).digest("hex");
			if (digest !== command.sha256) throw new Error("The file arrived different from the original. Open it again.");
			const path = await this.place(item.part, item.name, bytes.length, digest);
			const action: DesktopFileAction = runsCode(path, bytes.subarray(0, 4)) ? "reveal" : "open";
			await this.launch(path, action);
			return { path, action };
		} finally { await rm(item.part, { force: true }); }
	}

	/** Downloads/name, or name (2) and so on when another file has it; the same file already there is reused. */
	private async place(part: string, name: string, size: number, digest: string): Promise<string> {
		const extension = extname(name), stem = name.slice(0, name.length - extension.length);
		for (let copy = 1; copy <= 100; copy++) {
			const path = join(this.folder, copy === 1 ? name : `${stem} (${copy})${extension}`);
			const existing = await stat(path).catch(() => undefined);
			if (!existing) { await rename(part, path); return path; }
			if (existing.isFile() && existing.size === size && createHash("sha256").update(await readFile(path)).digest("hex") === digest) return path;
		}
		throw new Error(`Downloads has 100 other files named like ${name}.`);
	}
}
