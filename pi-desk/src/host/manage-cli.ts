import { readInstallation } from "../../manage/installation.ts";
import { readState } from "../../manage/store.ts";
import { runOperation, type DeskOperation } from "../../manage/operations.ts";

const [home, action] = process.argv.slice(2);
try {
	if (!home || !["stage", "update", "apply", "restart", "rollback", "stop", "login-install", "login-remove"].includes(action ?? "")) throw new Error("Invalid Desk operation.");
	const installation = readInstallation(home), state = readState(home);
	if (!state) throw new Error("Missing runtime state.");
	let accepted = false;
	await runOperation({ home, source: state.source, agentDir: installation.agentDir, cwd: installation.cwd,
		directory: installation.directory, action: action as DeskOperation,
		progress: value => {
			if (!accepted) { accepted = true; if (process.connected) process.send?.({ type: "accepted", id: value.id }); }
		},
	});
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (process.connected) process.send?.({ type: "failed", error: message }); console.error(message); process.exitCode = 1;
}
