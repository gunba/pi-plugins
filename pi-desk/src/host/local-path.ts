import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export function localPath(path: string): boolean {
	if (!isAbsolute(path) || path.startsWith("\\\\") || path.startsWith("//")) return false;
	if (process.platform === "win32" && (path.slice(2).includes(":")
		|| path.split(/[\\/]/).slice(1).some(part => /^(con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) return false;
	return true;
}

/** "~" and "~/…" (or "~\…", as an agent on Windows writes it) as the home folder; any other path unchanged. */
export function expandHome(path: string): string {
	return path === "~" ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

/**
 * A conversation's folder as people and agents write it: "~" and "~/…" are the home folder, and a relative folder is
 * under it. Resolved against the folder Desk was started from, "~" from an agent on another computer became
 * …/pi-plugins/~ and the conversation could not start.
 */
export function homeFolder(value: string): string {
	return resolve(homedir(), expandHome(value.trim()));
}

export function folderPath(value: string, cwd: string): string {
	if (!value || value.length > 4000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Enter a folder path.");
	// Reject network paths before normalization or filesystem access.
	if (value.startsWith("\\\\") || value.startsWith("//")) throw new Error("Network and device paths cannot be browsed here.");
	const path = resolve(cwd, expandHome(value));
	if (!localPath(path)) throw new Error("Network and device paths cannot be browsed here.");
	return path;
}
