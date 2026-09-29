import { posix, win32 } from "node:path";

/** Cache identity follows the selected computer, not the browser's path spelling. */
export function catalogPath(path: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? win32.resolve(path).toLowerCase() : posix.resolve(path);
}
