// Release deployment, one command per target.
//   node pi-desk/manage/deploy.ts host <version>     Update this computer's Desk host and wait for the outcome.
//   node pi-desk/manage/deploy.ts website [--dry-run] Publish the website from this computer's active runtime.
//   node pi-desk/manage/deploy.ts prune [--keep id]   Remove runtime versions nothing can use (updates also do this).
//                                                     --keep adds a version id/prefix to <runtime>/keep permanently.
// The website mode requires `az login` with access to the Static Web App serving account.json's appOrigin.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [mode, argument] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const runtime = join(agentDir, "desk", "runtime");
const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));

if (mode === "host" && /^\d+\.\d+\.\d+$/.test(argument ?? "")) await host(argument!);
else if (mode === "website") await website(argument === "--dry-run");
else if (mode === "prune") await prune(process.argv.slice(3));
else throw new Error("Usage: node pi-desk/manage/deploy.ts host <version> | website [--dry-run] | prune [--keep id]...");

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
		if (operation.phase === "complete") return;
		if (operation.phase === "failed") throw new Error("Host update failed; the previous runtime stays active. Check /desk status.");
	}
	throw new Error("Host update still running after 30 minutes; it continues in the background. Check /desk status.");
}

async function website(dryRun: boolean): Promise<void> {
	// The active runtime ships with its dependencies; source checkouts may not have them installed.
	const { active } = await read(join(runtime, "state.json"));
	const { desk: version } = await read(join(runtime, "versions", active, "runtime.json"));
	const cli = join(runtime, "versions", active, "source", "pi-desk", "dist", "host", "cli.js");
	const { appOrigin, config } = await read(join(agentDir, "desk", "account.json"));
	const az = (...args: string[]) => execFileSync("az", [...args, "--only-show-errors", "-o", "tsv"],
		{ encoding: "utf8", shell: process.platform === "win32" }).trim();
	const hostname = new URL(appOrigin).host;
	const [name, group] = az("staticwebapp", "list", "--query", `[?defaultHostname=='${hostname}'].[name,resourceGroup] | [0]`).split(/\s+/);
	if (!name || !group) throw new Error(`No Static Web App serves ${hostname} in the signed-in Azure subscription.`);
	const temporary = await mkdtemp(join(tmpdir(), "pi-desk-app-")), output = join(temporary, "app");
	try {
		execFileSync(process.execPath, [cli, "publish-app", "--account", config.origin, "--app-origin", appOrigin, "--output", output], { stdio: ["ignore", "ignore", "inherit"] });
		const index = createHash("sha256").update(await readFile(join(output, "index.html"))).digest("hex");
		console.log(`Website ${version} prepared for ${appOrigin} (${group}/${name}).`);
		if (dryRun) return;
		const token = az("staticwebapp", "secrets", "list", "--name", name, "--resource-group", group, "--query", "properties.apiKey");
		execFileSync("npx", ["-y", "@azure/static-web-apps-cli@2.0.10", "deploy", output, "--env", "production"],
			{ stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, SWA_CLI_DEPLOYMENT_TOKEN: token } });
		for (let attempt = 0; ; attempt++) {
			const served = await fetch(`${appOrigin}/desk-account.json`, { cache: "no-store" }).then(r => r.json()).catch(() => undefined);
			const page = await fetch(`${appOrigin}/index.html`, { cache: "no-store" }).then(r => r.arrayBuffer()).catch(() => undefined);
			if (served?.version === version && page && createHash("sha256").update(Buffer.from(page)).digest("hex") === index) break;
			if (attempt === 12) throw new Error(`The website still serves ${served?.version ?? "an unreadable version"}.`);
			await delay(5000);
		}
		console.log(`Website ${version} is live at ${appOrigin}.`);
	} finally { await rm(temporary, { recursive: true, force: true }); }
}
