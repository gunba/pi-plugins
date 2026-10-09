import { posix, win32 } from "node:path";

export type Environment = {
	cwd: string; home: string; platform: "win32" | "posix";
};
export type Finding = { decision: "confirm" | "block"; rule: string; reason: string };
export const confirm = (rule: string, reason: string): Finding => ({ decision: "confirm", rule, reason });
export const block = (rule: string, reason: string): Finding => ({ decision: "block", rule, reason });

const windowsPath = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");

export function normalizePath(path: string, env: Environment): string {
	path = path.replace(/^@(?=[/\\~]|[A-Za-z]:)/, "");
	if (path === "~" || /^~[/\\]/.test(path)) path = env.home + path.slice(1);
	if (env.platform === "win32") {
		path = windowsPath(path);
		path = path.replace(/^\/([a-z])(?:\/|$)/i, (_, drive) => `${drive}:/`);
		return win32.resolve(env.cwd, path).replaceAll("\\", "/").toLowerCase().replace(/\/$/, "");
	}
	return posix.resolve(env.cwd, path).replace(/\/$/, "") || "/";
}
const device = (path: string) => /^\/dev\/(?:(?:sd|hd|vd)[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|disk\d+(?:s\d+)?|mmcblk\d+(?:p\d+)?)$/i.test(path) || /^\\\\\.\\(?:physicaldrive\d+|harddisk\d+|[a-z]:)$/i.test(path);

export function pathFinding(path: string, env: Environment, options: { deletion?: boolean; dynamic?: boolean; cwdChanged?: boolean } = {}): Finding | undefined {
	if (device(path)) return block("raw-device", "The command would overwrite or delete a storage device.");
	if (env.platform === "win32") path = windowsPath(path);
	if (options.deletion && /^(?:\$env:systemdrive|%systemdrive%)[/\\]+(?:\*|\*\.\*)?$/i.test(path)) return block("root-delete", "Deletion targets an entire drive.");
	if (options.dynamic) return undefined;
	if (env.platform === "win32" && /^[a-z]:(?![/\\])/i.test(path)) return undefined;
	if (options.cwdChanged && !(env.platform === "win32" ? win32 : posix).isAbsolute(path)) return undefined;
	// Only a whole-directory glob denotes a wipe; /tmp* is not the filesystem root.
	const base = path.replace(/([/\\])(?:\*\*?|\*\.\*)$/, "$1");
	if (/[*?\[\]{}]/.test(base)) return undefined;
	const resolved = normalizePath(base || "/", env);
	const volume = env.platform === "win32" ? normalizePath(win32.parse(resolved).root || resolved, env) : "/";
	if (options.deletion && (resolved === volume || env.platform === "win32" && /^[a-z]:$/i.test(resolved))) return block("root-delete", "Deletion targets an entire filesystem or drive.");
	if (options.deletion && /(?:^|\/)\.git(?:\/(?:objects|refs|logs))?$/i.test(resolved)) return confirm("git-directory", "The command would delete Git repository history or recovery data.");
	return undefined;
}
