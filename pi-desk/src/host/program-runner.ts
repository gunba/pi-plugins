import { errorText, PROGRAM_LIMIT_MS } from "../../../pi-watch/common.ts";
import type { WorkerMessage } from "../shared/protocol.ts";
import { SessionWorker } from "./worker-client.ts";

/** A run that hasn't answered this long after its own limit has a stuck worker, which is stopped. */
const STUCK_MS = PROGRAM_LIMIT_MS + 30_000;

interface Runner { worker: SessionWorker; ready: Promise<SessionWorker>; queue: Promise<unknown> }

/**
 * Runs program watches' programs for Desk: in a background Pi process for each folder, with that folder's tools, kept
 * while program watches there need it. No one sees these processes, so a question or approval asked in one is refused
 * at once; the run carries on with the refusal and its result says so.
 */
export class ProgramRunner {
	private readonly options: { agentDir: string; sessionDir?: string; deskDirectory: string };
	private readonly runners = new Map<string, Runner>();
	private closed = false;

	constructor(options: { agentDir: string; sessionDir?: string; deskDirectory: string }) { this.options = options; }

	/** Runs `code` in `cwd`'s process, after any run already there; its result as text. */
	async run(cwd: string, code: string, signal: AbortSignal): Promise<string> {
		if (this.closed) return "(could not run: Desk is stopping)";
		const runner = this.runner(cwd);
		const job = runner.queue.then(async () => {
			if (signal.aborted) return "(stopped)";
			const worker = await runner.ready;
			let timer: NodeJS.Timeout | undefined;
			const stuck = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("the program didn't finish")), STUCK_MS); });
			try {
				const result = await Promise.race([worker.command({ kind: "program", code }), stuck]) as { text?: unknown } | undefined;
				return typeof result?.text === "string" ? result.text : "";
			} finally { clearTimeout(timer); }
		});
		runner.queue = job.catch(() => undefined);
		try { return await job; }
		catch (error) {
			this.drop(cwd, runner);
			return `(failed: ${errorText(error)})`;
		}
	}

	/** Stops the processes of folders no program watch uses now. */
	retain(folders: ReadonlySet<string>): void {
		for (const [cwd, runner] of this.runners) if (!folders.has(cwd)) this.drop(cwd, runner);
	}

	async close(): Promise<void> {
		this.closed = true;
		const runners = [...this.runners.values()];
		this.runners.clear();
		await Promise.allSettled(runners.map(runner => runner.worker.close(true)));
	}

	private runner(cwd: string): Runner {
		const existing = this.runners.get(cwd);
		if (existing) return existing;
		const worker: SessionWorker = new SessionWorker({ cwd, agentDir: this.options.agentDir, sessionDir: this.options.sessionDir,
			deskDirectory: this.options.deskDirectory, ephemeral: true, background: "programs" }, message => this.event(cwd, worker, message));
		const runner: Runner = { worker, ready: worker.start().then(() => worker), queue: Promise.resolve() };
		this.runners.set(cwd, runner);
		runner.ready.catch(error => {
			console.error(`The background Pi process for watch programs in ${cwd} could not start:`, errorText(error));
			this.drop(cwd, runner);
		});
		return runner;
	}

	private event(cwd: string, worker: SessionWorker, message: WorkerMessage): void {
		if (message.type === "ui") for (const item of message.snapshot.interactions)
			void worker.command({ kind: "answer", id: item.id, answer: null }, message.snapshot.generation).catch(() => {});
		if (message.type === "fatal" || message.type === "detached") {
			const runner = this.runners.get(cwd);
			if (runner?.worker === worker) this.drop(cwd, runner);
		}
	}

	private drop(cwd: string, runner: Runner): void {
		if (this.runners.get(cwd) === runner) this.runners.delete(cwd);
		void runner.worker.close(true).catch(() => {});
	}
}
