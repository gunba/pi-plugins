import { lstatSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative } from "node:path";
import { readRelease } from "../../manage/store.ts";
import { within } from "../../manage/source.ts";

// Kept apart from runtime-resources.ts, which loads the Pi SDK: the worker uses these before it reports in, and loading
// the SDK's 1,600 modules first made a busy Windows computer miss the 30-second start-up window.
/** source: the installed checkout; root: this version's pinned copy; stable: the same files under a path every version shares. */
export interface RuntimePin { source: string; root: string; stable: string }
export function runtimePin(configured?: string): RuntimePin | undefined {
	if (!configured) return;
	const directory = realpathSync(configured);
	if (basename(dirname(directory)) !== "versions") throw new Error("Invalid managed runtime location.");
	const release = readRelease(dirname(dirname(directory)), basename(directory));
	return { source: release.source, root: join(directory, "source"), stable: join(dirname(dirname(directory)), "current") };
}

/**
 * Text the model sees names Desk's files through runtime/current, a link to the running version's copy, never the
 * version's own folder: Pi's documentation (PI_PACKAGE_DIR, used by codemode's description and the prompt's docs
 * section) and skill locations. A version folder in the prompt changed the prompt with every Desk release, so each
 * conversation that moved to it paid for its whole context again. Code still loads from the version's own folder.
 */
export function stablePath(pin: RuntimePin, path: string): string {
	return within(pin.root, path) ? join(pin.stable, relative(pin.root, path)) : path;
}
/** Points runtime/current at this version's copy; a junction on Windows, which needs no privilege. */
export function pointStableRuntime(pin: RuntimePin): void {
	try { if (realpathSync(pin.stable) === realpathSync(pin.root)) return; } catch { /* Missing or dangling. */ }
	const next = `${pin.stable}.${process.pid}`;
	try { rmLink(next); } catch { /* None left over. */ }
	symlinkSync(pin.root, next, process.platform === "win32" ? "junction" : "dir");
	try { renameSync(next, pin.stable); }
	catch {
		// Windows cannot rename over an existing junction: remove the old link (never its target) and try again.
		try { if (lstatSync(pin.stable).isSymbolicLink()) rmLink(pin.stable); } catch { /* Gone already. */ }
		renameSync(next, pin.stable);
	}
}
function rmLink(path: string): void {
	if (!lstatSync(path).isSymbolicLink()) throw new Error(`${path} is not a link.`);
	if (process.platform === "win32") rmdirSync(path); else unlinkSync(path);
}
/** The Pi package this host runs, for PI_PACKAGE_DIR. */
export function piPackageDir(): string | undefined {
	try {
		for (let folder = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))); dirname(folder) !== folder; folder = dirname(folder)) {
			try { if (JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return folder; } catch { /* Keep looking. */ }
		}
	} catch { /* Not resolvable from here. */ }
}
