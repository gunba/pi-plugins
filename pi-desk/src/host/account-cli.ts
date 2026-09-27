import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAccount, readAccount, saveAccount } from "./account-config.ts";
import { NativeAccountIdentity } from "./account-identity.ts";
import { openBrowser, controlRequest } from "./lifecycle.ts";
import { readHostRecord } from "./host-control.ts";

export async function runAccountCommand(command: "signin" | "signout", args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: {
		workspace: { type: "string" }, account: { type: "string" }, proxy: { type: "string" },
		"data-dir": { type: "string" }, "agent-dir": { type: "string" }, name: { type: "string" },
	} });
	if (values.workspace && values.account) throw new Error("Choose --workspace or --account, not both.");
	if (command === "signout" && (values.workspace || values.account || values.name)) throw new Error("Sign out selects the existing data directory.");
	const directory = resolve(values["data-dir"] ?? join(resolve(values["agent-dir"] ?? getAgentDir()), "desk"));
	const saved = await readAccount(directory);
	const chosen = command === "signin" && (values.workspace || values.account)
		? await discoverAccount({ workspace: values.workspace, account: values.account, proxy: values.proxy }) : saved;
	if (!chosen) throw new Error("Use pi-desk signin --workspace https://desk.example with this data directory.");
	if (saved && (saved.config.origin !== chosen.config.origin || saved.config.tenantId !== chosen.config.tenantId
		|| saved.config.ownerObjectId !== chosen.config.ownerObjectId || saved.config.clientId !== chosen.config.clientId)) {
		throw new Error("This computer is configured for another workspace. Use a separate data directory.");
	}
	let identity = await NativeAccountIdentity.open(directory, chosen.config, { create: command === "signin", proxy: values.proxy });
	try {
		if (command === "signout") {
			await identity.signOut();
			console.log("Computer enrolment revoked. Native conversations are retained.");
		} else {
			// Save public configuration before opening OAuth so a cancelled attempt can be retried.
			await saveAccount(directory, chosen);
			console.log("Signing in to enrol this computer. Existing Microsoft authorization will be reused where possible.");
			await identity.signIn(openBrowser);
			try { await identity.enrol(values.name ?? hostname()); }
			catch (error) {
				if (!(error instanceof Error) || error.message !== "device_revoked") throw error;
				const previous = identity.device.id;
				identity.close();
				identity = await NativeAccountIdentity.open(directory, chosen.config, {
					create: true, proxy: values.proxy, replaceRevokedId: previous,
				});
				await identity.enrol(values.name ?? hostname());
			}
			console.log("Signed in. This computer is enrolled in your Pi Desk workspace.");
		}
	} finally { identity.close(); }
	const host = readHostRecord(directory);
	if (host) {
		try { await controlRequest(host, "account", {}); }
		catch { console.error("Host account refresh was not confirmed. Check pi-desk status; native conversations are retained."); }
	}
}
