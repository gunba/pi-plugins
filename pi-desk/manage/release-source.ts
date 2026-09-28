import { canonicalPath } from "./installation.ts";

export async function personalPackageSource(source: string, cwd: string, agentDir: string): Promise<string> {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const packages = new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	const configured = packages.listConfiguredPackages().find(pkg => pkg.scope === "user" && pkg.installedPath
		&& canonicalPath(pkg.installedPath) === canonicalPath(source));
	if (!configured) throw new Error("Install this Pi package in personal settings before managing Desk.");
	return configured.source;
}
export function releaseSourceSupported(source: string): boolean {
	const url = source.replace(/^git:/, "").replace(/\.git(?=@|$)/, "");
	return /^(?:https:\/\/|ssh:\/\/git@|git@)?github\.com[/:]gunba\/pi-plugins(?:@main)?$/.test(url);
}
