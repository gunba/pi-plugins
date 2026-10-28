import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { setPriority } from "node:os";
import { fileURLToPath } from "node:url";
import type { SearchWorkerCommand, SearchWorkerOptions } from "./search-worker.ts";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
/**
 * A bounded RPC queue to the single owner of the search database and inference session. It is a child process, not a
 * thread, so that native inference cannot crash the host or add to its memory, and it runs at the lowest priority so
 * that hours of embedding never slow conversations or the desktop.
 */
export class SearchWorkerClient {
	private readonly child: ChildProcess;
	private pending = new Map<number, Pending>();
	private next = 0;
	private failure?: Error;
	private ending?: Promise<void>;
	constructor(options: SearchWorkerOptions, changed: (local: boolean) => void) {
		const built = new URL("./search-worker.js", import.meta.url);
		this.child = fork(fileURLToPath(existsSync(built) ? built : new URL("./search-worker.ts", import.meta.url)), [], {
			serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"],
			execArgv: [...process.execArgv.filter(argument => !argument.startsWith("--input-type")), "--max-old-space-size=768"],
		});
		try { setPriority(this.child.pid!, 19); } catch { /* It still works at normal priority. */ }
		this.child.on("message", (message: { id?: number; type?: string; local?: boolean; result?: unknown; error?: string }) => {
			if (message.type === "changed") { changed(message.local === true); return; }
			const pending = message.id === undefined ? undefined : this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id!); clearTimeout(pending.timer);
			if (message.error) pending.reject(Error(message.error)); else pending.resolve(message.result);
		});
		this.child.on("error", error => this.fail(error));
		this.child.on("exit", (code, signal) => this.fail(Error(`Conversation search worker stopped${code ? ` (${code})` : signal ? ` (${signal})` : ""}.`)));
		this.child.send(options);
	}
	/** Why the worker stopped, once it has; a new client must be made to search again. */
	get failed(): Error | undefined { return this.failure; }
	private fail(error: Error): void {
		this.failure ??= error;
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear();
	}
	call<T = unknown>(command: SearchWorkerCommand, timeout = 30_000): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.pending.size >= 64) return Promise.reject(Error("Conversation search is busy; try again shortly."));
		const id = ++this.next;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Conversation search did not answer in time.")); }, timeout); timer.unref();
			this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
			this.child.send({ id, command }, error => {
				if (!error || !this.pending.delete(id)) return;
				clearTimeout(timer); reject(error);
			});
		});
	}
	close(): Promise<void> {
		return this.ending ??= this.call({ action: "close" }, 10_000).catch(() => {}).then(async () => {
			if (this.child.exitCode === null && this.child.signalCode === null) {
				const exited = new Promise(resolve => this.child.once("exit", resolve));
				const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000); timer.unref();
				this.child.kill(); await exited; clearTimeout(timer);
			}
			this.fail(Error("Conversation search is closed."));
		});
	}
}
