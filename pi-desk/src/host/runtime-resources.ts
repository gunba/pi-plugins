import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { within } from "../../manage/source.ts";

export { piPackageDir, pointStableRuntime, runtimePin, stablePath, type RuntimePin } from "./stable-runtime.ts";
import { unpinnedNpm } from "./package-updates.ts";
import type { RuntimePin } from "./stable-runtime.ts";
const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

/**
 * Resource discovery alone sees the pinned package. The real manager retains
 * all persistence and trust behavior; no runtime paths are saved to settings.
 */
/** `copies`: the newest Desk-kept copy of each unpinned npm package (package-updates.ts), loaded instead of Pi's own install. */
export function resourceSettings(settings: SettingsManager, cwd: string, agentDir: string, pin?: RuntimePin, copies: Record<string, string> = {}): SettingsManager {
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
			const copy = scope === "user" ? copies[unpinnedNpm(source) ?? ""] : undefined;
			if (copy) return typeof entry === "string" ? copy : { ...entry, source: copy };
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
