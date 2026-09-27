import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AccountServer } from "./server.ts";
import { MINIMUM_NODE, supportsNode } from "../shared/release.ts";

async function main(): Promise<void> {
	if (!supportsNode(process.versions.node)) throw new Error(`Pi Desk requires Node ${MINIMUM_NODE} or later.`);
	const { values } = parseArgs({ options: {
		config: { type: "string" }, "key-file": { type: "string" }, "data-dir": { type: "string" },
		port: { type: "string", default: process.env.PORT ?? "8930" },
		listen: { type: "string", default: "127.0.0.1" },
	} });
	const port = Number(values.port), directory = values["data-dir"] ?? process.env.PI_DESK_ACCOUNT_DATA;
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !directory) throw new Error("Set a valid port and account data directory.");
	const config = values.config ? await readFile(values.config, "utf8") : process.env.PI_DESK_ACCOUNT_CONFIG;
	const key = values["key-file"] ? await readFile(values["key-file"], "utf8") : process.env.PI_DESK_ACCOUNT_KEY;
	if (!config || !key) throw new Error("Account configuration and signing key are required.");
	const server = await AccountServer.open({ config: JSON.parse(config), signingKey: JSON.parse(key), directory: resolve(directory) });
	try { await server.listen(port, values.listen); }
	catch (error) { await server.close(); throw error; }
	console.log(`Pi Desk account service: ${server.config.origin}`);
	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		void server.close().then(() => process.exit(0), () => process.exit(1));
	};
	process.once("SIGTERM", close); process.once("SIGINT", close);
}
void main().catch(() => { console.error("Pi Desk account service could not start. Check its configuration and data directory."); process.exitCode = 1; });
