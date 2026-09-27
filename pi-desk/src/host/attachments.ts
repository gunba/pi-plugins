import { createHash, randomBytes } from "node:crypto";
import {
	closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
	readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { extname, join } from "node:path";
import { CHUNK_BYTES, FILE_COUNT, FILE_LIMIT, MESSAGE_FILE_LIMIT, type Attachment, type UploadCommand } from "../shared/attachments.ts";

interface Stored extends Attachment { created: number; ready: boolean; used: boolean }
const ID = /^[a-f0-9]{64}$/;
const SESSION_LIMIT = 128 * 1024 * 1024;
const extension = (name: string) => /^\.[a-zA-Z0-9]{1,16}$/.test(extname(name)) ? extname(name).toLowerCase() : ".bin";
const imageType = (head: Buffer): string => {
	if (head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
	if (head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg";
	if (/^GIF8[79]a/.test(head.toString("ascii"))) return "image/gif";
	if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return "application/octet-stream";
};

/** Files, not a second message store. Accepted paths remain usable from native Pi history. */
export class Attachments {
	private readonly directory: string;
	constructor(agentDir: string, sessionId: string) {
		this.directory = join(agentDir, "desk", "attachments", createHash("sha256").update(sessionId).digest("hex"));
	}
	private folder(id: string): string {
		if (!ID.test(id)) throw new Error("Invalid attachment.");
		return join(this.directory, id);
	}
	private metadata(id: string): Stored {
		const folder = this.folder(id);
		if (!lstatSync(folder).isDirectory()) throw new Error("Attachment is unavailable.");
		const data = JSON.parse(readFileSync(join(folder, "metadata.json"), "utf8")) as Stored;
		if (data.id !== id || typeof data.name !== "string" || !Number.isSafeInteger(data.size)
			|| data.size < 0 || data.size > FILE_LIMIT) throw new Error("Invalid attachment metadata.");
		return data;
	}
	private save(data: Stored): void {
		const path = join(this.folder(data.id), "metadata.json");
		writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	}
	private path(data: Stored): string { return join(this.folder(data.id), `attachment${extension(data.name)}`); }
	private open(data: Stored, writable = false): number {
		const descriptor = openSync(this.path(data), (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.size > data.size) { closeSync(descriptor); throw new Error("Attachment size changed."); }
		return descriptor;
	}
	command(command: UploadCommand): unknown {
		if (command.kind === "upload_begin") {
			if (!command.name || command.name.length > 255 || !Number.isSafeInteger(command.size) || command.size < 0 || command.size > FILE_LIMIT)
				throw new Error("Each attachment must be at most 8 MiB.");
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			let reserved = 0, count = 0;
			for (const id of readdirSync(this.directory)) {
				if (/^[a-f0-9]{64}\.staging$/.test(id)) {
					const path = join(this.directory, id);
					if (lstatSync(path).mtimeMs < Date.now() - 24 * 60 * 60 * 1000) rmSync(path, { recursive: true, force: true });
					continue;
				}
				if (!ID.test(id)) continue;
				const item = this.metadata(id);
				const updated = Math.max(lstatSync(this.path(item)).mtimeMs, lstatSync(join(this.folder(id), "metadata.json")).mtimeMs);
				if (!item.used && updated < Date.now() - 24 * 60 * 60 * 1000) {
					rmSync(this.folder(id), { recursive: true }); continue;
				}
				reserved += item.size; count++;
			}
			if (reserved + command.size > SESSION_LIMIT || count >= 256) throw new Error("This conversation has reached its attachment storage limit (128 MiB or 256 files).");
			const data: Stored = { id: randomBytes(32).toString("hex"), name: command.name, size: command.size,
				mimeType: "application/octet-stream", created: Date.now(), ready: false, used: false };
			const staging = `${this.folder(data.id)}.staging`;
			mkdirSync(staging, { mode: 0o700 });
			try {
				writeFileSync(join(staging, `attachment${extension(data.name)}`), "", { flag: "wx", mode: 0o600 });
				writeFileSync(join(staging, "metadata.json"), JSON.stringify(data), { flag: "wx", mode: 0o600 });
				renameSync(staging, this.folder(data.id));
			} finally { rmSync(staging, { recursive: true, force: true }); }
			return { id: data.id };
		}
		const data = this.metadata(command.id);
		if (command.kind === "upload_discard") {
			if (data.used) throw new Error("A submitted prompt references this file.");
			rmSync(this.folder(data.id), { recursive: true });
			return;
		}
		const descriptor = this.open(data, command.kind === "upload_chunk");
		try {
			const size = fstatSync(descriptor).size;
			if (command.kind === "upload_chunk") {
				if (command.base64.length > CHUNK_BYTES / 3 * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.base64))
					throw new Error("Invalid upload chunk.");
				const chunk = Buffer.from(command.base64, "base64");
				if (!chunk.length || !Number.isSafeInteger(command.offset) || command.offset < 0 || command.offset > size
					|| command.offset + chunk.length > data.size) throw new Error("Invalid upload position.");
				// A lost acknowledgement can be retried, but must not overwrite different bytes.
				let written = Math.min(chunk.length, size - command.offset);
				if (written) {
					const previous = Buffer.alloc(written);
					if (readSync(descriptor, previous, 0, written, command.offset) !== written || !previous.equals(chunk.subarray(0, written)))
						throw new Error("Upload contents changed. Attach the file again.");
				}
				if (written < chunk.length) {
					if (data.ready) throw new Error("This upload has already finished.");
					while (written < chunk.length) written += writeSync(descriptor, chunk, written, chunk.length - written, command.offset + written);
				}
				return { offset: command.offset + chunk.length };
			}
			if (size !== data.size) throw new Error("Upload is incomplete.");
			const head = Buffer.alloc(Math.min(16, size)); readSync(descriptor, head, 0, head.length, 0);
			data.mimeType = imageType(head); data.ready = true; this.save(data);
			return { id: data.id, name: data.name, size: data.size, mimeType: data.mimeType } satisfies Attachment;
		} finally { closeSync(descriptor); }
	}
	prepare(ids: string[], imagesSupported: boolean) {
		if (ids.length > FILE_COUNT || new Set(ids).size !== ids.length) throw new Error("Attach up to eight different files.");
		const files = ids.map(id => this.metadata(id));
		if (files.reduce((sum, file) => sum + file.size, 0) > MESSAGE_FILE_LIMIT) throw new Error("Attachments must total at most 32 MiB.");
		const images: { type: "image"; data: string; mimeType: string }[] = [];
		for (const file of files) {
			if (!file.ready) throw new Error("Finish uploading attachments before sending.");
			const descriptor = this.open(file);
			try {
				if (fstatSync(descriptor).size !== file.size) throw new Error("Attachment size changed.");
				if (imagesSupported && file.mimeType.startsWith("image/")) images.push({
					type: "image", data: readFileSync(descriptor).toString("base64"), mimeType: file.mimeType,
				});
			} finally { closeSync(descriptor); }
		}
		// Retain before native admission: a disconnect or extension error must not delete a file
		// that an input handler or queued prompt has already observed.
		for (const file of files) { file.used = true; this.save(file); }
		return { images, text: files.length ? `\n\nAttached files on the host:\n${files.map(file =>
			`- ${JSON.stringify(file.name)} (${file.size} bytes): ${JSON.stringify(this.path(file))}`).join("\n")}` : "" };
	}
}
