import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstallation } from "./installation.ts";
import { personalPackageSource, releaseSourceSupported } from "./release-source.ts";
import { atomicJson, readControllerRelease, readState } from "./store.ts";

export const updateCheckInterval = 6 * 60 * 60_000;
interface UpdateCheck { format: 1; runtime: string; checkedAt: number; available?: string; error?: string }
export function readUpdateCheck(home: string, runtime: string): UpdateCheck | undefined {
	try {
		const value = JSON.parse(readFileSync(join(home, "release-check.json"), "utf8")) as UpdateCheck;
		if (value?.format === 1 && value.runtime === runtime && Number.isSafeInteger(value.checkedAt)
			&& value.checkedAt > 0 && value.checkedAt <= Date.now() + 60_000
			&& (value.available === undefined || typeof value.available === "string" && /^\d+\.\d+\.\d+$/.test(value.available))
			&& (value.error === undefined || typeof value.error === "string")) return value;
	} catch { /* A missing/stale cache simply causes a fresh bounded check. */ }
}
/** Detection never downloads a runtime or changes activation state. */
export async function checkRuntimeUpdate(home: string, signal: AbortSignal): Promise<void> {
	const state = readState(home);
	if (!state?.active) return;
	const check: UpdateCheck = { format: 1, runtime: state.active, checkedAt: Date.now() };
	try {
		const installation = readInstallation(home);
		if (!releaseSourceSupported(await personalPackageSource(state.source, installation.cwd, installation.agentDir)))
			throw new Error("This source uses explicit development preparation rather than published updates.");
		const [{ ReleaseNetwork, githubProxy }, { publishedRuntime, compareVersions }] = await Promise.all([
			import("./release-network.ts"), import("./releases.ts"),
		]);
		signal.throwIfAborted();
		const network = new ReleaseNetwork(await githubProxy(state.source), signal);
		try {
			const { version } = await publishedRuntime(network), active = readControllerRelease(home, state.active);
			const newer = compareVersions(version, active.desk);
			if (newer > 0 || newer === 0 && (!active.artifact || active.node !== process.versions.modules)) check.available = version;
		} finally { network.close(); }
	} catch (error) { check.error = (error instanceof Error ? error.message : String(error)).slice(0, 800); }
	signal.throwIfAborted();
	atomicJson(join(home, "release-check.json"), check);
}
