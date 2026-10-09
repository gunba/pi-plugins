import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { captureSource, within, writeSource } from "./source.ts";
import { reclaimSpace, unpackDependencies, type VerifiedDependencies } from "./artifact.ts";
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
	dependencies?: VerifiedDependencies;
}

/** Borrow only declared build tools; never link or modify the checkout's node_modules directory. */
async function withBuildDependencies(source: string, app: string, temporary: string, build: () => Promise<void>): Promise<void> {
	const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
	const backupRoot = join(temporary, ".build-dependencies");
	const borrowed: { path: string; backup?: string; linked: boolean }[] = [];
	try {
		for (const name of Object.keys(pkg.devDependencies ?? {})) {
			if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error("Invalid build dependency name.");
			const target = await realpath(join(source, "pi-desk", "node_modules", name));
			const path = join(app, "node_modules", name), item: typeof borrowed[number] = { path, linked: false };
			borrowed.push(item);
			try {
				await lstat(path);
				const backup = join(backupRoot, name); await mkdir(dirname(backup), { recursive: true });
				await rename(path, backup); item.backup = backup;
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await mkdir(dirname(path), { recursive: true });
			await symlink(target, path, process.platform === "win32" ? "junction" : "dir"); item.linked = true;
		}
		await build();
	} finally {
		const settled = await Promise.allSettled(borrowed.map(async item => {
			if (item.linked) await unlink(item.path);
			if (item.backup) await rename(item.backup, item.path);
		}));
		const failed = settled.find(result => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		await rm(backupRoot, { recursive: true, force: true });
	}
}
/** npm uses absolute junctions for Windows workspaces; moving the snapshot must retarget them. */
async function relocateJunctions(root: string, destination: string): Promise<void> {
	if (process.platform !== "win32") return;
	const links: { path: string; target: string }[] = [];
	const visit = async (directory: string) => {
		for (const item of await readdir(directory, { withFileTypes: true })) {
			const file = join(directory, item.name);
			if (item.isSymbolicLink()) {
				const target = await realpath(file);
				if (!(await lstat(target)).isDirectory()) continue;
				if (!within(root, target)) throw new Error(`A runtime dependency points outside its snapshot: ${file} -> ${target} (root ${root}).`);
				links.push({ path: file, target: join(destination, relative(root, target)) });
			} else if (item.isDirectory()) await visit(file);
		}
	};
	await visit(root);
	for (const item of links) {
		await unlink(item.path);
		await symlink(item.target, item.path, "junction");
	}
}
export async function stageRuntime(options: StageOptions): Promise<RuntimeRelease> {
	const source = realpathSync(options.source);
	let home = resolve(options.home);
	if (within(source, home) || within(home, source)) throw new Error("Runtime storage must be outside the installed source package.");
	await mkdir(home, { recursive: true, mode: 0o700 });
	// Use native canonical paths on both sides of junction containment checks.
	// Windows TEMP can use an 8.3 alias while realpath(junction) returns its long name.
	home = await realpath(home);
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
			atomicJson(join(home, "state.json"), { ...state, format: 1, source, pending: state?.active === id ? undefined : id, autoApply: undefined });
			return release;
		}
		await mkdir(join(home, "versions"), { recursive: true, mode: 0o700 });
		await reclaimSpace(home, progress, options.dependencies?.file);
		temporary = await mkdtemp(join(home, ".staging-"));
		const copy = join(temporary, "source");
		await writeSource(snapshot, copy);
		if ((await captureSource(source)).digest !== snapshot.digest) throw new Error("The installed package changed during its snapshot. Stage again after the Pi update finishes.");
		const npm = npmEntry(), app = join(copy, "pi-desk");
		if (options.dependencies) {
			progress("Restoring verified production dependencies");
			await unpackDependencies(temporary, options.dependencies);
			progress("Building Desk with locked checkout build tools");
			await withBuildDependencies(source, app, temporary, () => run(app, [npm, "run", "build"]));
		} else {
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
		}
		progress("Checking staged runtime");
		await run(app, [join(app, "dist", "host", "cli.js"), "--help"]);
		await run(app, ["--input-type=module", "-e", 'import {createRequire} from "node:module"; createRequire(process.cwd()+"/package.json")("keytar");']);
		options.signal?.throwIfAborted();
		const release: RuntimeRelease = {
			format: 1, id, source, digest: snapshot.digest, plugins: snapshot.plugins, desk: snapshot.desk, engine: snapshot.engine,
			platform: process.platform, arch: process.arch, node: process.versions.modules, readyAt: new Date().toISOString(),
		};
		atomicJson(join(temporary, "runtime.json"), release);
		await relocateJunctions(temporary, destination);
		await rename(temporary, destination); temporary = undefined;
		readRelease(home, id);
		atomicJson(join(home, "state.json"), { ...state, format: 1, source, pending: state?.active === id ? undefined : id, autoApply: undefined });
		writeSync(log, "\nReady; active runtime unchanged\n"); options.progress?.("Ready; active runtime unchanged");
		return release;
	} finally {
		try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
		finally { if (log !== undefined) closeSync(log); lock.close(); }
	}
}
