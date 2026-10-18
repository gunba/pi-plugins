import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readRelease } from "../../manage/store.ts";
import { within } from "../../manage/source.ts";

/** source: the installed checkout; root: this version's pinned copy; stable: the same files under a path every version shares. */
export interface RuntimePin { source: string; root: string; stable: string }
export function runtimePin(configured?: string): RuntimePin | undefined {
	if (!configured) return;
	const directory = realpathSync(configured);
	if (basename(dirname(directory)) !== "versions") throw new Error("Invalid managed runtime location.");
	const release = readRelease(dirname(dirname(directory)), basename(directory));
	return { source: release.source, root: join(directory, "source"), stable: join(dirname(dirname(directory)), "current") };
}

/**
 * Text the model sees names Desk's files through runtime/current, a link to the running version's copy, never the
 * version's own folder: Pi's documentation (PI_PACKAGE_DIR, used by codemode's description and the prompt's docs
 * section) and skill locations. A version folder in the prompt changed the prompt with every Desk release, so each
 * conversation that moved to it paid for its whole context again. Code still loads from the version's own folder.
 */
export function stablePath(pin: RuntimePin, path: string): string {
	return within(pin.root, path) ? join(pin.stable, relative(pin.root, path)) : path;
}
/** Points runtime/current at this version's copy; a junction on Windows, which needs no privilege. */
export function pointStableRuntime(pin: RuntimePin): void {
	try { if (realpathSync(pin.stable) === realpathSync(pin.root)) return; } catch { /* Missing or dangling. */ }
	const next = `${pin.stable}.${process.pid}`;
	try { rmLink(next); } catch { /* None left over. */ }
	symlinkSync(pin.root, next, process.platform === "win32" ? "junction" : "dir");
	try { renameSync(next, pin.stable); }
	catch {
		// Windows cannot rename over an existing junction: remove the old link (never its target) and try again.
		try { if (lstatSync(pin.stable).isSymbolicLink()) rmLink(pin.stable); } catch { /* Gone already. */ }
		renameSync(next, pin.stable);
	}
}
function rmLink(path: string): void {
	if (!lstatSync(path).isSymbolicLink()) throw new Error(`${path} is not a link.`);
	if (process.platform === "win32") rmdirSync(path); else unlinkSync(path);
}
/** The Pi package this host runs, for PI_PACKAGE_DIR. */
export function piPackageDir(): string | undefined {
	try {
		for (let folder = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))); dirname(folder) !== folder; folder = dirname(folder)) {
			try { if (JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return folder; } catch { /* Keep looking. */ }
		}
	} catch { /* Not resolvable from here. */ }
}
const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

/**
 * Resource discovery alone sees the pinned package. The real manager retains
 * all persistence and trust behavior; no runtime paths are saved to settings.
 */
export function resourceSettings(settings: SettingsManager, cwd: string, agentDir: string, pin?: RuntimePin): SettingsManager {
	if (!pin) return settings;
	const original = canonical(pin.source), pinned = canonical(pin.root);
	const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
	const redirect = (value: string, base: string) => {
		const prefix = /^[!+-]/.test(value) ? value[0]! : "", path = prefix ? value.slice(1) : value;
		const expanded = path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
		const absolute = resolve(base, expanded);
		if (!within(original, absolute)) return value;
		const part = relative(original, absolute), mapped = join(pinned, part), wildcard = part.search(/[*?[{]/);
		let candidate = mapped;
		if (wildcard >= 0) {
			const leading = part.slice(0, wildcard);
			candidate = join(pinned, leading.endsWith(sep) ? leading : dirname(leading));
		}
		// Personal/project resources that were not copied still use native paths.
		return existsSync(candidate) ? prefix + mapped : value;
	};
	const project = (value: Settings, scope: "user" | "project"): Settings => {
		const result = { ...value }, base = scope === "user" ? agentDir : join(cwd, ".pi");
		if (Array.isArray(value.packages)) result.packages = value.packages.map(entry => {
			const source = typeof entry === "string" ? entry : entry.source;
			const installed = packages.getInstalledPath(source, scope);
			if (!installed || comparable(canonical(installed)) !== comparable(original)) return entry;
			return typeof entry === "string" ? pinned : { ...entry, source: pinned };
		});
		for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
			if (Array.isArray(value[kind])) result[kind] = value[kind].map(path => redirect(path, base));
		}
		return result;
	};
	return new Proxy(settings, {
		get(target, key) {
			if (key === "getGlobalSettings") return () => project(target.getGlobalSettings(), "user");
			if (key === "getProjectSettings") return () => project(target.getProjectSettings(), "project");
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
