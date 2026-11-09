import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { artifactName, installArtifact, runtimeArtifact, sha256, type ReleaseAsset } from "./artifact.ts";
import { GitHubStatusError, githubProxy, ReleaseNetwork } from "./release-network.ts";
import { readControllerRelease, readState, type RuntimeRelease } from "./store.ts";

const repository = "gunba/pi-plugins";
const releaseVersion = (tag: string): string | undefined => /^pi-desk-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
const assetURL = (tag: string, name: string) => `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
const releasesAPI = `https://api.github.com/repos/${repository}/releases`;
export const compareVersions = (a: string, b: string): number => {
	const left = a.split(".").map(Number), right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
	return 0;
};
/**
 * A release's files, read through github.com's download links. GitHub sometimes cannot serve those links while its
 * API still answers: on 9 November 2026 each took 10 to 11 seconds and most returned HTTP 504, so the Work PC could
 * not update. A file whose link fails with a server error comes through the API instead. That spends lookups from
 * the API's hourly allowance, so it is only the fallback.
 */
class ReleaseFiles {
	private network: ReleaseNetwork;
	private tag: string;
	private assets?: Promise<Map<string, number>>;
	constructor(network: ReleaseNetwork, tag: string) { this.network = network; this.tag = tag; }
	private async fallback<T>(name: string, read: (address: string) => Promise<T>): Promise<T> {
		try { return await read(assetURL(this.tag, name)); }
		catch (error) {
			if (!(error instanceof GitHubStatusError && error.status >= 500)) throw error;
			this.assets ??= this.network.json(`${releasesAPI}/tags/${encodeURIComponent(this.tag)}`, false).then(release =>
				new Map(((release as { assets?: { id: number; name: string }[] }).assets ?? []).map(asset => [asset.name, asset.id])));
			const id = (await this.assets).get(name);
			if (id === undefined) throw new GitHubStatusError(404, `GitHub returned HTTP 404 for ${name}. The running release is unchanged.`);
			return read(`${releasesAPI}/assets/${id}`);
		}
	}
	json(name: string): Promise<unknown> { return this.fallback(name, address => this.network.json(address)); }
	download(name: string, file: string, size: number): Promise<void> {
		return this.fallback(name, address => this.network.download(address, file, size));
	}
}
/**
 * The latest release and this platform's manifest, read through github.com's release links rather than its API.
 * The API allows 60 unauthenticated lookups an hour per network address, which a shared office network uses up,
 * so the Work PC could not update. The manifest, fetched over TLS from GitHub like the API's digests were, lists
 * the size and SHA-256 of the code and dependency archives, which are verified on download.
 */
export async function publishedRuntime(network: ReleaseNetwork): Promise<{ tag: string; version: string; manifest: ReturnType<typeof runtimeArtifact>; files: ReleaseFiles }> {
	const tag = decodeURIComponent(/\/releases\/tag\/([^/?#]+)$/.exec(new URL(await network.location(`https://github.com/${repository}/releases/latest`)).pathname)?.[1] ?? "");
	const version = releaseVersion(tag);
	if (!version) throw new Error("No Desk runtime release has been published yet.");
	const files = new ReleaseFiles(network, tag);
	let raw: unknown;
	try { raw = await files.json(artifactName(version)); }
	catch (error) {
		if (error instanceof GitHubStatusError && error.status === 404)
			throw new Error(`Desk ${version} has no runtime for this platform and Node version.`);
		throw error;
	}
	const manifest = runtimeArtifact(raw);
	if (manifest.runtime.desk !== version) throw new Error("Release tag and runtime version do not match.");
	return { tag, version, manifest, files };
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
		const { version, manifest, files } = await publishedRuntime(network);
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
			await files.download(item.name, target, item.size);
			if (await sha256(target) !== item.sha256) throw new Error(`Integrity check failed for ${item.name}.`);
			return target;
		};
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
		return await installArtifact(home, manifest, code, dependencyFile, options.progress);
	} finally {
		network.close();
		if (temporary) await rm(temporary, { recursive: true, force: true });
	}
}
