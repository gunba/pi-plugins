import { basename, dirname } from "node:path";
import { DeskHost } from "../../src/host/server.ts";
import { readInstallation } from "../../manage/installation.ts";
import { runLogin } from "../../src/host/login.ts";
import { startHost } from "../../src/host/lifecycle.ts";

// Real wrapper, launcher and host processes; no registered OS service/task.
if (process.argv[2] === "wrapper") {
	const [directory, home] = process.argv.slice(3);
	await runLogin(directory, { runtime: () => ({ home }), start: startHost });
} else {
	const home = dirname(dirname(process.env.PI_DESK_RUNTIME));
	const config = readInstallation(home);
	globalThis.fetch = async url => {
		throw new Error(`Unexpected host network request: ${new URL(url).hostname}`);
	};
	const host = new DeskHost({ dataDir: config.directory, agentDir: config.agentDir, cwd: config.cwd, port: 0 });
	host.scheduleUpdateCheck = () => {};
	await host.start();
	await new Promise(resolve => setTimeout(resolve, 250));
	process.send?.({ type: "ready", runtime: basename(process.env.PI_DESK_RUNTIME) });
	process.on("SIGTERM", () => { void host.close(); });
	process.on("SIGINT", () => { void host.close(); });
	await host.closed;
	process.exit(0);
}
