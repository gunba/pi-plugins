import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fileLink } from "../../../pi-local-links/extensions/links.ts";
import { ExpiredReference } from "./references.ts";
import { localPath } from "./local-path.ts";
import { FILE_CHUNK_BYTES, FILE_DOWNLOAD_LIMIT, type FileCommand, type FileInfo, type FileReference, type FileTextPage } from "../shared/files.ts";

interface Grant extends FileReference { path: string; snapshot?: FileInfo }
const safeName = (name: string) => basename(name.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "_").slice(0, 240) || "download";
async function stamp(file: FileHandle): Promise<{ size: number; version: string }> {
	const info = await file.stat({ bigint: true });
	if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Only regular files can be opened.");
	return { size: Number(info.size), version: createHash("sha256").update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`).digest("hex") };
}
function classify(head: Buffer, partial: boolean): Pick<FileInfo, "kind" | "mimeType"> {
	if (head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { kind: "image", mimeType: "image/png" };
	if (head[0] === 255 && head[1] === 216 && head[2] === 255) return { kind: "image", mimeType: "image/jpeg" };
	if (/^GIF8[79]a$/.test(head.toString("latin1", 0, 6))) return { kind: "image", mimeType: "image/gif" };
	if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return { kind: "image", mimeType: "image/webp" };
	try {
		if (head.includes(0) || head.toString("latin1", 0, 5) === "%PDF-") throw new Error();
		new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: partial });
		return { kind: "text", mimeType: "text/plain; charset=utf-8" };
	} catch { return { kind: "binary", mimeType: "application/octet-stream" }; }
}
async function bytesAt(file: FileHandle, offset: number, length: number): Promise<Buffer> {
	const bytes = Buffer.alloc(length);
	let used = 0;
	while (used < length) {
		const { bytesRead } = await file.read(bytes, used, length - used, offset + used);
		if (!bytesRead) throw new Error("File changed while reading. Refresh it.");
		used += bytesRead;
	}
	return bytes;
}

/** References are minted from displayed content; API requests never supply filesystem paths. */
export class LocalFiles {
	private readonly secret = randomBytes(32);
	private readonly grants = new Map<string, Grant>();
	private retained?: string;

	recover(id: string, project: () => void): void {
		this.retained = id;
		try { project(); } finally { this.retained = undefined; }
	}

	observe(target: string, cwd: string, name?: string): FileReference | undefined {
		if (!target || target.length > 4000 || /[\x00-\x1f\x7f]/.test(target)) return;
		try {
			const href = /^file:/i.test(target) ? target : fileLink(target, cwd);
			if (!href) return;
			const url = new URL(href);
			if (url.protocol !== "file:" || url.hostname || url.username || url.password) return;
			if (process.platform !== "win32" && /^\/[a-z]:\//i.test(url.pathname)) return;
			const path = fileURLToPath(url);
			if (!localPath(path)) return;
			const match = /^#L([1-9]\d{0,6})(?:[-:]L?\d+)?$/i.exec(url.hash);
			const line = match ? Number(match[1]) : undefined;
			const id = createHmac("sha256", this.secret).update(`${path}\0${line ?? ""}`).digest("hex");
			const old = this.grants.get(id);
			const grant: Grant = Object.assign(old ?? {}, { id, path, line, name: safeName(name ?? old?.name ?? basename(path)) });
			this.grants.delete(id); this.grants.set(id, grant);
			while (this.grants.size > 2048) {
				const keys = this.grants.keys();
				let first = keys.next().value!;
				if (first === this.retained) first = keys.next().value!;
				this.grants.delete(first);
			}
			return { id, name: grant.name, line };
		} catch { return; }
	}
	observePath(path: string, cwd: string, name?: string, line?: number): FileReference | undefined {
		if (!path || path.length > 4000 || /[\x00-\x1f\x7f]/.test(path)) return;
		if (process.platform !== "win32" && (/^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\"))) return;
		try {
			if (path === "~") path = homedir();
			else if (path.startsWith("~/") || process.platform === "win32" && path.startsWith("~\\")) path = resolve(homedir(), path.slice(2));
			const url = pathToFileURL(resolve(cwd, path));
			if (Number.isSafeInteger(line) && line! > 0 && line! <= 9_999_999) url.hash = `L${line}`;
			return this.observe(url.href, cwd, name);
		} catch { return; }
	}
	private async opened<T>(path: string, operation: (file: FileHandle) => Promise<T>): Promise<T> {
		// NONBLOCK prevents a replaced FIFO from hanging open before fstat rejects it.
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try { return await operation(file); } finally { await file.close(); }
	}
	async command(command: FileCommand): Promise<unknown> {
		const grant = this.grants.get(command.id);
		if (!grant) throw new ExpiredReference("This file link is no longer available in the message.");
		this.grants.delete(command.id); this.grants.set(command.id, grant);
		if (command.operation === "info") {
			const path = await realpath(grant.path);
			if (!localPath(path)) throw new Error("Network and device paths cannot be opened here.");
			return this.opened(path, async file => {
				const version = await stamp(file);
				const head = await bytesAt(file, 0, Math.min(8192, version.size));
				if ((await stamp(file)).version !== version.version) throw new Error("File changed while opening it. Refresh the file.");
				const info: FileInfo = { id: grant.id, name: grant.name, line: grant.line, path, ...version, ...classify(head, head.length < version.size) };
				grant.snapshot = info;
				return info;
			});
		}
		const info = grant.snapshot ?? await this.command({ kind: "file", operation: "info", id: command.id }) as FileInfo;
		if (info.version !== command.version) throw new Error("File changed. Refresh it before continuing.");
		return this.opened(info.path, async file => {
			if ((await stamp(file)).version !== command.version) throw new Error("File changed. Refresh it before continuing.");
			let offset = command.offset ?? 0;
			if (command.operation === "text") {
				if (info.kind !== "text") throw new Error("This file has no UTF-8 text preview.");
				if (command.line !== undefined) {
					if (!Number.isSafeInteger(command.line) || command.line < 1 || command.line > 9_999_999) throw new Error("Invalid line number.");
					offset = 0;
					let line = 1;
					while (line < command.line && offset < info.size) {
						if (offset >= FILE_DOWNLOAD_LIMIT) throw new Error("That line is beyond the 128 MiB preview scan limit. Use Pi on the host for larger files.");
						const buffer = await bytesAt(file, offset, Math.min(FILE_CHUNK_BYTES, info.size - offset));
						const bytesRead = buffer.length;
						let used = bytesRead;
						for (let index = 0; index < bytesRead; index++) if (buffer[index] === 10 && ++line === command.line) { used = index + 1; break; }
						offset += used;
					}
					if (line < command.line) throw new Error("Line is past the end of this file.");
				}
			} else if (info.size > FILE_DOWNLOAD_LIMIT) throw new Error("Downloads are limited to 128 MiB per file.");
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size) throw new Error("Invalid file position.");
			const limit = command.operation === "text" ? 32_000 : FILE_CHUNK_BYTES;
			const bytes = await bytesAt(file, offset, Math.min(limit, info.size - offset));
			const bytesRead = bytes.length;
			if ((await stamp(file)).version !== command.version) throw new Error("File changed while reading. Refresh it.");
			if (command.operation === "chunk") return { offset, next: offset + bytesRead < info.size ? offset + bytesRead : null, base64: bytes.toString("base64") };
			let text: string;
			try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: offset + bytesRead < info.size }); }
			catch { throw new Error("This position is not valid UTF-8. Use the returned page positions or download the file."); }
			const next = offset + Buffer.byteLength(text);
			return { text, offset, next: next < info.size ? next : null, line: command.line } satisfies FileTextPage;
		});
	}
}
