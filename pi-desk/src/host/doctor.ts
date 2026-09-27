import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MINIMUM_NODE, RELEASE, apiMatches, supportsNode } from "../shared/release.ts";
import { inspectAppAssets } from "./app-assets.ts";
import { probeHost, type HostProbe } from "./lifecycle.ts";
import { loginStatus } from "./login.ts";
import { remoteOrigins } from "../shared/relay-protocol.ts";

export interface DoctorCheck { id: string; status: "ok" | "warning" | "error"; message: string }
export function connectionChecks(status: HostProbe): DoctorCheck[] {
	if (status.state === "unresponsive") return [{ id: "host", status: "error", message: status.error ?? "The host is not responding. No process was signalled." }];
	if (status.state !== "running") return [{ id: "host", status: "warning",
		message: status.state === "stopping" ? "The host is still stopping. Wait for cleanup before starting it again."
			: "The host is stopped. Live connections and session resources were not checked." }];
	const checks: DoctorCheck[] = [{ id: "host", status: "ok", message: "The authenticated local host is responding." }];
	if (!apiMatches(status.host?.release?.api)) checks.push({ id: "host-api", status: "error",
		message: "The running host uses a different API. Stop and restart it after updating; keep its data directory." });
	const relay = status.host?.relay;
	if (relay) checks.push({ id: "relay", status: relay.state === "online" ? "ok" : "error",
		message: relay.state === "online" ? "The host's outbound relay connection is online."
			: `The relay is ${relay.state}. Remote access is unavailable; local recovery remains usable. Check account sign-in, the account service, approved proxy/certificates and network policy.` });
	if (relay) {
		try {
			remoteOrigins(relay.origin, relay.appOrigin);
			checks.push({ id: "app-origin", status: "ok", message: "The configured browser app is separate from the relay. Its deployed files and browser connection still need verification." });
		} catch { checks.push({ id: "app-origin", status: "error", message: "Sign in to a workspace with separate app and relay addresses." }); }
	}
	return checks;
}

function directoryCheck(path: string, mustExist: boolean): string {
	if (mustExist && !existsSync(path)) throw new Error(`Directory does not exist: ${path}. Select or create the Pi agent directory.`);
	let parent = path;
	while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
	if (!statSync(parent).isDirectory()) throw new Error(`Not a directory: ${parent}`);
	accessSync(parent, constants.R_OK | constants.W_OK);
	return existsSync(path) ? `Directory is accessible: ${path}` : `Directory can be created beneath ${parent}.`;
}

export async function doctor(options: { agentDir: string; directory: string; sdk: string }) {
	const { agentDir, directory, sdk } = options;
	const checks: DoctorCheck[] = [];
	const check = (id: string, operation: () => string) => {
		try { checks.push({ id, status: "ok", message: operation() }); }
		catch (error) { checks.push({ id, status: "error", message: error instanceof Error ? error.message : String(error) }); }
	};
	check("node", () => { if (!supportsNode(process.versions.node)) throw new Error(`Use Node ${MINIMUM_NODE} or later.`); return `Node ${process.versions.node} meets the ${MINIMUM_NODE} minimum.`; });
	check("sdk", () => { if (sdk !== RELEASE.engine) throw new Error(`Installed SDK ${sdk} differs from pinned SDK ${RELEASE.engine}. Reinstall this Desk release.`); return `SDK ${sdk} matches this release.`; });
	check("client", () => { const assets = inspectAppAssets(); return `Built app is present (${assets.files} files checked).`; });
	check("agent-directory", () => directoryCheck(agentDir, true));
	check("data-directory", () => directoryCheck(directory, false));
	let status: HostProbe | undefined;
	try { status = await probeHost(directory); checks.push(...connectionChecks(status)); }
	catch (error) { checks.push({ id: "host", status: "error", message: error instanceof Error ? error.message : String(error) }); }
	let startup: Awaited<ReturnType<typeof loginStatus>> | undefined;
	try {
		startup = await loginStatus(directory);
		if (startup.error) checks.push({ id: "login-start", status: "error", message: startup.error });
		else checks.push({ id: "login-start", status: startup.configured && !startup.enabled ? "error" : "ok",
			message: !startup.configured ? "Optional login-start is not configured." : startup.enabled
				? "Login-start is enabled for this account." : "Login-start is missing or disabled. Remove/reinstall it to restore automatic startup." });
	} catch (error) { checks.push({ id: "login-start", status: "error", message: error instanceof Error ? error.message : String(error) }); }
	return { release: RELEASE, node: process.version, platform: process.platform, pi: sdk, executable: process.execPath,
		agentDir, dataDir: directory, status, startup, checks };
}
