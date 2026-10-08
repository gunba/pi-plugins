import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageRuntime } from "./stage.ts";
import { installArtifact, packRuntime, runtimeArtifact } from "./artifact.ts";
import { atomicJson, readState } from "./store.ts";
import { dependencyCacheKey, loadDependencyCache, saveDependencyCache } from "./dependency-cache.ts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), output = process.argv[2];
if (!output) throw new Error("Usage: node pi-desk/manage/pack-release.ts <output-directory>");
if (execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }).trim())
	throw new Error("Commit the release source before building distributable artifacts.");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const cache = process.env.PI_DESK_DEPENDENCY_CACHE;
const key = cache ? await dependencyCacheKey(source) : undefined;
const dependencies = cache ? await loadDependencyCache(cache, key!, console.log) : undefined;
const temporary = await mkdtemp(join(tmpdir(), "pi-desk-release-"));
try {
	const release = await stageRuntime({ source, home: join(temporary, "runtime"), dependencies, progress: console.log });
	if (key && await dependencyCacheKey(source) !== key) throw new Error("Dependency inputs changed during the build.");
	console.log("Packing portable runtime");
	const file = await packRuntime(join(temporary, "runtime"), release.id, resolve(output), commit, dependencies);
	// Reproduce the Windows DLL-lock boundary: another process may be using
	// the installed package while a release is prepared. Never clean that tree.
	createRequire(join(source, "pi-desk", "package.json"))("keytar");
	const consumer = join(temporary, "consumer"), active = "f".repeat(64);
	await mkdir(consumer);
	atomicJson(join(consumer, "state.json"), { format: 1, source, active });
	const artifact = runtimeArtifact(JSON.parse(await readFile(file, "utf8")));
	console.log("Verifying portable installation");
	await installArtifact(consumer, artifact, join(resolve(output), artifact.code.name), join(resolve(output), artifact.dependencies.name), console.log);
	const state = readState(consumer);
	if (state?.active !== active || state.pending !== artifact.runtime.id) throw new Error("Release preparation changed the active runtime.");
	console.log(`Verified ${release.desk}: ${artifact.code.size} code bytes, ${artifact.dependencies.size} dependency bytes; active runtime unchanged.`);
	console.log(file);
	if (cache) await saveDependencyCache(cache, key!, artifact, resolve(output));
} finally {
	console.log("Cleaning release workspace");
	await rm(temporary, { recursive: true, force: true });
	console.log("Release workspace removed");
}
