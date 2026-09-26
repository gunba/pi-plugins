import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function resolveToolPath(baseDir: string, path: string): string {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	if (!normalized) throw new Error("path cannot be empty");
	return isAbsolute(normalized) ? resolve(normalized) : resolve(baseDir, normalized);
}

export function displayPathFromCwd(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath;
}

export function displayPath(ctx: Pick<ExtensionContext, "cwd">, absolutePath: string): string {
	return displayPathFromCwd(ctx.cwd, absolutePath);
}
