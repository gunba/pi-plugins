import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { readInstallation } from "../../manage/installation.ts";
import { readState, validId } from "../../manage/store.ts";
import { runOperation, type DeskOperation } from "../../manage/operations.ts";
import { controllerAck } from "../../manage/windows-controller.ts";
import { readLoginConfig, loginEnvironment } from "./login-config.ts";

let home: string | undefined, launch: string | undefined, acknowledged = false;
const acknowledge = (result: { type: "accepted"; id: string } | { type: "failed"; error: string }) => {
	if (acknowledged) return;
	if (launch && home) writeFileSync(controllerAck(home, launch), JSON.stringify(result), { flag: "wx", mode: 0o600 });
	if (process.connected) process.send?.(result);
	acknowledged = true;
};
try {
	const args = parseArgs({ allowPositionals: true, options: { launch: { type: "string" } } });
	const [directory, action, target] = args.positionals;
	home = directory; launch = args.values.launch;
	if (!home || args.positionals.length > 3 || !["stage", "update", "update-now", "apply", "apply-now", "restart", "rollback", "stop", "login-install", "login-remove"].includes(action ?? "")
		|| action === "apply-now" && !validId(target)
		|| action === "update-now" && !/^\d+\.\d+\.\d+$/.test(target ?? "")
		|| target !== undefined && !["apply-now", "update-now"].includes(action))
		throw new Error("Invalid Desk operation.");
	if (launch) controllerAck(home, launch);
	const installation = readInstallation(home), state = readState(home);
	if (!state) throw new Error("Missing runtime state.");
	if (launch) {
		const login = readLoginConfig(installation.directory);
		if (login) process.env = loginEnvironment(login);
	}
	await runOperation({ home, source: state.source, agentDir: installation.agentDir, cwd: installation.cwd,
		directory: installation.directory, action: action as DeskOperation,
		prepared: action === "apply-now" ? target : undefined, expected: action === "update-now" ? target : undefined,
		progress: value => acknowledge({ type: "accepted", id: value.id }),
	});
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	try { acknowledge({ type: "failed", error: message }); } catch {}
	console.error(message); process.exitCode = 1;
}
