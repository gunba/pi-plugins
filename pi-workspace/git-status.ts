import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);
export class GitStatus {
	value: string | null = null;
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private closed = false;
	private running = false;
	private pending = false;
	private abort = new AbortController();
	private requests = new Set<Promise<unknown>>();
	private children = new Set<Promise<void>>();
	private cwd: string;
	private changed: () => void;
	private error: (message: string) => void;
	constructor(cwd: string, changed: () => void, error: (message: string) => void) {
		this.cwd = cwd;
		this.changed = changed;
		this.error = error;
	}
	private async git(args: string[]): Promise<string> {
		const request = execute("git", ["--no-optional-locks", "-C", this.cwd, ...args], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 10_000,
			maxBuffer: 8192,
			signal: this.abort.signal,
		});
		this.requests.add(request);
		const closed = new Promise<void>((resolve) => request.child.once("close", () => resolve()));
		this.children.add(closed);
		void closed.then(() => this.children.delete(closed));
		try {
			return (await request).stdout.trim();
		} finally {
			this.requests.delete(request);
		}
	}
	async start(): Promise<void> {
		let directory;
		try {
			directory = await this.git(["rev-parse", "--absolute-git-dir"]);
		} catch (error) {
			if (
				this.closed ||
				String((error as { stderr?: string }).stderr).includes("not a git repository")
			)
				return;
			throw error;
		}
		if (this.closed) return;
		this.watcher = watch(directory, () => {
			clearTimeout(this.timer);
			this.timer = setTimeout(() => void this.refresh(), 150);
			this.timer.unref();
		});
		this.watcher.on("error", (error) => this.error(`Git status watcher: ${error.message}`));
		this.watcher.unref();
		await this.refresh();
	}
	async refresh(): Promise<void> {
		if (this.closed) return;
		if (this.running) {
			this.pending = true;
			return;
		}
		this.running = true;
		try {
			const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
				(error) => {
					if ((error as { code?: number }).code === 1) return "detached";
					throw error;
				},
			);
			if (!this.closed && this.value !== branch) {
				this.value = branch;
				this.changed();
			}
		} catch (error) {
			if (!this.closed) this.error(`Git status: ${String(error)}`);
		} finally {
			this.running = false;
			if (this.pending) {
				this.pending = false;
				void this.refresh();
			}
		}
	}
	async dispose(): Promise<void> {
		this.closed = true;
		this.watcher?.close();
		clearTimeout(this.timer);
		this.abort.abort();
		await Promise.allSettled([...this.requests, ...this.children]);
	}
}
