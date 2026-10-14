import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { artifactName, installArtifact, runtimeArtifact, sha256, type ReleaseAsset } from "./artifact.ts";
import { githubProxy, ReleaseNetwork } from "./release-network.ts";
import { readControllerRelease, readState, type RuntimeRelease } from "./store.ts";

const repository = "gunba/pi-plugins";
const releaseVersion = (tag: string): string | undefined => /^pi-desk-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
const assetURL = (tag: string, name: string) => `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
export const compareVersions = (a: string, b: string): number => {
	const left = a.split(".").map(Number), right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
	return 0;
};
/**
 * The latest release and this platform's manifest, read through github.com's release links rather than its API.
 * The API allows 60 unauthenticated lookups an hour per network address, which a shared office network uses up,
 * so the Work PC could not update. The manifest, fetched over TLS from GitHub like the API's digests were, lists
 * the size and SHA-256 of the code and dependency archives, which are verified on download.
 */
export async function publishedRuntime(network: ReleaseNetwork): Promise<{ tag: string; version: string; manifest: ReturnType<typeof runtimeArtifact> }> {
	const tag = decodeURIComponent(/\/releases\/tag\/([^/?#]+)$/.exec(new URL(await network.location(`https://github.com/${repository}/releases/latest`)).pathname)?.[1] ?? "");
	const version = releaseVersion(tag);
	if (!version) throw new Error("No Desk runtime release has been published yet.");
	let raw: unknown;
	try { raw = await network.json(assetURL(tag, artifactName(version))); }
	catch (error) {
		if (error instanceof Error && /HTTP 404/.test(error.message))
			throw new Error(`Desk ${version} has no runtime for this platform and Node version.`);
		throw error;
	}
	const manifest = runtimeArtifact(raw);
	if (manifest.runtime.desk !== version) throw new Error("Release tag and runtime version do not match.");
	return { tag, version, manifest };
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
		const { tag, version, manifest } = await publishedRuntime(network);
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
			await network.download(assetURL(tag, item.name), target, item.size);
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
