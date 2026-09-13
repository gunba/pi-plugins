#!/usr/bin/env node
import { registerHooks } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** Resolve public SDK packages once, so the frontend and loaded extensions share a runtime. */
export function installRuntimeResolver() {
	let parentURL;
	try {
		parentURL = import.meta.resolve("@earendil-works/pi-coding-agent");
	} catch {
		const globalRoot = (
			process.platform === "win32"
				? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm root -g"], {
						encoding: "utf8",
						windowsHide: true,
					})
				: execFileSync("npm", ["root", "-g"], { encoding: "utf8" })
		).trim();
		parentURL = pathToFileURL(
			join(globalRoot, "@earendil-works/pi-coding-agent", "pi-workspace-resolver.mjs"),
		).href;
	}
	const roots = [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
	];
	return registerHooks({
		resolve(specifier, context, nextResolve) {
			if (roots.some((root) => specifier === root || specifier.startsWith(`${root}/`))) {
				// CJS resolution keeps the requiring module's search paths even when
				// parentURL changes. Resolve the public export through the ESM hook,
				// then return its URL to Node's native loader for both import styles.
				if (context.conditions.includes("require"))
					return { url: import.meta.resolve(specifier), shortCircuit: true };
				return nextResolve(specifier, { ...context, parentURL, conditions: ["node", "import"] });
			}
			return nextResolve(specifier, context);
		},
	});
}

if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
	try {
		installRuntimeResolver();
		const { main } = await import("./app.ts");
		await main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
