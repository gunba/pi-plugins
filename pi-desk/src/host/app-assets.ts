import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const clientDirectory = () => resolve(dirname(fileURLToPath(import.meta.url)), "../client");

/** Validate the shipped shell before advertising a usable app. */
export function inspectAppAssets(directory = clientDirectory()): { directory: string; files: number } {
	directory = resolve(directory);
	const files = new Set(["/index.html", "/sw.js", "/manifest.webmanifest"]);
	const inspect = (reference: string): string => {
		const file = resolve(directory, `.${reference}`);
		if (!reference.startsWith("/") || !file.startsWith(`${directory}${sep}`)) throw new Error("The app shell contains an invalid asset path. Reinstall or rebuild Pi Desk.");
		try {
			const stat = statSync(file);
			if (!stat.isFile() || stat.size === 0) throw new Error();
			accessSync(file, constants.R_OK);
		} catch { throw new Error(`App file missing or unreadable: ${file}. Reinstall or rebuild Pi Desk; keep dist/client with the PC host.`); }
		return file;
	};
	const index = inspect("/index.html");
	if (statSync(index).size > 256 * 1024) throw new Error("The app index is unexpectedly large. Reinstall or rebuild Pi Desk.");
	const html = readFileSync(index, "utf8");
	for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) files.add(match[1]!);
	if (![...files].some(file => file.startsWith("/assets/") && file.endsWith(".js"))
		|| ![...files].some(file => file.startsWith("/assets/") && file.endsWith(".css"))) {
		throw new Error("Built app scripts or styles are missing from index.html. Rebuild Pi Desk before starting it.");
	}
	for (const file of files) inspect(file);
	try {
		const manifest = inspect("/manifest.webmanifest");
		if (statSync(manifest).size > 64 * 1024) throw new Error();
		const value = JSON.parse(readFileSync(manifest, "utf8"));
		for (const icon of value.icons ?? []) { inspect(icon.src); files.add(icon.src); }
	} catch { throw new Error("The app manifest or its icons are invalid. Reinstall or rebuild Pi Desk."); }
	return { directory, files: files.size };
}
