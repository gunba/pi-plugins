import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, link } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { SessionLease } from "../../pi-session-ownership/lease.ts";
import { publishDirectory, retryablePublicationError } from "../src/host/file-publication.ts";
import { pruneRuntimes } from "./prune.ts";
import { within } from "./source.ts";
import { atomicJson, readRelease, readState, runtimeIdentity, validId, versionDirectory, type RuntimeRelease } from "./store.ts";

export interface ReleaseAsset { name: string; size: number; sha256: string }

/** Free unused runtime slots before unpacking another full runtime. Never blocks an update. */
export async function reclaimSpace(home: string, progress?: (message: string) => void, keepArchive?: string): Promise<void> {
	try {
		const result = await pruneRuntimes(home, keepArchive);
		if (result.skipped) progress?.(`Kept old runtimes: ${result.skipped}`);
		else if (result.removed.length || result.busy.length || result.archives)
			progress?.(`Removed ${result.removed.length} unused runtimes and ${result.archives} archives${result.busy.length ? `; ${result.busy.length} in use were kept` : ""}`);
	} catch (error) { progress?.(`Could not remove old runtimes: ${String(error)}`); }
}
interface RuntimeLink { path: string; target: string; directory: boolean }
export interface VerifiedDependencies { artifact: RuntimeArtifact; file: string }
export interface RuntimeArtifact {
	format: 1; commit: string; sourceDigest: string;
	runtime: Omit<RuntimeRelease, "source" | "readyAt" | "artifact">;
	code: ReleaseAsset; dependencies: ReleaseAsset; links: RuntimeLink[];
}
const version = /^\d+\.\d+\.\d+$/;
const execute = promisify(execFile);
const safeName = (name: unknown): name is string => typeof name === "string" && /^[a-z0-9][a-z0-9._-]{0,220}$/.test(name);
const sourcePath = (path: unknown): path is string => typeof path === "string" && path.startsWith("source/")
	&& !path.includes("\\") && !path.includes(":") && !path.includes("\0")
	&& path.split("/").every(part => part && part !== "." && part !== "..");
const dependencyPath = (path: string) => path.split("/").includes("node_modules");
const payloadDigest = (value: Pick<RuntimeArtifact, "sourceDigest" | "code" | "dependencies" | "links">): string =>
	createHash("sha256").update(JSON.stringify([value.sourceDigest, value.code.sha256, value.dependencies.sha256, value.links])).digest("hex");

export const artifactName = (desk: string) => `pi-desk-${desk}-${process.platform}-${process.arch}-node${process.versions.modules}.json`;
export async function sha256(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}
export function runtimeArtifact(input: unknown): RuntimeArtifact {
	const value = input as RuntimeArtifact, r = value?.runtime;
	if (value?.format !== 1 || !/^[a-f0-9]{40,64}$/.test(value.commit) || !validId(value.sourceDigest) || !r || r.format !== 1
		|| !validId(r.id) || !validId(r.digest) || r.platform !== process.platform || r.arch !== process.arch
		|| r.node !== process.versions.modules || runtimeIdentity(r.digest, r.platform, r.arch, r.node) !== r.id
		|| ![r.desk, r.plugins, r.engine].every(v => typeof v === "string" && version.test(v)))
		throw new Error("The release does not match this platform and Node runtime.");
	for (const asset of [value.code, value.dependencies]) {
		if (!asset || !safeName(asset.name) || !asset.name.endsWith(".tgz") || !validId(asset.sha256)
			|| !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 512 * 1024 * 1024)
			throw new Error("Invalid runtime release asset.");
	}
	if (!Array.isArray(value.links) || value.links.length > 5000
		|| value.links.some(item => !sourcePath(item.path) || !sourcePath(item.target) || typeof item.directory !== "boolean"))
		throw new Error("Invalid runtime links.");
	if (payloadDigest(value) !== r.digest) throw new Error("Runtime identity does not match its payloads.");
	return value;
}
export async function verify(file: string, asset: ReleaseAsset): Promise<void> {
	const info = await lstat(file);
	if (!info.isFile() || info.size !== asset.size || await sha256(file) !== asset.sha256)
		throw new Error(`Integrity check failed for ${asset.name}.`);
}

async function unpack(root: string, archives: { file: string; dependency: boolean }[], progress?: (message: string) => void): Promise<void> {
	let bytes = 0, entries = 0;
	for (const { file, dependency } of archives) {
		progress?.(dependency ? "Extracting runtime dependencies" : "Extracting Desk code");
		await tar.extract({
			cwd: root, file, strict: true, preservePaths: false,
			filter(path, entry) {
				if (!sourcePath(path) || !("type" in entry) || !["File", "Directory"].includes(entry.type) || dependencyPath(path) !== dependency
					|| ++entries > 100_000 || (bytes += entry.size ?? 0) > 2 * 1024 * 1024 * 1024)
					throw new Error("Runtime archive contains an invalid entry.");
				return true;
			},
		});
	}
}
/**
 * Hard-link an installed version's files for an identical dependency archive instead of extracting it again.
 * Every archive entry must exist there with the same size; otherwise the caller extracts normally.
 */
export async function reuseDependencies(home: string, root: string, sha256: string, archive: string, progress?: (message: string) => void): Promise<boolean> {
	let source: string | undefined;
	for (const id of await readdir(join(home, "versions")).catch(() => [] as string[])) {
		if (!validId(id)) continue;
		try {
			if (JSON.parse(await readFile(join(home, "versions", id, "runtime.json"), "utf8"))?.artifact?.dependencies === sha256) { source = join(home, "versions", id); break; }
		} catch { /* Not a complete runtime. */ }
	}
	if (!source) return false;
	try {
		const entries: { path: string; size: number; directory: boolean }[] = [];
		await tar.list({ file: archive, strict: true, onReadEntry: entry => {
			if (!sourcePath(entry.path) || !["File", "Directory"].includes(entry.type) || !dependencyPath(entry.path) || entries.length >= 100_000)
				throw new Error("Runtime archive contains an invalid entry.");
			entries.push({ path: entry.path, size: entry.size ?? 0, directory: entry.type === "Directory" });
			entry.resume();
		} });
		progress?.("Reusing unchanged runtime dependencies");
		for (const entry of entries) {
			const target = join(root, entry.path);
			if (entry.directory) { await mkdir(target, { recursive: true }); continue; }
			const from = join(source, entry.path), info = await lstat(from);
			if (!info.isFile() || info.size !== entry.size) throw new Error(`Installed dependency differs: ${entry.path}`);
			await mkdir(dirname(target), { recursive: true });
			await link(from, target);
		}
		return true;
	} catch (error) {
		progress?.(`Extracting dependencies instead of reusing them: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
async function restoreLinks(root: string, destination: string, links: RuntimeLink[]): Promise<void> {
	for (const item of links) {
		const target = join(root, item.target), path = join(root, item.path);
		await mkdir(dirname(path), { recursive: true });
		if (!within(root, await realpath(dirname(path))) || !within(root, await realpath(target))
			|| (await lstat(target)).isDirectory() !== item.directory) throw new Error("Runtime link target is invalid.");
		if (process.platform === "win32") {
			if (item.directory) await symlink(join(destination, item.target), path, "junction");
			else await link(target, path);
		} else await symlink(relative(dirname(path), target), path, item.directory ? "dir" : "file");
	}
}

/** Rehydrate only verified dependencies into a fresh source snapshot. */
export async function unpackDependencies(root: string, bundle: VerifiedDependencies): Promise<void> {
	const artifact = runtimeArtifact(bundle.artifact);
	await verify(bundle.file, artifact.dependencies);
	await unpack(root, [{ file: bundle.file, dependency: true }]);
	await restoreLinks(root, root, artifact.links.filter(item => dependencyPath(item.path)));
}

/** CI packs regular files separately from relocatable links and reusable dependencies. */
export async function packRuntime(home: string, id: string, output: string, commit: string, cached?: VerifiedDependencies): Promise<string> {
	const release = readRelease(home, id), root = await realpath(versionDirectory(home, id));
	await mkdir(output, { recursive: true });
	const code: string[] = [], dependencies: string[] = [], links: RuntimeLink[] = [];
	const visit = async (path: string) => {
		for (const item of await readdir(join(root, path), { withFileTypes: true })) {
			const name = `${path}/${item.name}`, file = join(root, name);
			if (item.name === ".package-lock.json" || cached && item.name === "node_modules") continue;
			if (item.isSymbolicLink()) {
				const target = await realpath(file);
				if (!within(root, target)) throw new Error(`Runtime link escapes the release: ${name}`);
				links.push({ path: name, target: relative(root, target).split(sep).join("/"), directory: (await lstat(target)).isDirectory() });
			} else if (item.isDirectory()) await visit(name);
			else if (item.isFile()) (dependencyPath(name) ? dependencies : code).push(name);
			else throw new Error(`Unsupported runtime file: ${name}`);
		}
	};
	await visit("source");
	const pack = async (files: string[], name: string): Promise<ReleaseAsset> => {
		const file = join(output, name);
		await tar.create({ cwd: root, file, gzip: true, portable: true, mtime: new Date(0), noDirRecurse: true, strict: true }, files.sort());
		return { name, size: (await lstat(file)).size, sha256: await sha256(file) };
	};
	const prefix = artifactName(release.desk).replace(/\.json$/, "");
	const reuse = async () => {
		const artifact = runtimeArtifact(cached!.artifact);
		await verify(cached!.file, artifact.dependencies);
		const target = join(output, artifact.dependencies.name);
		if (resolve(cached!.file) !== resolve(target)) await copyFile(cached!.file, target);
		links.push(...artifact.links.filter(item => dependencyPath(item.path)));
		return { ...artifact.dependencies };
	};
	const [deps, packedCode] = await Promise.all([
		cached ? reuse() : pack(dependencies, `${prefix}-dependencies.tgz`), pack(code, `${prefix}-code.tgz`),
	]);
	if (!cached) {
		const shared = `pi-desk-dependencies-${release.platform}-${release.arch}-node${release.node}-${deps.sha256}.tgz`;
		await rename(join(output, deps.name), join(output, shared)); deps.name = shared;
	}
	const payload = { sourceDigest: release.digest, code: packedCode, dependencies: deps, links: links.sort((a, b) => a.path.localeCompare(b.path)) };
	const digest = payloadDigest(payload);
	const runtime = { format: release.format, id: runtimeIdentity(digest, release.platform, release.arch, release.node), digest, plugins: release.plugins,
		desk: release.desk, engine: release.engine, platform: release.platform, arch: release.arch, node: release.node };
	const value = runtimeArtifact({ format: 1, commit, runtime, ...payload });
	const file = join(output, artifactName(release.desk));
	atomicJson(file, value);
	return file;
}

/** No npm, Git cleanup or installed-source mutation occurs while preparing a release. */
export async function installArtifact(home: string, input: RuntimeArtifact, code: string, dependencies: string, progress?: (message: string) => void): Promise<RuntimeRelease> {
	const artifact = runtimeArtifact(input);
	await mkdir(home, { recursive: true });
	home = await realpath(home);
	const lease = new SessionLease(join(home, "manage"));
	let temporary: string | undefined;
	try {
		const state = readState(home);
		if (!state) throw new Error("Set up Desk before installing a runtime release.");
		progress?.("Verifying runtime archives");
		await verify(code, artifact.code);
		await verify(dependencies, artifact.dependencies);
		const destination = versionDirectory(home, artifact.runtime.id);
		try {
			const installed = readRelease(home, artifact.runtime.id);
			atomicJson(join(home, "state.json"), { ...state, pending: state.active === installed.id ? undefined : installed.id, autoApply: undefined });
			return installed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (state.active === artifact.runtime.id) throw new Error("The selected runtime is damaged. It cannot be replaced while active.");
		await reclaimSpace(home, progress, dependencies);
		temporary = await mkdtemp(join(home, ".download-"));
		if (await reuseDependencies(home, temporary, artifact.dependencies.sha256, dependencies, progress))
			await unpack(temporary, [{ file: code, dependency: false }], progress);
		else {
			await rm(temporary, { recursive: true, force: true });
			temporary = await mkdtemp(join(home, ".download-"));
			await unpack(temporary, [{ file: code, dependency: false }, { file: dependencies, dependency: true }], progress);
		}
		// Windows junctions must name their final location before publication.
		await restoreLinks(temporary, destination, artifact.links);
		const plugins = JSON.parse(await readFile(join(temporary, "source", "package.json"), "utf8"));
		const desk = JSON.parse(await readFile(join(temporary, "source", "pi-desk", "package.json"), "utf8"));
		const sdk = JSON.parse(await readFile(join(temporary, "source", "pi-desk", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
		if (plugins.name !== "pi-plugins" || desk.name !== "@gunba/pi-desk"
			|| plugins.version !== artifact.runtime.plugins || desk.version !== artifact.runtime.desk
			|| desk.dependencies?.["@earendil-works/pi-coding-agent"] !== artifact.runtime.engine || sdk.version !== artifact.runtime.engine)
			throw new Error("Runtime package versions do not match the release.");
		const release: RuntimeRelease = { ...artifact.runtime, source: state.source, readyAt: new Date().toISOString(),
			artifact: { commit: artifact.commit, code: artifact.code.sha256, dependencies: artifact.dependencies.sha256 } };
		for (const name of ["cli.js", "managed.js", "manage-cli.js", "worker.js", "catalog-worker.js"]) {
			const entry = join(temporary, "source", "pi-desk", "dist", "host", name);
			if (!(await lstat(entry)).isFile() || !within(temporary, await realpath(entry))) throw new Error("Runtime entry point is invalid.");
		}
		await mkdir(dirname(destination), { recursive: true });
		// Moving first also makes Windows junctions valid during the isolated smoke check.
		progress?.("Publishing the verified runtime");
		try { await publishDirectory(temporary, destination, progress); }
		catch (error) {
			if (retryablePublicationError(error)) throw Object.assign(new Error(
				"Windows blocked runtime publication after bounded retries. The active runtime was not changed. Retry preparation using the verified download cache; persistent failures need a storage/lock diagnosis. " + String(error),
				{ cause: error }), { code: (error as NodeJS.ErrnoException).code });
			throw error;
		}
		temporary = undefined;
		try {
			progress?.("Checking published runtime");
			const app = join(destination, "source", "pi-desk"), options = { cwd: app, windowsHide: true, timeout: 60_000 };
			await execute(process.execPath, [join(app, "dist", "host", "cli.js"), "--help"], options);
			await execute(process.execPath, ["--input-type=module", "-e",
				'import {createRequire} from "node:module"; createRequire(process.cwd()+"/package.json")("keytar");'], options);
			atomicJson(join(destination, "runtime.json"), release);
		} catch (error) {
			await rm(destination, { recursive: true, force: true });
			throw error;
		}
		readRelease(home, release.id);
		atomicJson(join(home, "state.json"), { ...state, pending: state.active === release.id ? undefined : release.id, autoApply: undefined });
		return release;
	} finally {
		try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
		finally { lease.close(); }
	}
}
