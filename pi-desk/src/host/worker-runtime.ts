import plugins from "../../../package.json" with { type: "json" };
import { RELEASE } from "../shared/release.ts";
import type { DeskEngine } from "./engine.ts";
import type { PresentationSnapshot, SessionSnapshot, WorkerMessage, WorkerState } from "../shared/protocol.ts";
import { isControl } from "../shared/controls.ts";
import { WorkerEndpoint } from "./worker-channel.ts";
import { WorkerRequests } from "./worker-requests.ts";
import { WorkerControls } from "./worker-controls.ts";
import { readWorkerBootstrap, removeWorkerRecord, workerLease, writeWorkerFile } from "./worker-registry.ts";

type Engine = Pick<DeskEngine, "start" | "command" | "snapshot" | "checkpoint" | "shutdownCheckpoint" | "close">;
export interface WorkerRuntime { endpoint: WorkerEndpoint; closed: Promise<void>; stop(): Promise<void> }

/** Native loading begins after the host authenticates and requests initialization. */
export async function serveWorker(directory: string, factory: (send: (message: WorkerMessage) => void) => Promise<Engine>): Promise<WorkerRuntime> {
	const bootstrap = readWorkerBootstrap(directory);
	if (!bootstrap) throw new Error("Worker bootstrap is unavailable.");
	const lease = workerLease(directory);
	let endpoint: WorkerEndpoint | undefined;
	let initialized = false, nativeClosed = false;
	let engine: Engine | undefined;
	let snapshot: SessionSnapshot | undefined, ui: PresentationSnapshot | undefined, historyReady: string | undefined, initialGeneration: string | undefined;
	let stopJob: Promise<void> | undefined;
	let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
	const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
	void closed.catch(() => {});
	let engineJob: Promise<Engine> | undefined;
	const loadEngine = (): Promise<Engine> => {
		if (!engineJob) {
			engineJob = Promise.resolve().then(() => factory(message => {
				if (message.type === "snapshot") { snapshot = message.snapshot; ui = message.snapshot.ui; }
				if (message.type === "ui") ui = message.snapshot;
				if (message.type === "history_ready") historyReady = message.generation;
				endpoint?.publish(message);
			})).then(current => { engine = current; return current; });
			void engineJob.catch(() => { void stop().catch(() => {}); });
		}
		return engineJob;
	};
	const describe = (): WorkerState => {
		if (engine && initialized && !nativeClosed) { try { snapshot = engine.snapshot(); } catch { /* Keep the last valid snapshot during a transition. */ } }
		return { ...(snapshot ? { snapshot } : {}), runtime: { version: RELEASE.version, plugins: plugins.version, engine: RELEASE.engine, runtime: bootstrap.options.runtimeDirectory, unattended: true, sendNow: true }, controls: controls.snapshot(), ...(historyReady ? { historyReady } : {}), ...(initialGeneration ? { initialGeneration } : {}) };
	};
	const closeNative = async () => {
		if (!engineJob) { nativeClosed = true; return; }
		const current = await engineJob;
		const cursor = initialized ? await current.shutdownCheckpoint() : undefined;
		await current.close();
		nativeClosed = true;
		return cursor;
	};
	const controls = new WorkerControls(() => ui?.generation ?? snapshot?.ui.generation ?? "", async (command, _id, generation) => {
		if (command.kind === "close") return closeNative();
		const current = await loadEngine();
		const result = await current.command(generation, command);
		endpoint?.publish({ type: "snapshot", snapshot: current.snapshot() });
		return result;
	}, control => {
		endpoint?.publish({ type: "control", control });
		if (control.kind === "close" && control.state === "completed") setImmediate(() => { void stop().catch(() => {}); });
	});
	const requests: WorkerRequests = new WorkerRequests(async request => {
		if (request.type === "describe") return describe();
		if (request.type === "receipt") return requests.receipt(request.target, request.wait);
		if (request.type === "control") return controls.submit(request.command, request.generation, request.id);
		if (request.type === "shutdown") return closeNative();
		const current = await loadEngine();
		if (request.type === "init") {
			if (initialized) throw new Error("Worker already initialized.");
			initialized = true;
			snapshot = await current.start(bootstrap.options);
			initialGeneration = snapshot.ui.generation;
			return snapshot;
		}
		if (request.type === "checkpoint") return current.checkpoint(request.checkpoint, request.action);
		const result = await current.command(request.generation, request.command);
		if (isControl(request.command)) endpoint?.publish({ type: "snapshot", snapshot: current.snapshot() });
		return result;
	});
	const stop = (): Promise<void> => stopJob ??= (async () => {
		const errors: unknown[] = [];
		try { if (engineJob && !nativeClosed) await (await engineJob).close(); } catch (error) { errors.push(error); }
		try { await endpoint?.close(true); } catch (error) { errors.push(error); }
		try { removeWorkerRecord(directory, bootstrap.instance); } catch (error) { errors.push(error); }
		finally { lease.close(); }
		if (errors.length) throw new AggregateError(errors, "Worker shutdown encountered errors.");
	})().then(resolveClosed, error => { rejectClosed(error); throw error; });
	try {
		endpoint = await WorkerEndpoint.listen(bootstrap, async request => {
			const result = await requests.run(request);
			if (request.type === "shutdown" && (!result.error || request.force)) setImmediate(() => { void stop().catch(() => {}); });
			return result;
		}, () => {
			const state = describe(), messages: WorkerMessage[] = [];
			if (state.snapshot) messages.push({ type: "snapshot", snapshot: state.snapshot });
			else if (ui) messages.push({ type: "ui", snapshot: ui });
			if (historyReady) messages.push({ type: "history_ready", generation: historyReady });
			messages.push(...state.controls.map(control => ({ type: "control" as const, control })));
			return messages;
		});
		writeWorkerFile(directory, "worker.json", { ...endpoint.address, version: 1, pid: process.pid,
			runtimeDirectory: bootstrap.options.runtimeDirectory });
		if (bootstrap.options.runtimeDirectory) process.env.PI_DESK_RUNTIME = bootstrap.options.runtimeDirectory;
		return { endpoint, closed, stop };
	} catch (error) {
		await endpoint?.close();
		lease.close();
		throw error;
	}
}
