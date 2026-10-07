import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveWorker } from "../../src/host/worker-runtime.ts";

const runtime = await serveWorker(process.argv[2], async send => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	let options, writes = 0, inFlight = 0, closed = false;
	const snapshot = () => ({
		id: "11111111-1111-4111-8111-111111111111", cwd: options?.cwd ?? process.cwd(), file: options?.sessionFile, leaf: "fixture-leaf",
		activity: inFlight ? "running" : "idle", thinking: "off", thinkingLevels: ["off"], tools: [], extensions: [], commands: [], models: [],
		accounts: { codex: "fixture-account" }, queue: { steering: { count: 0, previews: [] }, followUp: { count: 0, previews: [] } },
		ui: { generation: "fixture-generation", views: [], interactions: [], statuses: {}, notifications: [], editorText: "", editorId: "fixture-editor", title: "Fixture" },
		writes, pid: process.pid, child: child.pid, runtimePin: process.env.PI_DESK_RUNTIME,
	});
	return {
		async start(value) { options = value; return snapshot(); }, snapshot,
		async command(_generation, command) {
			if (command.kind === "snapshot") return snapshot();
			inFlight++;
			send({ type: "snapshot", snapshot: snapshot() });
			send({ type: "event", event: { type: "fixture-accepted" } });
			if (command.text === "Held during update") {
				while (!closed && !existsSync(join(options.cwd, "allow-finish"))) await new Promise(resolve => setTimeout(resolve, 5));
			} else await new Promise(resolve => setTimeout(resolve, 250));
			writes++; inFlight--;
			send({ type: "snapshot", snapshot: snapshot() });
			return snapshot();
		},
		async checkpoint() {},
		async shutdownCheckpoint() { return snapshot(); },
		async close() { if (closed) return; closed = true; const exit = once(child, "exit"); child.kill(); await exit; },
	};
});
process.on("SIGTERM", () => { void runtime.stop(); });
runtime.closed.then(() => process.exit(0), () => process.exit(1));
