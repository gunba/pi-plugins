import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export function localPath(path: string): boolean {
	if (!isAbsolute(path) || path.startsWith("\\\\") || path.startsWith("//")) return false;
	if (process.platform === "win32" && (path.slice(2).includes(":")
		|| path.split(/[\\/]/).slice(1).some(part => /^(con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) return false;
	return true;
}

export function folderPath(value: string, cwd: string): string {
	if (!value || value.length > 4000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Enter a folder path.");
	// Reject network paths before normalization or filesystem access.
	if (value.startsWith("\\\\") || value.startsWith("//")) throw new Error("Network and device paths cannot be browsed here.");
	const path = value === "~" ? homedir() : /^~[\\/]/.test(value) ? resolve(homedir(), value.slice(2)) : resolve(cwd, value);
	if (!localPath(path)) throw new Error("Network and device paths cannot be browsed here.");
	return path;
}
