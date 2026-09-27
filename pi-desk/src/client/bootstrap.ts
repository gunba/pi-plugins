import { accountOrigin } from "../shared/account.ts";
import { apiMatches, upgradeMessage } from "../shared/release.ts";

export type Deployment = { kind: "local" } | { kind: "account"; accountOrigin: string };
export async function deployment(): Promise<Deployment> {
	const response = await fetch("/desk-account.json", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new Error(`Workspace configuration is unavailable (HTTP ${response.status}).`);
	const value = await response.json();
	if (!apiMatches(value.api)) throw new Error(upgradeMessage("This website", value.api));
	if (value.kind === "local" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) return { kind: "local" };
	if (value.kind !== "account" || accountOrigin(value.appOrigin) !== location.origin) throw new Error("Invalid workspace configuration.");
	const origin = accountOrigin(value.accountOrigin);
	if (origin === location.origin) throw new Error("The account service must have a separate origin.");
	return { kind: "account", accountOrigin: origin };
}
