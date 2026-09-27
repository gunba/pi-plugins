import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherPath, selectedRuntime } from "../../manage/installation.ts";

export interface LoginConfig {
	version: 1; owner: string; platform: "linux" | "win32"; name: string;
	node: string; entry: string; directory: string; cwd: string;
	arguments: string[]; environment: Record<string, string>; unit?: string;
}
const defaults = [
	"PATH", "LANG", "LC_ALL", "LC_CTYPE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
	"http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
	"PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK",
	"PI_TELEMETRY", "PI_CACHE_RETENTION",
];
const transient = new Set(["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "AI_AGENT", "PI_CODING_AGENT"]);
export const loginFile = (directory: string): string => join(directory, "login.json");
export const marker = (config: LoginConfig): string => `Pi Desk login-start ${config.owner}`;
export function readLoginConfig(directory: string): LoginConfig | undefined {
	let text: string;
	try { text = readFileSync(loginFile(directory), "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	try {
		const c = JSON.parse(text) as LoginConfig;
		if (c.version !== 1 || !/^[a-f0-9-]{36}$/.test(c.owner) || !["linux", "win32"].includes(c.platform)
			|| !/^pi-desk-[a-f0-9]{16}$/.test(c.name) || ![c.node, c.entry, c.directory, c.cwd].every(v => typeof v === "string" && isAbsolute(v))
			|| realpathSync(c.directory) !== realpathSync(directory)
			|| !Array.isArray(c.arguments) || !c.arguments.every(v => typeof v === "string")
			|| !c.environment || typeof c.environment !== "object" || Array.isArray(c.environment)
			|| !Object.entries(c.environment).every(([k, v]) => /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) && typeof v === "string" && !v.includes("\0"))
			|| c.platform === "linux" && (typeof c.unit !== "string" || !isAbsolute(c.unit))) throw new Error();
		return c;
	} catch { throw new Error("Invalid login.json. It contains private startup settings; inspect it locally before reinstalling login-start."); }
}
export function makeLoginConfig(directory: string, cwd: string, arguments_: string[], extra: string[]): LoginConfig {
	if (process.platform !== "linux" && process.platform !== "win32") throw new Error("Login-start supports Linux user services and native Windows scheduled tasks.");
	for (const key of extra) {
		if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || transient.has(key.toUpperCase()) || key.toUpperCase().startsWith("PI_DESK_")) throw new Error(`Cannot save process marker or service configuration ${key}.`);
		if (!Object.keys(process.env).some(k => process.platform === "win32" ? k.toUpperCase() === key.toUpperCase() : k === key)) throw new Error(`Environment variable ${key} is not set.`);
	}
	const keys = new Set([...defaults, ...extra]);
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && [...keys].some(k => process.platform === "win32" ? k.toUpperCase() === key.toUpperCase() : k === key)) environment[key] = value;
	}
	const canonical = realpathSync(directory), digest = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex").slice(0, 16);
	const name = `pi-desk-${digest}`;
	return { version: 1, owner: randomUUID(), platform: process.platform, name, node: process.execPath,
		entry: process.env.PI_DESK_RUNTIME ? launcherPath(selectedRuntime()!.home) : fileURLToPath(new URL("./cli.js", import.meta.url)),
		directory: canonical, cwd, arguments: arguments_, environment,
		...(process.platform === "linux" ? { unit: join(resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config")), "systemd", "user", `${name}.service`) } : {}),
	};
}
export function saveLoginConfig(config: LoginConfig): void {
	writeFileSync(loginFile(config.directory), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
export function loginEnvironment(config: LoginConfig): NodeJS.ProcessEnv {
	const environment = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PI_") && k !== "AI_AGENT"));
	for (const [key, value] of Object.entries(config.environment)) {
		if (process.platform === "win32") for (const old of Object.keys(environment)) if (key.toUpperCase() === old.toUpperCase()) delete environment[old];
		environment[key] = value;
	}
	return environment;
}
export function loginPathsValid(config: LoginConfig): boolean {
	return [config.node, config.entry, config.cwd].every(existsSync);
}
