import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { accountConfiguration, accountOrigin, type AccountConfiguration } from "../shared/account.ts";
import { AccountNetwork } from "./account-network.ts";

export interface SavedAccount { version: 1; appOrigin: string; config: AccountConfiguration }
export async function readAccount(directory: string): Promise<SavedAccount | undefined> {
	try {
		const value = JSON.parse(await readFile(join(directory, "account.json"), "utf8")) as SavedAccount;
		if (value.version !== 1) throw new Error("Invalid saved account.");
		const config = accountConfiguration(value.config), appOrigin = accountOrigin(value.appOrigin);
		if (!config.appOrigins.includes(appOrigin)) throw new Error("Account does not authorize this app.");
		return { version: 1, appOrigin, config };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error("Cannot read the saved Pi Desk account configuration.");
	}
}
export async function saveAccount(directory: string, value: SavedAccount): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `account.${crypto.randomUUID()}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
		await rename(temporary, join(directory, "account.json"));
	} finally { await rm(temporary, { force: true }); }
}
export async function discoverAccount(options: { workspace?: string; account?: string; proxy?: string }): Promise<SavedAccount> {
	const network = new AccountNetwork(options.proxy);
	try {
		let origin: string, appOrigin: string | undefined;
		if (options.workspace) {
			appOrigin = accountOrigin(options.workspace);
			const response = await network.request<{ accountOrigin?: string }>("GET", `${appOrigin}/desk-account.json`);
			if (response.status !== 200 || !response.body.accountOrigin) throw new Error("This workspace has not enabled account sign-in.");
			origin = accountOrigin(response.body.accountOrigin);
		} else if (options.account) origin = accountOrigin(options.account);
		else throw new Error("Choose a Pi Desk workspace.");
		const response = await network.request<AccountConfiguration>("GET", `${origin}/config`);
		if (response.status !== 200) throw new Error("Account configuration is unavailable.");
		const config = accountConfiguration(response.body);
		if (config.origin !== origin) throw new Error("Account authority does not match the selected workspace.");
		appOrigin ??= config.appOrigins[0];
		if (!config.appOrigins.includes(appOrigin)) throw new Error("Account does not authorize this app.");
		return { version: 1, appOrigin, config };
	} finally { network.close(); }
}
