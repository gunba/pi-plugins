import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { remoteOrigins } from "../shared/relay-protocol.ts";
import { RELEASE } from "../shared/release.ts";
import { clientDirectory, inspectAppAssets } from "./app-assets.ts";
import { contentSecurityPolicy } from "./static.ts";
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
	await mkdir(output); // A deployment is a fresh artifact, never an in-place overwrite.
	await cp(directory, output, { recursive: true, force: false, errorOnExist: true });
	await writeFile(join(output, "desk-account.json"), JSON.stringify({ kind: "account", accountOrigin: account.origin, appOrigin, ...RELEASE }) + "\n");
	const socket = new URL(origin); socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
	await writeFile(join(output, "staticwebapp.config.json"), JSON.stringify({
		mimeTypes: { ".webmanifest": "application/manifest+json" },
		globalHeaders: {
			"Content-Security-Policy": contentSecurityPolicy({ socketOrigin: socket.origin, accountOrigin: account.origin }),
			"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Strict-Transport-Security": "max-age=31536000",
			"Cache-Control": "no-cache",
		},
		routes: [
			{ route: "/auth/redirect.html", headers: { "Cache-Control": "no-store",
				"Content-Security-Policy": contentSecurityPolicy({ authCallback: true }) } },
			{ route: "/desk-account.json", headers: { "Cache-Control": "no-store" } },
			{ route: "/assets/*", headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
		],
	}, null, 2) + "\n");
}

export async function runPublishApp(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: {
		account: { type: "string" }, "app-origin": { type: "string" }, output: { type: "string" }, proxy: { type: "string" },
	} });
	if (!values.account || !values["app-origin"] || !values.output) throw new Error("Usage: pi-desk publish-app --account URL --app-origin URL --output new-directory");
	const configuration = await discoverAccount({ account: values.account, proxy: values.proxy });
	await publishApp({ account: configuration.config, appOrigin: values["app-origin"], output: values.output });
	console.log(`Static app prepared in ${resolve(values.output)}. Deploy it separately; do not copy it to the relay.`);
}
