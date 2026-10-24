import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { remoteOrigins } from "../shared/relay-protocol.ts";
import { RELEASE } from "../shared/release.ts";
import { clientDirectory, inspectAppAssets } from "./app-assets.ts";
import { contentSecurityPolicy, SANDBOX_PAGE, SANDBOX_POLICY } from "./static.ts";
import { accountConfiguration, type AccountConfiguration } from "../shared/account.ts";
import { discoverAccount } from "./account-config.ts";

export async function publishApp(options: { account: AccountConfiguration; appOrigin: string; output: string }, directory = clientDirectory()): Promise<void> {
	const account = accountConfiguration(options.account);
	const { origin, appOrigin } = remoteOrigins(account.relayOrigin, options.appOrigin);
	if (!account.appOrigins.includes(appOrigin) || account.origin === origin || account.origin === appOrigin) throw new Error("Invalid account service separation.");
	directory = resolve(directory);
	const output = resolve(options.output);
	if (output === directory || output.startsWith(directory + sep)) throw new Error("Publish outside the installed client directory.");
	inspectAppAssets(directory);
	await mkdir(dirname(output), { recursive: true });
	// A deployment is a fresh artifact, never an in-place overwrite. Node 22.23 refuses to copy into an existing directory.
	if (existsSync(output)) throw new Error("Publish to a new directory.");
	await cp(directory, output, { recursive: true, force: false, errorOnExist: true });
	await carryAssets(dirname(output), output);
	await writeFile(join(output, "desk-account.json"), JSON.stringify({ kind: "account", accountOrigin: account.origin, appOrigin, ...RELEASE }) + "\n");
	const socket = new URL(origin); socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
	// Response headers for the Caddy site that serves this directory (`import site.caddy`).
	const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;
	await writeFile(join(output, "site.caddy"), [
		// Compressed: the app's script and stylesheet were sent whole (964 KB), 20 s on a plane before the page appeared.
		"encode zstd gzip",
		"header {",
		"\tX-Content-Type-Options nosniff", "\tReferrer-Policy no-referrer", "\tCross-Origin-Resource-Policy same-origin",
		`\tStrict-Transport-Security ${quote("max-age=31536000")}`,
		"}",
		// The page that runs HTML an agent shows has its own policy; a second header would replace or join the app's.
		`@app not path ${SANDBOX_PAGE}`,
		`header @app Content-Security-Policy ${quote(contentSecurityPolicy({ socketOrigin: socket.origin, accountOrigin: account.origin }))}`,
		`@sandbox path ${SANDBOX_PAGE}`, `header @sandbox Content-Security-Policy ${quote(SANDBOX_POLICY)}`,
		"@config path /desk-account.json", "header @config Cache-Control no-store",
		"@assets path /assets/*", `header @assets Cache-Control ${quote("public, max-age=31536000, immutable")}`,
		"@pages not path /desk-account.json /assets/*", "header @pages Cache-Control no-cache",
		"@manifest path *.webmanifest", "header @manifest Content-Type application/manifest+json",
		"",
	].join("\n"));
}

/**
 * Earlier releases' versioned files (/assets/…) are copied into a new release for a week from when they were first
 * published: a page opened, or kept by a phone's service worker, before this release still finds the files it names.
 * With only this release's files, such a page stayed grey. Each release carries the last one's, so they add up.
 */
const CARRY_MS = 7 * 86_400_000;
async function carryAssets(releases: string, output: string): Promise<void> {
	const target = join(output, "assets");
	for (const release of await readdir(releases).catch(() => [] as string[])) {
		const folder = join(releases, release, "assets");
		if (join(releases, release) === output || !existsSync(folder) || !existsSync(target)) continue;
		for (const file of await readdir(folder)) {
			const from = join(folder, file), to = join(target, file), info = await stat(from);
			if (existsSync(to) || !info.isFile() || Date.now() - info.mtimeMs > CARRY_MS) continue;
			await copyFile(from, to); await utimes(to, info.atime, info.mtime);
		}
	}
}

export async function runPublishApp(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: {
		account: { type: "string" }, "app-origin": { type: "string" }, output: { type: "string" }, proxy: { type: "string" },
	} });
	if (!values.account || !values["app-origin"] || !values.output) throw new Error("Usage: pi-desk publish-app --account URL --app-origin URL --output new-directory");
	const configuration = await discoverAccount({ account: values.account, proxy: values.proxy });
	await publishApp({ account: configuration.config, appOrigin: values["app-origin"], output: values.output });
	console.log(`Static app prepared in ${resolve(values.output)}. Serve it with its site.caddy headers; do not copy it to the relay.`);
}
