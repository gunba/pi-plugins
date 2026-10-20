import { accountOrigin } from "../shared/account.ts";
import { apiMatches, upgradeMessage } from "../shared/release.ts";

export type Deployment = { kind: "local" } | { kind: "account"; accountOrigin: string };
const SAVED = "pi-desk:workspace-configuration";
/**
 * The workspace's configuration. It rarely changes, so the last one this browser received is used when the website is
 * slow to answer (3 s) or unreachable: on a plane, the 10 s limit this had failed the whole load. With none saved, it is
 * waited for. One saved by a different version of the app fails its checks and is not used.
 */
export function deployment(): Promise<Deployment> {
	const saved = localStorage.getItem(SAVED);
	const fromSaved = () => { try { return saved ? read(JSON.parse(saved)) : undefined; } catch { return undefined; } };
	const network = (async () => {
		const response = await fetch("/desk-account.json", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new Error(`Workspace configuration is unavailable (HTTP ${response.status}).`);
		const text = await response.text(), value = read(JSON.parse(text));
		localStorage.setItem(SAVED, text);
		return value;
	})();
	return savedOrNetwork(network, fromSaved);
}
/**
 * The network's answer, or the saved one when the network is slow (`wait`) or fails: for configuration that rarely
 * changes, so a slow link does not hold up or fail the load. With nothing saved, the network is waited for.
 */
export function savedOrNetwork<T>(network: Promise<T>, saved: () => T | undefined, wait = 3000): Promise<T> {
	if (saved() === undefined) return network;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (value: T) => { if (!settled) { settled = true; resolve(value); } };
		network.then(finish, error => { const value = saved(); if (value !== undefined) finish(value); else if (!settled) { settled = true; reject(error); } });
		setTimeout(() => { const value = saved(); if (value !== undefined) finish(value); }, wait);
	});
}
function read(value: { api?: unknown; kind?: unknown; appOrigin?: unknown; accountOrigin?: unknown }): Deployment {
	if (!apiMatches(value.api as number)) throw new Error(upgradeMessage("This website", value.api as number));
	if (value.kind === "local" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) return { kind: "local" };
	if (value.kind !== "account" || accountOrigin(value.appOrigin as string) !== location.origin) throw new Error("Invalid workspace configuration.");
	const origin = accountOrigin(value.accountOrigin as string);
	if (origin === location.origin) throw new Error("The account service must have a separate origin.");
	return { kind: "account", accountOrigin: origin };
}
