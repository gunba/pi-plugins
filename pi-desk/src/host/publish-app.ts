import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { remoteOrigins } from "../shared/relay-protocol.ts";
import { RELEASE } from "../shared/release.ts";
import { clientDirectory, inspectAppAssets } from "./app-assets.ts";
import { contentSecurityPolicy } from "./static.ts";

export async function publishApp(options: { relay: string; appOrigin: string; output: string }, directory = clientDirectory()): Promise<void> {
	const { origin, appOrigin } = remoteOrigins(options.relay, options.appOrigin);
	directory = resolve(directory);
	const output = resolve(options.output);
	if (output === directory || output.startsWith(directory + sep)) throw new Error("Publish outside the installed client directory.");
	inspectAppAssets(directory);
	await mkdir(dirname(output), { recursive: true });
	await mkdir(output); // A deployment is a fresh artifact, never an in-place overwrite.
	await cp(directory, output, { recursive: true, force: false, errorOnExist: true });
	await writeFile(join(output, "desk-transport.json"), JSON.stringify({ kind: "relay", relay: origin, appOrigin, ...RELEASE }) + "\n");
	const socket = new URL(origin); socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
	await writeFile(join(output, "staticwebapp.config.json"), JSON.stringify({
		mimeTypes: { ".webmanifest": "application/manifest+json" },
		globalHeaders: {
			"Content-Security-Policy": contentSecurityPolicy(socket.origin),
			"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Strict-Transport-Security": "max-age=31536000",
			"Cache-Control": "no-cache",
		},
		routes: [
			{ route: "/desk-transport.json", headers: { "Cache-Control": "no-store" } },
			{ route: "/assets/*", headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
		],
	}, null, 2) + "\n");
}

export async function runPublishApp(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: {
		relay: { type: "string" }, "app-origin": { type: "string" }, output: { type: "string" },
	} });
	if (!values.relay || !values["app-origin"] || !values.output) throw new Error("Usage: pi-desk publish-app --relay URL --app-origin URL --output new-directory");
	await publishApp({ relay: values.relay, appOrigin: values["app-origin"], output: values.output });
	console.log(`Static app prepared in ${resolve(values.output)}. Deploy it separately; do not copy it to the relay.`);
}
