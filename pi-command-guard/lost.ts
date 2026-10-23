import { execFile } from "node:child_process";
import type { LostPaths } from "./paths.ts";

const SHOWN = 20, TIMEOUT_MS = 1_500;

/**
 * What a confirmed Git wipe would lose, for the confirmation dialog: the first paths and their count. Empty when git
 * fails or times out. Git only reads here: optional locks and the fsmonitor hook are off.
 */
export function lostPaths(lost: LostPaths, signal?: AbortSignal): Promise<string> {
	return new Promise(resolve => {
		execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...lost.args], {
			cwd: lost.cwd, timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
		}, (error, stdout) => {
			if (error) return resolve("");
			const paths = lost.kind === "untracked"
				? stdout.split("\n").flatMap(line => line.startsWith("Would remove ") ? [line.slice("Would remove ".length)] : [])
				: changedPaths(stdout, lost.kind === "unstaged");
			const heading = lost.kind === "untracked" ? "Untracked files it would delete" : "Uncommitted changes it would discard";
			if (!paths.length) return resolve(`${heading}: none.`);
			const more = paths.length > SHOWN ? `\n… and ${paths.length - SHOWN} more` : "";
			resolve(`${heading} (${paths.length}):\n${paths.slice(0, SHOWN).join("\n")}${more}`);
		});
	});
}

/** Paths from `git status --porcelain -z`: every tracked change, or only those not staged. */
function changedPaths(output: string, unstagedOnly: boolean): string[] {
	const entries = output.split("\0"), paths: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4) continue;
		// A rename or copy is followed by its source path.
		if (/[RC]/.test(entry.slice(0, 2))) index++;
		if (!unstagedOnly || entry[1] !== " ") paths.push(entry.slice(3));
	}
	return paths;
}
