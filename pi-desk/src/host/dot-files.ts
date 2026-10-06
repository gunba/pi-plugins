import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, statSync, truncateSync } from "node:fs";
import { join, basename } from "node:path";
import { atomicJson } from "../../manage/store.ts";
import { DOT_FILE_BYTES, DOT_FILE_COUNT, type DotUpload } from "../shared/dot.ts";

export const dotUuid = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const CHUNK_BYTES = 256 * 1024;

export class DotFiles {
	private directory: string;
	constructor(directory: string) {
		this.directory = join(directory, "files");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		for (const file of this.list()) if (["uploading", "handed-off"].includes(file.state)) this.save({ ...file, state: "unknown", error: "The native upload was not confirmed before Desk stopped. Review Dot before uploading again." });
	}
	private metadata(id: string): string {
		if (!dotUuid(id)) throw Error("Invalid Dot file ID.");
		return join(this.directory, `${id}.json`);
	}
	path(id: string): string {
		const file = this.get(id);
		if (!file) throw Error("Dot attachment no longer exists.");
		return join(this.directory, id, file.name);
	}
	get(id: string): DotUpload | undefined {
		try { return JSON.parse(readFileSync(this.metadata(id), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	list(dot?: string): DotUpload[] {
		return readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => this.get(name.slice(0, -5))!)
			.filter(file => !dot || file.dot === dot);
	}
	save(file: DotUpload): void { atomicJson(this.metadata(file.id), file); }
	create(id: string, dot: string, name: string, mime: string, size: number, connection?: string): DotUpload {
		this.metadata(id);
		if (!dot || !Number.isSafeInteger(size) || size < 1 || size > DOT_FILE_BYTES) throw Error("Dot attachments must be 20 MB or smaller.");
		name = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().slice(0, 200).replace(/[. ]+$/, "");
		if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
		if (!name || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw Error("Invalid attachment name or type.");
		const previous = this.get(id);
		if (previous) {
			if (previous.dot !== dot || previous.connection !== connection || previous.name !== name || previous.mime !== mime || previous.size !== size) throw Error("Dot file ID was reused for another attachment.");
			return previous;
		}
		if (this.list(dot).length >= DOT_FILE_COUNT) throw Error("Dot accepts up to eight attachments. Remove an existing draft attachment first.");
		mkdirSync(join(this.directory, id), { mode: 0o700 });
		writeFileSync(join(this.directory, id, name), Buffer.alloc(0), { flag: "wx", mode: 0o600 });
		const file: DotUpload = { id, dot, connection, name, mime, size, received: 0, state: "staging" };
		this.save(file); return file;
	}
	append(id: string, offset: number, data: string): DotUpload {
		const file = this.get(id);
		if (!file || file.state !== "staging" && file.state !== "ready") throw Error("Dot attachment is not accepting chunks.");
		if (!Number.isSafeInteger(offset) || offset < 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error("Invalid attachment chunk.");
		const bytes = Buffer.from(data, "base64");
		if (!bytes.length || bytes.length > CHUNK_BYTES || offset + bytes.length > file.size) throw Error("Attachment chunk exceeds its declared size.");
		if (offset < file.received) {
			if (offset + bytes.length > file.received || !readFileSync(this.path(id)).subarray(offset, offset + bytes.length).equals(bytes)) throw Error("Attachment retry contains different bytes.");
			return file;
		}
		if (offset !== file.received) throw Error("Attachment chunks must arrive in order.");
		const actual = statSync(this.path(id)).size;
		if (actual < file.received) throw Error("Staged attachment bytes were lost. Remove the attachment and select it again.");
		if (actual > file.received) truncateSync(this.path(id), file.received);
		appendFileSync(this.path(id), bytes);
		file.received += bytes.length; file.state = file.received === file.size ? "ready" : "staging";
		this.save(file); return file;
	}
	remove(id: string): void {
		const file = this.get(id);
		if (file?.state === "uploading") throw Error("Wait for the current attachment upload.");
		rmSync(this.metadata(id), { force: true }); rmSync(join(this.directory, id), { recursive: true, force: true });
	}
	forInput(dot: string, ids: string[], connection?: string): DotUpload[] {
		if (ids.length > DOT_FILE_COUNT || new Set(ids).size !== ids.length) throw Error("Choose up to eight different attachments.");
		return ids.map(id => {
			const file = this.get(id);
			if (!file || file.dot !== dot || file.connection !== connection || !["ready", "uploaded"].includes(file.state)) throw Error("Attachment is incomplete or needs review.");
			return file;
		});
	}
}
