import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runtimeArtifact, verify, type RuntimeArtifact, type VerifiedDependencies } from "./artifact.ts";
import { captureSource, within } from "./source.ts";
import { atomicJson, validId } from "./store.ts";
import { githubProxy, ReleaseNetwork } from "./release-network.ts";

const execute = promisify(execFile);
export const dependencyCacheName = () => `pi-desk-dependency-cache-${process.platform}-${process.arch}-node${process.versions.modules}.json`;

const recipe = new Set(["pi-desk/manage/stage.ts", "pi-desk/manage/artifact.ts", "pi-desk/manage/dependency-cache.ts",
	"pi-desk/manage/pack-release.ts", "pi-desk/build.mjs", "pi-desk/vite.config.ts"]);

/** Release versions alone do not change dependencies; lock entries and local package contents do. */
export async function dependencyCacheKey(source: string): Promise<string> {
	const snapshot = await captureSource(source), local: string[] = [];
	for (const file of snapshot.files.filter(file => /(?:^|\/)package\.json$/.test(file.path))) {
		const pkg = JSON.parse(file.data.toString("utf8"));
		for (const spec of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].flatMap(group => Object.values(group ?? {}))) {
			if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
			const path = resolve(snapshot.root, dirname(file.path), spec.slice(5));
			if (!within(snapshot.root, path)) throw new Error("A local dependency is outside the release source.");
			local.push(relative(snapshot.root, path).split(sep).join("/"));
		}
	}
	const hash = createHash("sha256").update(JSON.stringify([1, process.platform, process.arch, process.versions.modules]));
	for (const file of snapshot.files) {
		if (!recipe.has(file.path) && !/(?:^|\/)(?:package(?:-lock)?\.json|\.npmrc)$/.test(file.path)
			&& !local.some(path => !path || file.path === path || file.path.startsWith(`${path}/`))) continue;
		let data = file.data;
		if (["package.json", "package-lock.json", "pi-desk/package.json", "pi-desk/package-lock.json"].includes(file.path)) {
			const value = JSON.parse(data.toString("utf8"));
			delete value.version;
			if (value.packages?.[""]) delete value.packages[""].version;
			data = Buffer.from(JSON.stringify(value));
		}
		hash.update(JSON.stringify([file.path, file.executable, data.length]) + "\n").update(data);
	}
	return hash.digest("hex");
}

export async function loadDependencyCache(directory: string, key: string, progress?: (message: string) => void): Promise<VerifiedDependencies | undefined> {
	try {
		const saved = JSON.parse(await readFile(join(directory, "bundle.json"), "utf8"));
		if (saved.format !== 1 || !validId(key) || saved.key !== key) throw new Error("dependency inputs changed");
		const artifact = runtimeArtifact(saved.artifact), file = join(directory, artifact.dependencies.name);
		await verify(file, artifact.dependencies);
		progress?.("Verified dependency cache hit");
		return { artifact, file };
	} catch (error) {
		progress?.((error as NodeJS.ErrnoException).code === "ENOENT" ? "Dependency cache miss" : `Dependency cache ignored: ${String(error)}`);
		return undefined;
	}
}

/** Called only after the fresh release's full consumer installation succeeds. */
export async function saveDependencyCache(directory: string, key: string, input: RuntimeArtifact, output: string): Promise<void> {
	if (!validId(key)) throw new Error("Invalid dependency cache key.");
	const artifact = runtimeArtifact(input), source = join(output, artifact.dependencies.name);
	await verify(source, artifact.dependencies);
	await mkdir(directory, { recursive: true });
	const target = join(directory, artifact.dependencies.name);
	if (resolve(source) !== resolve(target)) await copyFile(source, target);
	const saved = { format: 1, key, artifact };
	atomicJson(join(directory, "bundle.json"), saved);
	atomicJson(join(output, dependencyCacheName()), saved);
}

/** Tag-scoped Actions caches cannot be shared with the next release tag. */
export async function restoreReleaseDependencies(source: string, directory: string, progress: (message: string) => void): Promise<void> {
	const key = await dependencyCacheKey(source);
	if (await loadDependencyCache(directory, key)) return;
	const network = new ReleaseNetwork(await githubProxy(source));
	try {
		const repo = process.env.GH_REPO;
		if (!repo || !/^[a-z0-9_-]+\/[a-z0-9_.-]+$/i.test(repo)) throw new Error("GH_REPO is required");
		const tag = (await execute("gh", ["release", "view", "--repo", repo, "--json", "tagName", "--jq", ".tagName"],
			{ encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 })).stdout.trim();
		if (!/^pi-desk-v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Latest release has no Desk dependency bundle");
		const base = `https://github.com/${repo}/releases/download/${tag}/`;
		const saved = await network.json(base + dependencyCacheName()) as { format: number; key: string; artifact: RuntimeArtifact };
		if (saved.format !== 1 || saved.key !== key) throw new Error("Dependency inputs changed since the previous release");
		const artifact = runtimeArtifact(saved.artifact);
		if (`pi-desk-v${artifact.runtime.desk}` !== tag) throw new Error("Dependency bundle does not match its release");
		await mkdir(directory, { recursive: true });
		const file = join(directory, artifact.dependencies.name);
		await network.download(base + artifact.dependencies.name, file, artifact.dependencies.size);
		await verify(file, artifact.dependencies);
		atomicJson(join(directory, "bundle.json"), saved);
		progress(`Restored verified dependencies from ${tag}`);
	} catch (error) { progress(`Dependency cache unavailable; using locked installation: ${String(error)}`); }
	finally { network.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	if (process.argv[2] === "--key" && process.argv[3]) console.log(await dependencyCacheKey(resolve(process.argv[3])));
	else if (process.argv[2] === "--restore-release" && process.argv[3] && process.argv[4])
		await restoreReleaseDependencies(resolve(process.argv[3]), resolve(process.argv[4]), console.log);
	else throw new Error("Usage: dependency-cache.ts --key <source> | --restore-release <source> <cache-directory>");
}
