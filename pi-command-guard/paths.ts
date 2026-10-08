import { posix, win32 } from "node:path";

export type Environment = {
	cwd: string; home: string; temp: string; platform: "win32" | "posix";
	agentDir?: string; runtime?: string; workspace?: string;
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
const contains = (root: string, path: string) => root === path || path.startsWith(root.endsWith("/") ? root : root + "/");
const device = (path: string) => /^\/dev\/(?:sd[a-z]|hd[a-z]|nvme\d|vd[a-z]|disk\d|mmcblk\d)/i.test(path) || /^\\\\\.\\(?:physicaldrive|harddisk|[a-z]:)/i.test(path);
const systemRoots = (env: Environment) => env.platform === "win32"
	? ["Windows", "Program Files", "Program Files (x86)", "ProgramData", "Users"].map(name => `${win32.parse(env.home).root || "C:/"}${name}`)
	: ["/bin", "/sbin", "/usr", "/etc", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/home", "/root", "/var"];

export function pathFinding(path: string, env: Environment, options: { deletion?: boolean; recursive?: boolean; dynamic?: boolean; cwdChanged?: boolean } = {}): Finding | undefined {
	if (device(path)) return block("raw-device", "A raw storage device is a target.");
	if (env.platform === "win32") path = windowsPath(path);
	if (options.deletion && /^(?:~|\$(?:home|pwd)|\$\{(?:home|pwd)\}|\$env:(?:userprofile|systemroot|windir|systemdrive)|%(?:userprofile|systemroot|windir|systemdrive)%)[/\\]*$/i.test(path)) return block("root-delete", "Deletion targets an entire home, working or system directory.");
	if (options.dynamic) return confirm("unresolved-path", "A mutation target contains an unresolved expansion.");
	if (env.platform === "win32" && /^[a-z]:(?![/\\])/i.test(path)) return path.length === 2 ? block("root-delete", "A drive root is a target.") : confirm("drive-relative", "The drive-relative target depends on another working directory.");
	const wild = /[*?\[\]{}]/.test(path), base = path.split(/[*?\[\]{}]/)[0];
	if (options.cwdChanged && !(env.platform === "win32" ? win32 : posix).isAbsolute(path)) return confirm("changed-cwd", "A mutation uses a relative target after changing directories.");
	const resolved = normalizePath(base || ".", env), roots = systemRoots(env).map(root => normalizePath(root, env));
	const windowsSystem = env.platform === "win32" && resolved.match(/^[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata|users)(?=\/|$)/);
	if (windowsSystem) roots.push(windowsSystem[0]);
	const volume = env.platform === "win32" ? normalizePath(win32.parse(resolved).root || resolved, env) : "/";
	if (resolved === volume || options.deletion && [...roots, normalizePath(env.home, env), normalizePath(env.cwd, env), normalizePath(env.workspace ?? env.cwd, env), normalizePath(env.temp, env)].some(root => contains(resolved, root))) {
		return block("root-delete", "The operation targets a whole filesystem, home, working or system directory.");
	}
	const systemFiles = roots.filter(root => root !== "/home" && !(env.platform === "win32" && root.endsWith("/users")) && root !== normalizePath(env.home, env));
	if (systemFiles.some(root => contains(root, resolved))) return confirm("system-path", "A system location would be changed.");
	if (env.runtime && contains(normalizePath(env.runtime, env), resolved)) return block("runtime-write", "Installed runtime files are immutable; this operation would change one.");
	if (/(?:^|\/)(?:\.git|\.ssh|\.gnupg)(?:\/|$)/i.test(resolved) || /(?:^|\/)(?:auth\.json|trust\.json)$|\/(?:\.aws\/credentials|\.kube\/config)$/i.test(resolved)
		|| env.agentDir && resolved === normalizePath(env.agentDir + "/settings.json", env)) return confirm("sensitive-file", "Credentials, trust, agent configuration or version-control internals would be changed.");
	if (wild) return confirm("wildcard-mutation", "The mutation includes a wildcard target.");
	if (options.recursive) return confirm("recursive-delete", "Recursive deletion requires confirmation of its targets.");
	return undefined;
}
