import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { artifactName, installArtifact, runtimeArtifact, sha256, type ReleaseAsset } from "./artifact.ts";
import { githubProxy, ReleaseNetwork } from "./release-network.ts";
import { readControllerRelease, readState, type RuntimeRelease } from "./store.ts";

const repository = "gunba/pi-plugins";
interface GitHubAsset { name: string; size: number; digest: string; state: string }
interface GitHubRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: GitHubAsset[] }
const releaseVersion = (tag: string): string | undefined => /^pi-desk-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
export const compareVersions = (a: string, b: string): number => {
	const left = a.split(".").map(Number), right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
	return 0;
};
export async function publishedRuntime(network: ReleaseNetwork): Promise<{ release: GitHubRelease; version: string }> {
	const raw = await network.json(`https://api.github.com/repos/${repository}/releases?per_page=20`);
	if (!Array.isArray(raw)) throw new Error("Invalid GitHub release list.");
	const release = (raw as GitHubRelease[]).filter(r => typeof r.tag_name === "string" && releaseVersion(r.tag_name)
		&& r.draft === false && r.prerelease === false && Array.isArray(r.assets))
		.sort((a, b) => compareVersions(releaseVersion(b.tag_name)!, releaseVersion(a.tag_name)!))[0];
	if (!release) throw new Error("No Desk runtime release has been published yet.");
	const version = releaseVersion(release.tag_name)!;
	asset(release, artifactName(version));
	return { release, version };
}
function asset(release: GitHubRelease, name: string): ReleaseAsset {
	const value = release.assets.find(item => item.name === name && item.state === "uploaded");
	if (!value || !/^sha256:[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.size)
		|| value.size < 1 || value.size > 512 * 1024 * 1024)
		throw new Error(`No verified ${name} asset is published. This platform/Node combination may not be supported.`);
	return { name, size: value.size, sha256: value.digest.slice(7) };
}
export interface DownloadOptions {
	home: string; source: string; progress?: (message: string) => void; signal?: AbortSignal; expected?: string;
}
/** Published releases never invoke Pi's mutable-source package updater. */
export async function downloadRuntime(options: DownloadOptions): Promise<RuntimeRelease> {
	const { home, source } = options, state = readState(home);
	if (!state) throw new Error("Set up Desk before updating it.");
	const network = new ReleaseNetwork(await githubProxy(source), options.signal);
	let temporary: string | undefined;
	try {
		options.progress?.("Checking published releases");
		const { release, version } = await publishedRuntime(network);
		if (options.expected && options.expected !== version) throw new Error("The published release changed. Check for updates before trying again.");
		if (state.active) {
			const active = readControllerRelease(home, state.active);
			if ((compareVersions(active.desk, version) > 0 || compareVersions(active.desk, version) === 0 && active.artifact) && active.node === process.versions.modules) {
				options.progress?.("The current runtime is up to date"); return active;
			}
			if (compareVersions(active.desk, version) > 0) throw new Error("This local build is newer than the published release. Stage it again with the new Node runtime.");
		}
		await mkdir(home, { recursive: true });
		temporary = await mkdtemp(join(home, ".release-"));
		const download = async (item: ReleaseAsset, directory: string) => {
			const target = join(directory, item.name);
			await network.download(`https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(item.name)}`, target, item.size);
			if (await sha256(target) !== item.sha256) throw new Error(`Integrity check failed for ${item.name}.`);
			return target;
		};
		const metadata = asset(release, artifactName(version));
		if (metadata.size > 2 * 1024 * 1024) throw new Error("Runtime manifest is too large.");
		const manifest = runtimeArtifact(JSON.parse(await readFile(await download(metadata, temporary), "utf8")));
		if (manifest.runtime.desk !== version) throw new Error("Release tag and runtime version do not match.");
		for (const item of [manifest.code, manifest.dependencies]) {
			const published = asset(release, item.name);
			if (published.sha256 !== item.sha256 || published.size !== item.size) throw new Error("Published runtime assets do not match their manifest.");
		}
		const cache = join(home, "archives");
		await mkdir(cache, { recursive: true, mode: 0o700 });
		const dependencyFile = join(cache, `${manifest.dependencies.sha256}.tgz`);
		let cached = false;
		try {
			const info = await lstat(dependencyFile);
			cached = info.isFile() && info.size === manifest.dependencies.size && await sha256(dependencyFile) === manifest.dependencies.sha256;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (!cached) {
			options.progress?.("Downloading runtime dependencies");
			await rename(await download(manifest.dependencies, temporary), dependencyFile);
		}
		options.progress?.(cached ? "Downloading update; reusing verified dependencies" : "Downloading runtime code");
		const code = await download(manifest.code, temporary);
		options.signal?.throwIfAborted();
		options.progress?.("Preparing the verified runtime");
		return await installArtifact(home, manifest, code, dependencyFile);
	} finally {
		network.close();
		if (temporary) await rm(temporary, { recursive: true, force: true });
	}
}
