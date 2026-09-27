import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { captureSource, within, writeSource } from "./source.ts";
import { atomicJson, readRelease, readState, runtimeId, versionDirectory, type RuntimeRelease } from "./store.ts";

/** Invoke npm's JS entry with this Node, including on Windows without a cmd shim. */
export function npmEntry(): string {
	const candidates = [
		process.env.npm_execpath,
		join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
		join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		...(process.env.PATH ?? "").split(delimiter).flatMap(path => [
			join(path, "node_modules", "npm", "bin", "npm-cli.js"), join(path, "npm"),
		]),
	];
	for (const candidate of candidates) {
		if (!candidate || !existsSync(candidate)) continue;
		const path = realpathSync(candidate);
		if (/[/\\]npm-cli\.js$/.test(path) && statSync(path).isFile()) return path;
	}
	throw new Error("Cannot find npm-cli.js. Install npm alongside the Node executable used by Pi.");
}
export interface StageOptions {
	source: string; home: string; signal?: AbortSignal; progress?: (phase: string) => void;
}
export async function stageRuntime(options: StageOptions): Promise<RuntimeRelease> {
	const source = realpathSync(options.source);
	let home = resolve(options.home);
	if (within(source, home) || within(home, source)) throw new Error("Runtime storage must be outside the installed source package.");
	await mkdir(home, { recursive: true, mode: 0o700 });
	home = realpathSync(home);
	if (within(source, home) || within(home, source)) throw new Error("Runtime storage must be outside the installed source package.");
	const lock = new SessionLease(join(home, "manage"));
	let temporary: string | undefined;
	let log: number | undefined;
	const progress = (phase: string) => { options.signal?.throwIfAborted(); writeSync(log!, `\n${phase}\n`); options.progress?.(phase); };
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
	environment.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
	const run = async (cwd: string, args: string[]) => {
		options.signal?.throwIfAborted();
		await new Promise<void>((accept, reject) => {
			// Finish the current npm step before honouring cancellation. Killing npm
			// alone can leave a compiler writing into a directory being removed.
			const child = spawn(process.execPath, args, { cwd, env: environment, windowsHide: true, stdio: ["ignore", log!, log!] });
			child.once("error", reject);
			child.once("close", code => code === 0 ? accept() : reject(new Error(`Runtime preparation exited ${code ?? "by signal"}. See ${join(home, "stage.log")}.`)));
		});
	};
	try {
		log = openSync(join(home, "stage.log"), "w", 0o600);
		const state = readState(home);
		if (state && realpathSync(state.source) !== source) throw new Error("This runtime installation belongs to another source package.");
		progress("Snapshotting installed Pi package");
		const snapshot = await captureSource(source), id = runtimeId(snapshot), destination = versionDirectory(home, id);
		if (existsSync(destination)) {
			const release = readRelease(home, id);
			atomicJson(join(home, "state.json"), { ...state, format: 1, source, pending: state?.active === id ? undefined : id });
			return release;
		}
		await mkdir(join(home, "versions"), { recursive: true, mode: 0o700 });
		temporary = await mkdtemp(join(home, ".staging-"));
		const copy = join(temporary, "source");
		await writeSource(snapshot, copy);
		if ((await captureSource(source)).digest !== snapshot.digest) throw new Error("The installed package changed during its snapshot. Stage again after the Pi update finishes.");
		const npm = npmEntry(), app = join(copy, "pi-desk");
		progress("Installing locked first-party dependencies");
		await run(copy, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
		progress("Installing locked Desk build dependencies");
		await run(app, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
		progress("Building Desk");
		await run(app, [npm, "run", "build"]);
		progress("Removing build-only dependencies");
		await run(app, [npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
		progress("Preparing protected credential storage");
		await run(app, [npm, "rebuild", "keytar", "--ignore-scripts=false"]);
		progress("Checking staged runtime");
		await run(app, [join(app, "dist", "host", "cli.js"), "--help"]);
		await run(app, ["--input-type=module", "-e", 'import {createRequire} from "node:module"; createRequire(process.cwd()+"/package.json")("keytar");']);
		options.signal?.throwIfAborted();
		const release: RuntimeRelease = {
			format: 1, id, source, digest: snapshot.digest, plugins: snapshot.plugins, desk: snapshot.desk, engine: snapshot.engine,
			platform: process.platform, arch: process.arch, node: process.versions.modules, readyAt: new Date().toISOString(),
		};
		atomicJson(join(temporary, "runtime.json"), release);
		await rename(temporary, destination); temporary = undefined;
		readRelease(home, id);
		atomicJson(join(home, "state.json"), { ...state, format: 1, source, pending: state?.active === id ? undefined : id });
		writeSync(log, "\nReady; active runtime unchanged\n"); options.progress?.("Ready; active runtime unchanged");
		return release;
	} finally {
		try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
		finally { if (log !== undefined) closeSync(log); lock.close(); }
	}
}
