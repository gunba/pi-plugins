import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { atomicJson, readRelease, readState } from "./store.ts";

export interface RuntimeInstallation {
	format: 1; directory: string; agentDir: string; cwd: string; port: number;
	sessionDir?: string; proxy?: string;
}
export const launcherPath = (home: string): string => join(home, "launch.mjs");
export const installationFile = (home: string): string => join(home, "installation.json");
export const canonicalPath = (path: string): string => {
	const absolute = existsSync(path) ? realpathSync(path) : resolve(path);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

export function readInstallation(home: string): RuntimeInstallation {
	const value = JSON.parse(readFileSync(installationFile(home), "utf8")) as RuntimeInstallation;
	if (!value || value.format !== 1
		|| ![value.directory, value.agentDir, value.cwd, ...(value.sessionDir !== undefined ? [value.sessionDir] : [])]
			.every(path => typeof path === "string" && isAbsolute(path))
		|| !Number.isInteger(value.port) || value.port < 0 || value.port > 65535
		|| value.proxy !== undefined && typeof value.proxy !== "string") throw new Error("Invalid managed runtime installation.");
	return value;
}

// This file never imports the mutable checkout. Versioned code owns everything
// after selection; changing this small bootstrap requires a stopped installation.
const bootstrap = `import {readFileSync,realpathSync,lstatSync} from "node:fs";
import {dirname,join,relative,isAbsolute,sep} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
try {
 const home=realpathSync(dirname(fileURLToPath(import.meta.url)));
 const state=JSON.parse(readFileSync(join(home,"state.json"),"utf8"));
 if(state.format!==1||typeof state.active!=="string"||!/^[a-f0-9]{64}$/.test(state.active))throw Error("No active Desk runtime. Run /desk setup in Pi.");
 const directory=join(home,"versions",state.active),entry=join(directory,"source","pi-desk","dist","host","managed.js");
 const inside=(root,path)=>{const part=relative(root,realpathSync(path));return !isAbsolute(part)&&part!==".."&&!part.startsWith(".."+sep);};
 if(lstatSync(directory).isSymbolicLink()||!inside(home,directory)||!lstatSync(entry).isFile()||!inside(directory,entry))throw Error("Invalid Desk runtime entry.");
 process.env.PI_DESK_RUNTIME=directory;
 await import(pathToFileURL(entry).href);
} catch(error) {console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
`;

/** Called under the manager and host lifecycle locks by configureRuntime. */
export function saveInstallation(home: string, value: RuntimeInstallation): void {
	const entry = launcherPath(home);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	if (existsSync(entry)) {
		if (!lstatSync(entry).isFile() || readFileSync(entry, "utf8") !== bootstrap)
			throw new Error("The managed launcher differs from this installation. Inspect it before replacing it.");
	} else writeFileSync(entry, bootstrap, { flag: "wx", mode: 0o600 });
	atomicJson(installationFile(home), value);
}

export function selectedRuntime(configured = process.env.PI_DESK_RUNTIME) {
	if (!configured) return;
	const directory = realpathSync(configured), id = basename(directory), home = dirname(dirname(directory));
	if (basename(dirname(directory)) !== "versions") throw new Error("Invalid managed runtime location.");
	const release = readRelease(home, id), state = readState(home), installation = readInstallation(home);
	if (!state || canonicalPath(state.source) !== canonicalPath(release.source))
		throw new Error("Managed runtime source does not match its installation.");
	return { home, directory, id, release, state, installation };
}

/** The host lease must already be held. This closes selection/start races. */
export function assertRuntimeHost(directory: string): string | undefined {
	const runtime = selectedRuntime();
	if (!runtime) return;
	if (canonicalPath(directory) !== canonicalPath(runtime.installation.directory))
		throw new Error("This managed runtime belongs to another host data directory.");
	if (runtime.state.active !== runtime.id)
		throw new Error("The selected Desk runtime changed before startup. Start again through the managed launcher.");
	return runtime.id;
}
