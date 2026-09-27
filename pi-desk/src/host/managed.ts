import { resolve } from "node:path";
import { canonicalPath, selectedRuntime } from "../../manage/installation.ts";
import { readLoginConfig } from "./login-config.ts";

const runtime = selectedRuntime();
if (!runtime || runtime.state.active !== runtime.id) throw new Error("Start Desk through its managed launcher.");
const [command = "open", ...args] = process.argv.slice(2);
const allowed = ["open", "start", "serve", "stop", "status", "doctor", "login", "login-run", "signin", "signout", "inspect", "--help", "-h", "help"];
if (!allowed.includes(command)) throw new Error("The managed launcher runs the local Desk host. Use the standalone package for server deployments.");
const values = (flag: string): string[] => args.flatMap((arg, index) => {
	if (arg === flag) {
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
		return [value];
	}
	return arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : [];
});
const set = (flag: string, value: string) => { if (!values(flag).length) args.push(flag, value); };
const { installation } = runtime;
process.env.PI_CODING_AGENT_DIR = installation.agentDir;
if (!["inspect", "--help", "-h", "help"].includes(command)) {
	for (const [flag, expected] of [["--data-dir", installation.directory], ["--agent-dir", installation.agentDir]] as const) {
		if (values(flag).some(value => canonicalPath(resolve(value)) !== canonicalPath(expected)))
			throw new Error(`${flag} belongs to this managed installation and cannot be changed at launch.`);
		set(flag, expected);
	}
	if (command === "serve" || ["start", "open"].includes(command) && !readLoginConfig(installation.directory)
		|| command === "login" && args[0] === "install") {
		set("--cwd", installation.cwd); set("--port", String(installation.port));
		if (installation.sessionDir) set("--session-dir", installation.sessionDir);
		if (installation.proxy) set("--proxy", installation.proxy);
	}
}
process.argv.splice(2, process.argv.length - 2, command, ...args);
await import("./cli.ts");
