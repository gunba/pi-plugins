// Release deployment, one command per target.
//   node pi-desk/manage/deploy.ts host <version>     Update this computer's Desk host and wait for the outcome.
//   node pi-desk/manage/deploy.ts website            Wait until the workspace server serves this computer's Desk version.
//   node pi-desk/manage/deploy.ts relay              Report the relay's version.
//   node pi-desk/manage/deploy.ts prune [--keep id]   Remove runtime versions nothing can use (updates also do this).
//                                                     --keep adds a version id/prefix to <runtime>/keep permanently.
// The workspace server (the Perth server) publishes the website and installs the relay and account service from the Desk
// version it runs, so they update when its Desk does (pi-desk-services-update on that server).
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [mode, argument] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const runtime = join(agentDir, "desk", "runtime");
const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));

if (mode === "host" && /^\d+\.\d+\.\d+$/.test(argument ?? "")) await host(argument!);
else if (mode === "website") await website();
else if (mode === "relay") await relayDeploy();
else if (mode === "prune") await prune(process.argv.slice(3));
else throw new Error("Usage: node pi-desk/manage/deploy.ts host <version> | website | relay | prune [--keep id]...");

async function relayDeploy(): Promise<void> {
	const { config } = await read(join(agentDir, "desk", "account.json"));
	const health = await fetch(`${config.relayOrigin}/health`, { cache: "no-store" }).then(r => r.json()).catch(() => undefined);
	console.log(`The relay at ${config.relayOrigin} updates itself with its server's Desk; it reports ${health?.version ?? "no version"}.`);
}

async function prune(args: string[]): Promise<void> {
	const { SessionLease } = await import("../../pi-session-ownership/lease.ts");
	const { keepList, pruneRuntimes } = await import("./prune.ts");
	const keep = args.flatMap((arg, index) => args[index - 1] === "--keep" ? [arg.toLowerCase()] : []);
	if (args.length !== keep.length * 2 || keep.some(id => !/^[a-f0-9]{6,64}$/.test(id))) throw new Error("Usage: prune [--keep <runtime id or 6+ hex prefix>]...");
	const lease = new SessionLease(join(runtime, "manage"));
	try {
		const listed = keepList(runtime), added = keep.filter(id => !listed.includes(id));
		if (added.length) await appendFile(join(runtime, "keep"), added.map(id => id + "\n").join(""));
		const result = await pruneRuntimes(runtime);
		if (result.skipped) throw new Error(`Nothing removed: ${result.skipped}`);
		if (!result.kept.length) throw new Error("Nothing removed: no active runtime.");
		console.log(`Removed ${result.removed.length} runtime versions and ${result.archives} archives; kept ${result.kept.length}`
			+ (result.busy.length ? `; ${result.busy.length} in use were left` : "") + ".");
	} finally { lease.close(); }
}

async function host(version: string): Promise<void> {
	const data = (await read(join(runtime, "installation.json"))).directory as string;
	const { origin } = await read(join(data, "host.json")), { operator } = await read(join(data, "access.json"));
	const running = await (await fetch(`${origin}/desk-account.json`)).json() as { api: number; version: string };
	if (running.version === version) { console.log(`Desk host is already ${version}.`); return; }
	const before = await read(join(runtime, "operation.json")).catch(() => ({}));
	const response = await fetch(`${origin}/api/runtime/update-now`, { method: "POST", body: JSON.stringify({ version }),
		headers: { Authorization: `Bearer ${operator}`, "X-Pi-Desk-API": String(running.api), "Content-Type": "application/json" } });
	if (response.status !== 202) throw new Error(`Host refused the update (${response.status}): ${await response.text()}`);
	console.log(`Updating Desk host ${running.version} -> ${version}. Workers keep running.`);
	let last = "";
	for (const until = Date.now() + 30 * 60_000; Date.now() < until; await delay(2000)) {
		const operation = await read(join(runtime, "operation.json")).catch(() => undefined);
		if (!operation || operation.id === before.id) continue;
		if (operation.message !== last) console.log(`  ${operation.phase}: ${last = operation.message}`);
		// A handed-over update completes the download; the new release's own controller then applies it.
		if (operation.phase === "complete" && !operation.handoff) return;
		if (operation.phase === "failed") throw new Error("Host update failed; the previous runtime stays active. Check /desk status.");
	}
	throw new Error("Host update still running after 30 minutes; it continues in the background. Check /desk status.");
}

async function website(): Promise<void> {
	const { active } = await read(join(runtime, "state.json"));
	const { desk: version } = await read(join(runtime, "versions", active, "runtime.json"));
	const { appOrigin } = await read(join(agentDir, "desk", "account.json"));
	// The server publishes each Desk version it updates to; it checks for updates hourly.
	for (let attempt = 0; ; attempt++) {
		const served = await fetch(`${appOrigin}/desk-account.json`, { cache: "no-store" }).then(r => r.json()).catch(() => undefined);
		if (served?.version === version) break;
		if (attempt === 0) console.log(`Waiting for ${appOrigin} to serve ${version} (now ${served?.version ?? "unreadable"}); the workspace server publishes it after updating its Desk.`);
		if (attempt === 120) throw new Error(`The website still serves ${served?.version ?? "an unreadable version"}.`);
		await delay(30_000);
	}
	console.log(`Website ${version} is live at ${appOrigin}.`);
}
