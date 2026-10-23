import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicJson } from "../../manage/store.ts";

/**
 * Pi updates its packages only when someone runs `pi update`, and then in place, under running conversations. Desk keeps
 * the unpinned npm packages in the user's settings current itself, one folder per version, as it does its own code:
 * conversations that start or restart from then on load the newest, and running ones keep the files they started with.
 */
const NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i, KEEP_MS = 14 * 86_400_000, EVERY_MS = 6 * 3_600_000;
type Copies = Record<string, { version: string; path: string; at: number }>;

/** The newest copy of each package, by name, as a worker reads it when it starts. */
export function packageCopies(root: string): Record<string, string> {
	try {
		const copies = JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as Copies;
		return Object.fromEntries(Object.entries(copies).filter(([, copy]) => existsSync(copy.path)).map(([name, copy]) => [name, copy.path]));
	} catch { return {}; }
}

/** The package name of an unpinned npm source: `npm:name` or `npm:@scope/name`, not one with a version or range. */
export function unpinnedNpm(source: string): string | undefined {
	if (!source.startsWith("npm:")) return;
	const name = source.slice(4);
	return name.lastIndexOf("@") <= 0 && NAME.test(name) ? name : undefined;
}

export class PackageUpdates {
	private timers: ReturnType<typeof setTimeout>[] = [];
	private running?: Promise<void>;
	private readonly options: { cwd: string; agentDir: string; root: string };
	constructor(options: { cwd: string; agentDir: string; root: string }) { this.options = options; }

	start(): void {
		this.timers.push(setTimeout(() => void this.check(), 120_000), setInterval(() => void this.check(), EVERY_MS));
		for (const timer of this.timers) timer.unref();
	}
	close(): void { for (const timer of this.timers) clearTimeout(timer); }
	check(): Promise<void> { return this.running ??= this.update().finally(() => { this.running = undefined; }); }

	private async update(): Promise<void> {
		const settings = SettingsManager.create(this.options.cwd, this.options.agentDir);
		const names = (settings.getGlobalSettings().packages ?? []).map(entry => unpinnedNpm(typeof entry === "string" ? entry : entry.source))
			.filter((name): name is string => !!name);
		const copies = this.read();
		for (const name of names) {
			try {
				const latest = await latestVersion(name);
				if (copies[name]?.version === latest) continue;
				// Pi's own install is the first copy: nothing to do while it is the newest.
				const native = new DefaultPackageManager({ cwd: this.options.cwd, agentDir: this.options.agentDir, settingsManager: settings }).getInstalledPath(`npm:${name}`, "user");
				if (!copies[name] && native && installedVersion(native) === latest) continue;
				const folder = join(this.options.root, name.replace("/", "+"), latest), path = join(folder, "npm", "node_modules", ...name.split("/"));
				if (!existsSync(join(folder, ".ready"))) {
					rmSync(folder, { recursive: true, force: true }); mkdirSync(folder, { recursive: true });
					await new DefaultPackageManager({ cwd: this.options.cwd, agentDir: folder, settingsManager: settings }).install(`npm:${name}@${latest}`);
					if (installedVersion(path) !== latest) throw new Error("the install left no package");
					writeFileSync(join(folder, ".ready"), "");
				}
				// The version it replaces is marked: its two weeks start now, while conversations may still use it.
				const replaced = copies[name] && join(this.options.root, name.replace("/", "+"), copies[name]!.version);
				if (replaced && existsSync(replaced)) writeFileSync(join(replaced, ".retired"), String(Date.now()));
				copies[name] = { version: latest, path, at: Date.now() };
				this.write(copies);
				console.log(`Pi package ${name} ${latest} is ready: conversations load it as they start.`);
			} catch (error) {
				console.error(`Pi package ${name} could not be updated: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.prune(copies);
	}

	private read(): Copies {
		try { return JSON.parse(readFileSync(join(this.options.root, "current.json"), "utf8")) as Copies; } catch { return {}; }
	}
	private write(copies: Copies): void {
		mkdirSync(this.options.root, { recursive: true });
		atomicJson(join(this.options.root, "current.json"), copies);
	}
	/** Versions go two weeks after being replaced: by then the conversations that loaded them have restarted onto newer ones. */
	private prune(copies: Copies): void {
		if (!existsSync(this.options.root)) return;
		for (const entry of readdirSync(this.options.root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const name = entry.name.replace("+", "/"), versions = join(this.options.root, entry.name);
			for (const version of readdirSync(versions)) {
				const folder = join(versions, version);
				try {
					if (copies[name]?.version === version) continue;
					const retired = existsSync(join(folder, ".retired")) ? Number(readFileSync(join(folder, ".retired"), "utf8")) : statSync(folder).mtimeMs;
					if (Date.now() - retired > KEEP_MS) rmSync(folder, { recursive: true, force: true });
				}
				catch { /* In use or gone: next time. */ }
			}
		}
	}
}

function installedVersion(path: string): string | undefined {
	try { return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version; } catch { return undefined; }
}
/** Through npm, which knows this computer's registry and proxy. The name is checked, so the Windows shell sees no syntax. */
async function latestVersion(name: string): Promise<string> {
	const { stdout } = await promisify(execFile)("npm", ["view", name, "version", "--json"], { timeout: 60_000, shell: process.platform === "win32", windowsHide: true });
	// A string, or a list of one (newer npm).
	const output = JSON.parse(stdout), version = Array.isArray(output) ? output.at(-1) : output;
	if (typeof version !== "string") throw new Error("npm gave no version");
	return version;
}
