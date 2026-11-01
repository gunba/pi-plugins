import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { progressComplete, progressParser, type ProgressSample, type ProgressSource, type ProgressStatus } from "../../../pi-ui/agent-progress.ts";

const BACKOFF_AFTER = 2 * 60_000, EXPIRE_AFTER = 30 * 60_000;

/** Tails a regular file until completion or expiry, retaining one incomplete line and one sample. */
export class ProgressPipe {
	private offset = 0;
	private identity = "";
	private modified = 0;
	private pending = "";
	private decoder = new StringDecoder("utf8");
	private dropping = false;
	private polling?: Promise<void>;
	private closed = false;
	private changed = Date.now();
	private size = 0;
	private sample?: ProgressSample;
	private accepted?: number;
	private invalid = false;
	private signature = "";
	private readonly parse: (line: string) => ProgressSample | undefined;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly source: ProgressSource;
	private readonly update: (sample: ProgressSample | undefined, status: ProgressStatus) => void;
	constructor(source: ProgressSource, update: (sample: ProgressSample | undefined, status: ProgressStatus) => void) {
		this.source = source; this.update = update;
		this.parse = progressParser(source);
		void this.poll();
	}
	get stopped(): boolean { return this.closed; }
	close(): void { this.closed = true; clearTimeout(this.timer); this.timer = undefined; }
	private publish(state: ProgressStatus["state"], detail?: string): void {
		if (this.closed) return;
		const status: ProgressStatus = { state, ...(this.accepted !== undefined ? { at: this.accepted } : {}), ...(detail ? { detail } : {}) };
		const signature = JSON.stringify([this.sample, status]);
		if (signature === this.signature) return;
		this.signature = signature; this.update(this.sample, status);
	}
	/** Concurrent callers share the in-flight read; each completed read arms at most one timer. */
	poll(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.polling) return this.polling;
		clearTimeout(this.timer); this.timer = undefined;
		this.polling = this.read().finally(() => {
			this.polling = undefined;
			if (this.closed) return;
			const idle = Date.now() - this.changed;
			if (idle >= EXPIRE_AFTER) { this.expire(); return; }
			this.timer = setTimeout(() => void this.poll(), Math.min(idle >= BACKOFF_AFTER ? 10_000 : 500, EXPIRE_AFTER - idle));
			this.timer.unref();
		});
		return this.polling;
	}
	private expire(): void {
		this.publish("stale", "Progress watching stopped after 30 minutes without a file change. Reload the conversation or re-show this part to resume.");
		this.close();
	}
	private async read(): Promise<void> {
		try {
			const stat = await lstat(this.source.file);
			if (!stat.isFile()) { this.publish("unavailable", "Progress source is not a regular file."); return; }
			const file = await open(this.source.file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
			try {
				const current = await file.stat();
				if (!current.isFile()) { this.publish("unavailable"); return; }
				const identity = `${current.dev}:${current.ino}`;
				if (identity !== this.identity || current.size !== this.size || current.mtimeMs !== this.modified) this.changed = Date.now();
				this.size = current.size;
				if (identity !== this.identity || current.size < this.offset || current.size === this.offset && current.mtimeMs !== this.modified) {
					this.offset = 0; this.pending = ""; this.decoder = new StringDecoder("utf8"); this.dropping = false;
				}
				this.identity = identity; this.modified = current.mtimeMs;
				if (current.size - this.offset > 65_536) {
					this.offset = current.size - 65_536; this.pending = ""; this.decoder = new StringDecoder("utf8"); this.dropping = true;
				}
				if (current.size > this.offset) {
					const buffer = Buffer.alloc(Math.min(65_536, current.size - this.offset));
					const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset); this.offset += bytesRead;
					const lines = (this.pending + this.decoder.write(buffer.subarray(0, bytesRead))).split("\n"); this.pending = lines.pop()!;
					let valid = false, invalid = false;
					for (const line of lines) {
						if (this.dropping) { this.dropping = false; continue; }
						const sample = this.parse(line);
						if (sample) {
							this.sample = sample; this.accepted = Date.now(); valid = true; invalid = false;
							if (progressComplete(sample)) { this.publish("complete"); this.close(); return; }
						}
						else if (line.trim()) invalid = true;
					}
					if (this.pending.length > 16_384) { this.pending = ""; this.dropping = true; invalid = true; }
					if (invalid || valid) this.invalid = invalid;
					if (invalid) { this.publish("invalid", "Waiting for a valid progress line."); return; }
					if (valid) { this.publish("live"); return; }
				}
				this.publish(this.invalid ? "invalid" : this.accepted === undefined ? "waiting" : Date.now() - this.accepted > 15_000 ? "stale" : "live", this.invalid ? "Waiting for a valid progress line." : undefined);
			} finally { await file.close(); }
		} catch (error) {
			this.publish((error as NodeJS.ErrnoException).code === "ENOENT" && !this.sample ? "waiting" : "unavailable", "Waiting for the progress file.");
		}
	}
}
