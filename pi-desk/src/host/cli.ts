#!/usr/bin/env node
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { runRelay } from "./relay-server.ts";
import { MINIMUM_NODE, RELEASE, supportsNode } from "../shared/release.ts";
import { inspectAppAssets } from "./app-assets.ts";

const help = `Pi Desk
  start [host options]       Start a detached user process
  open [--pair] [--local] [--print] [host options]
                            Start if needed and open the app
  status [--data-dir path] [--agent-dir path]
  stop [--data-dir path] [--agent-dir path]
  serve [host options]       Run in this terminal
  doctor [--data-dir path] [--agent-dir path]
  login install [host options] [--env NAME ...]
                            Enable optional login-start (host must be stopped)
  login status|remove [--data-dir path] [--agent-dir path]
  inspect [directory]       Inspect normal Pi resources
  relay [relay options]     Run the shared relay

Host options: --cwd path --port number --data-dir path --agent-dir path
              --session-dir path --relay https://server --proxy URL
Set PI_DESK_RELAY_TOKEN when connecting a host to a relay.
Use open --pair once for a new browser; normal open preserves its pairing.`;

async function main(): Promise<void> {
	const [command = "open", ...args] = process.argv.slice(2);
	if (command === "--help" || command === "help" || command === "-h") { console.log(help); return; }
	if (!supportsNode(process.versions.node)) throw new Error(`Pi Desk requires Node ${MINIMUM_NODE} or later; this process uses ${process.version}.`);
	if (command === "relay") { await runRelay(args); return; }
	if (command === "inspect") {
		if (args.length > 1 || args[0]?.startsWith("--")) throw new Error("Usage: pi-desk inspect [directory]");
		const { SessionWorker } = await import("./worker-client.ts");
		const options = { cwd: resolve(args[0] ?? process.cwd()), ephemeral: true };
		const worker = new SessionWorker(options, message => {
			if (message.type === "ui" && message.snapshot.interactions.length) {
				console.error("This project needs an interactive trust decision. Open it in the app or inspect an already trusted project.");
				for (const pending of message.snapshot.interactions) {
					void worker.command({ kind: "answer", id: pending.id, answer: null }, message.snapshot.generation).catch(() => {});
				}
			}
		});
		try {
			const snapshot = await worker.start(options);
			console.log(JSON.stringify({ model: snapshot.model, activity: snapshot.activity, extensions: snapshot.extensions,
				tools: snapshot.tools.map(tool => tool.name), commands: snapshot.commands.map(command => command.name),
				notifications: snapshot.ui.notifications }, null, 2));
		} finally { await worker.close(); }
		return;
	}
	const loginOperation = command === "login" ? args.shift() : undefined;
	if (command === "login" && !["install", "status", "remove"].includes(loginOperation ?? "")) throw new Error("Usage: pi-desk login install|status|remove [options]");
	if (!["start", "open", "serve", "status", "stop", "doctor", "login", "login-run"].includes(command)) throw new Error(help);
	const { values } = parseArgs({ args, options: {
		cwd: { type: "string" }, port: { type: "string" }, "data-dir": { type: "string" },
		"agent-dir": { type: "string" }, "session-dir": { type: "string" }, relay: { type: "string" }, proxy: { type: "string" },
		pair: { type: "boolean" }, print: { type: "boolean" }, local: { type: "boolean" }, background: { type: "boolean" },
		"host-only": { type: "boolean" },
		env: { type: "string", multiple: true },
	} });
	if (command !== "open" && (values.pair || values.print || values.local)) throw new Error("--pair, --print and --local belong to open.");
	if (values.background && command !== "serve") throw new Error("--background is used by the detached host.");
	if (values["host-only"] && command !== "stop") throw new Error("--host-only belongs to the service's stop command.");
	if (values.proxy && !values.relay) throw new Error("Use --proxy with --relay.");
	if (values.env?.length && loginOperation !== "install") throw new Error("--env belongs to login install; it names variables to save, not their values.");
	if ((["status", "stop", "doctor", "login-run"].includes(command) || command === "login" && loginOperation !== "install")
		&& ["cwd", "port", "session-dir", "relay", "proxy"].some(key => values[key as keyof typeof values] !== undefined)) {
		throw new Error(`${command} selects the host with --data-dir or --agent-dir; it does not change host options.`);
	}
	if (command === "login-run") {
		if (!values["data-dir"]) throw new Error("The login-start entry point requires --data-dir.");
		await (await import("./login.ts")).runLogin(resolve(values["data-dir"]));
		return;
	}
	const { getAgentDir, VERSION } = await import("@earendil-works/pi-coding-agent");
	const agentDir = resolve(values["agent-dir"] ?? getAgentDir());
	const directory = resolve(values["data-dir"] ?? join(agentDir, "desk"));
	const cwd = resolve(values.cwd ?? process.cwd());
	const port = values.port === undefined ? 8910 : Number(values.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
	const { probeHost, startHost, stopHost, controlRequest, openBrowser } = await import("./lifecycle.ts");
	const { readHostRecord } = await import("./host-control.ts");
	const { loginStatus, installLogin, removeLogin, startLogin, stopLogin } = await import("./login.ts");
	const { readLoginConfig } = await import("./login-config.ts");
	const launch = ["--cwd", cwd, "--port", String(port), "--data-dir", directory, "--agent-dir", agentDir];
	if (values["session-dir"]) launch.push("--session-dir", resolve(values["session-dir"]));
	if (values.relay) launch.push("--relay", values.relay);
	if (values.proxy) launch.push("--proxy", values.proxy);
	if (command === "login") {
		if (loginOperation === "status") console.log(JSON.stringify(await loginStatus(directory), null, 2));
		else if (loginOperation === "remove") {
			await removeLogin(directory);
			console.log("Login-start removed. Native sessions and other host data are retained.");
		} else {
			if (values.relay && !process.env.PI_DESK_RELAY_TOKEN) throw new Error("Set PI_DESK_RELAY_TOKEN before saving relay startup settings.");
			await installLogin(directory, cwd, launch, values.env ?? []);
			console.log("Login-start enabled for this account. Use start or open to run it now. Startup environment is saved privately in the data directory.");
		}
		return;
	}
	if (command === "status" || command === "doctor") {
		if (command === "doctor") {
			const report = await (await import("./doctor.ts")).doctor({ agentDir, directory, sdk: VERSION });
			console.log(JSON.stringify(report, null, 2));
			if (report.checks.some(check => check.status === "error")) process.exitCode = 1;
			return;
		}
		const status = await probeHost(directory);
		const startup = await loginStatus(directory);
		console.log(JSON.stringify({ ...status, startup }, null, 2));
		if (status.state === "unresponsive") process.exitCode = 1;
		return;
	}
	if (command === "stop") {
		const configured = !values["host-only"] && readLoginConfig(directory);
		const result = configured ? await stopLogin(configured) : await stopHost(directory);
		console.log(`${result.stopped ? "Host stopped." : "Host is already stopped."}${result.unclean ? " The previous exit was unconfirmed; resume saved sessions explicitly." : ""}`);
		return;
	}
	if (command === "serve") {
		inspectAppAssets();
		if (VERSION !== RELEASE.engine) throw new Error(`Pi Desk ${RELEASE.version} requires SDK ${RELEASE.engine}, but found ${VERSION}. Reinstall this Desk release; the global Pi CLI is separate.`);
		if (values.relay && !process.env.PI_DESK_RELAY_TOKEN) throw new Error("Set PI_DESK_RELAY_TOKEN for the outbound relay connection.");
		const { DeskHost } = await import("./server.ts");
		const host = new DeskHost({ cwd, port, dataDir: directory, agentDir, sessionDir: values["session-dir"] && resolve(values["session-dir"]),
			...(values.relay ? { relay: { origin: values.relay, token: process.env.PI_DESK_RELAY_TOKEN!, proxy: values.proxy } } : {}) });
		const started = await host.start();
		console.log(`Pi Desk: ${started.origin}`);
		if (!values.background) console.log(`Pair a local browser: ${started.pairingUrl}`);
		if (values.background && process.connected) process.send?.({ type: "ready" }, () => {});
		const close = () => { void host.close().catch(() => {}); };
		process.on("SIGINT", close); process.on("SIGTERM", close);
		await host.closed;
		process.exit(0);
	}
	const configured = readLoginConfig(directory);
	if (configured && ["cwd", "port", "session-dir", "relay", "proxy"].some(key => values[key as keyof typeof values] !== undefined)) {
		throw new Error("Login-start owns these startup options. Remove/reinstall it to change them, then use start/open with the same --data-dir.");
	}
	const result = configured ? await startLogin(configured) : await startHost(directory, cwd, launch);
	if (command === "start") {
		console.log(`${result.reused ? "Already running; existing startup options retained" : "Started"}: ${result.host.origin}\nData directory: ${directory}\nOpen with pi-desk open; add --pair for a new browser.${values["data-dir"] ? " Use the same --data-dir." : ""}`);
		return;
	}
	if (result.reused && ["cwd", "port", "agent-dir", "session-dir", "relay", "proxy"].some(key => values[key as keyof typeof values] !== undefined)) {
		console.error("The host is already running; existing startup options were retained. Stop it before changing them.");
	}
	let url = !values.local && result.host.relay ? result.host.relay.origin : result.host.origin;
	if (values.pair) {
		const record = readHostRecord(directory)!;
		url = (await controlRequest<{ instance: string; url: string }>(record, "invite", { local: !!values.local })).url;
	}
	if (values.print) console.log(url);
	else { await openBrowser(url); console.log("Browser open requested. Use --print to display the app link."); }
}

await main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	if (error instanceof AggregateError) for (const cause of error.errors) console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
});
