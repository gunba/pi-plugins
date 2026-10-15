import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAccount, readAccount, saveAccount } from "./account-config.ts";
import { NativeAccountIdentity, type EnrolmentApproval } from "./account-identity.ts";
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
	if (saved && (saved.config.origin !== chosen.config.origin || saved.config.workspace !== chosen.config.workspace)) {
		throw new Error("This computer is configured for another workspace. Use a separate data directory.");
	}
	const identityOrigin = saved?.identityOrigin;
	let identity = await NativeAccountIdentity.open(directory, chosen.config, { create: command === "signin", proxy: values.proxy, identityOrigin });
	try {
		if (command === "signout") {
			await identity.signOut();
			console.log("Computer enrolment revoked. Native conversations are retained.");
		} else {
			// Save public configuration first so a cancelled approval can be retried.
			await saveAccount(directory, { ...chosen, ...(identityOrigin ? { identityOrigin } : {}) });
			const show = async (approval: EnrolmentApproval) => {
				console.log(`To approve this computer, open this link in any browser and sign in with the workspace owner's Google account:\n\n  ${approval.url}\n\nCheck that the page shows the code ${approval.code}. Waiting for approval…`);
				await openBrowser(approval.url).catch(() => {});
			};
			try { await identity.signIn(values.name ?? hostname(), show); }
			catch (error) {
				if (!(error instanceof Error) || error.message !== "device_revoked") throw error;
				const previous = identity.device.id;
				identity.close();
				identity = await NativeAccountIdentity.open(directory, chosen.config, {
					create: true, proxy: values.proxy, replaceRevokedId: previous, identityOrigin,
				});
				await identity.signIn(values.name ?? hostname(), show);
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
