/**
 * Hands: a conversation that runs on one computer while its file and shell tools act in a folder on another, over the
 * workspace's computer-to-computer connection. The conversation's computer asks; the folder's computer carries it out.
 */

/** What a computer announces when it carries out other computers' file and shell calls. */
export const HANDS = "hands";
/** The session entry recording where a conversation's tools act; its data is a HandsBinding, or null for this computer. */
export const HANDS_ENTRY = "pi-desk/hands";
export const HANDS_PACKETS = new Set(["hands-call", "hands-data", "hands-done", "hands-cancel"]);
/** The largest file read or written in one call: a packet must fit the connection's 31 MB limit, as base64 or JSON. */
export const HANDS_FILE_BYTES = 20 * 1024 * 1024;

export interface HandsBinding { computer: string; name: string; platform: string; folder: string }

export type HandsRequest =
	| { op: "read"; path: string }
	| { op: "access"; path: string; write?: boolean }
	| { op: "mime"; path: string }
	| { op: "write"; path: string; content: string }
	| { op: "mkdir"; path: string }
	| { op: "exec"; command: string; cwd: string; timeout?: number }
	| { op: "context"; path: string };

export type HandsPacket =
	| { type: "hands-call"; id: string; request: HandsRequest }
	/** Part of a call's output: a file's bytes or a command's output, base64. */
	| { type: "hands-data"; id: string; data: string }
	| { type: "hands-done"; id: string; result?: unknown; error?: string }
	| { type: "hands-cancel"; id: string };

export function handsBinding(value: unknown): HandsBinding | undefined {
	const data = value as Partial<HandsBinding> | null | undefined;
	if (!data || typeof data.computer !== "string" || typeof data.folder !== "string" || !data.folder) return undefined;
	return { computer: data.computer, name: typeof data.name === "string" && data.name ? data.name : "the other computer",
		platform: typeof data.platform === "string" ? data.platform : "", folder: data.folder };
}

/**
 * Tools on the conversation's computer resolve paths with its path rules, so a Windows folder is named the way Git Bash
 * names it: C:\obsidian is /c/obsidian. Any other folder keeps its own form.
 */
export function toolPath(native: string, platform: string): string {
	if (platform !== "win32") return native;
	const drive = /^([a-zA-Z]):[\\/]?(.*)$/.exec(native);
	if (!drive) return native.replace(/\\/g, "/");
	const rest = drive[2]!.replace(/\\/g, "/").replace(/\/+$/, "");
	return `/${drive[1]!.toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** A path the model wrote for a Windows folder: C:\x and C:/x become /c/x; anything else is left to the tool. */
export function modelPath(path: string, platform: string): string {
	return platform === "win32" && /^[a-zA-Z]:([\\/]|$)/.test(path) ? toolPath(path, platform) : path;
}

/** The inverse of toolPath on the folder's computer: an absolute tool path as this computer names it. */
export function nativePath(path: string, platform: string = process.platform): string {
	if (platform !== "win32") {
		if (!path.startsWith("/")) throw new Error(`${path} is not an absolute path.`);
		return path;
	}
	const drive = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(path);
	if (!drive) {
		if (/^[a-zA-Z]:[\\/]/.test(path)) return path;
		throw new Error(`${path} is not a path on this Windows computer: name a drive, as /c/… or C:\\….`);
	}
	return `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? "").replace(/\//g, "\\")}`;
}
