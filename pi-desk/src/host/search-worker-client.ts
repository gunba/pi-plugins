import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { SearchWorkerCommand, SearchWorkerOptions } from "./search-worker.ts";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
/** A bounded RPC queue to the single owner of the search database and inference session. */
export class SearchWorkerClient {
	private readonly worker: Worker;
	private pending = new Map<number, Pending>();
	private next = 0;
	private failed?: Error;
	private ending?: Promise<void>;
	constructor(options: SearchWorkerOptions, changed: (local: boolean) => void) {
		const built = new URL("./search-worker.js", import.meta.url);
		this.worker = new Worker(existsSync(built) ? built : new URL("./search-worker.ts", import.meta.url), {
			workerData: options, resourceLimits: { maxOldGenerationSizeMb: 768 },
			execArgv: process.execArgv.filter(argument => !argument.startsWith("--input-type")),
		});
		this.worker.on("message", (message: { id?: number; type?: string; local?: boolean; result?: unknown; error?: string }) => {
			if (message.type === "changed") { changed(message.local === true); return; }
			const pending = message.id === undefined ? undefined : this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id!); clearTimeout(pending.timer);
			if (message.error) pending.reject(Error(message.error)); else pending.resolve(message.result);
		});
		this.worker.on("error", error => this.fail(error));
		this.worker.on("exit", code => this.fail(Error(`Conversation search worker stopped${code ? ` (${code})` : ""}.`)));
	}
	private fail(error: Error): void {
		this.failed = error;
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear();
	}
	call<T = unknown>(command: SearchWorkerCommand, timeout = 30_000): Promise<T> {
		if (this.failed) return Promise.reject(this.failed);
		if (this.pending.size >= 64) return Promise.reject(Error("Conversation search is busy; try again shortly."));
		const id = ++this.next;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Conversation search did not answer in time.")); }, timeout); timer.unref();
			this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
			try { this.worker.postMessage({ id, command }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
		});
	}
	close(): Promise<void> {
		return this.ending ??= this.call({ action: "close" }, 10_000).catch(() => {}).then(async () => {
			await this.worker.terminate(); this.fail(Error("Conversation search is closed."));
		});
	}
}
