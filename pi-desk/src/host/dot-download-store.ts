import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { DotDownload } from "../shared/dot.ts";

const FILE_LIMIT = 128 * 1024 * 1024, CACHE_LIMIT = 256 * 1024 * 1024;
const safeName = (value: string) => basename(value.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").slice(0, 200).replace(/[. ]+$/, "") || "Download";
type DownloadAction = (path: string, maximum: number, signal: AbortSignal) => Promise<Omit<DotDownload, "id">>;

/** Private, disposable file handles, never signed URLs or a whole-file base64 response. */
export class DotDownloadStore {
	private directory: string;
	private files = new Map<string, DotDownload & { created: number }>();
	private jobs = new Set<Promise<DotDownload>>();
	private abort = new AbortController();
	private closed = false;
	constructor(directory: string) {
		this.directory = join(directory, "downloads"); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		// No handles survive a host restart. Remove only this cache's orphaned file format.
		for (const name of readdirSync(this.directory)) if (/^[a-f0-9-]{36}\.bin$/.test(name)) rmSync(join(this.directory, name), { force: true });
	}
	private path(id: string): string {
		if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw Error("Invalid Dot download.");
		return join(this.directory, `${id}.bin`);
	}
	private async prune(): Promise<void> {
		for (const [id, file] of this.files) if (Date.now() - file.created > 3_600_000) await this.release(id);
	}
	async create(action: DownloadAction): Promise<DotDownload> {
		await this.prune();
		if (this.closed || this.abort.signal.aborted) throw Error("Dot downloads are closed.");
		const bytes = [...this.files.values()].reduce((sum, file) => sum + file.size, 0);
		if (this.files.size + this.jobs.size >= 16 || bytes + (this.jobs.size + 1) * FILE_LIMIT > CACHE_LIMIT)
			throw Error("Finish current Dot downloads before opening more files.");
		const id = randomUUID(), path = this.path(id), signal = this.abort.signal;
		const job = (async () => {
			try {
				const result = await action(path, FILE_LIMIT, signal); signal.throwIfAborted();
				if (!Number.isSafeInteger(result.size) || result.size < 0 || result.size > FILE_LIMIT) throw Error("Invalid Dot download size.");
				const file: DotDownload = { ...result, id, name: safeName(result.name), mime: /^[\w.+-]+\/[\w.+-]+$/.test(result.mime) ? result.mime : "application/octet-stream" };
				this.files.set(id, { ...file, created: Date.now() }); return file;
			} catch (error) { await rm(path, { force: true }); throw error; }
		})().finally(() => this.jobs.delete(job));
		this.jobs.add(job); return job;
	}
	async chunk(id: string, offset: number): Promise<{ data: string; next: number; size: number }> {
		await this.prune();
		const file = this.files.get(id);
		if (!file || !Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw Error("Dot download expired. Open the attachment again.");
		const handle = await open(this.path(id), "r");
		try {
			if ((await handle.stat()).size !== file.size) throw Error("Dot download changed. Open the attachment again.");
			const bytes = Buffer.alloc(Math.min(256 * 1024, file.size - offset));
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
			if (bytesRead !== bytes.length) throw Error("Dot download was interrupted.");
			return { data: bytes.toString("base64"), next: offset + bytesRead, size: file.size };
		} finally { await handle.close(); }
	}
	async release(id: string): Promise<void> { await rm(this.path(id), { force: true }); this.files.delete(id); }
	async clear(): Promise<void> {
		this.abort.abort(); await Promise.allSettled(this.jobs);
		await Promise.all([...this.files.keys()].map(id => this.release(id))); this.abort = new AbortController();
	}
	async close(): Promise<void> { this.closed = true; await this.clear(); }
}
