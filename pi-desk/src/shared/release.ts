import manifest from "../../package.json" with { type: "json" };

// Increment when the app/host DTO or command contract changes incompatibly.
export const API_VERSION = 8;
export const API_HEADER = "X-Pi-Desk-API";
export const MINIMUM_NODE = manifest.engines.node.slice(2);
export function supportsNode(version: string): boolean {
	const current = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!current) return false;
	const minimum = MINIMUM_NODE.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const difference = Number(current[index + 1]) - minimum[index]!;
		if (difference) return difference > 0;
	}
	return true;
}
export const RELEASE = {
	api: API_VERSION, version: manifest.version,
	engine: manifest.dependencies["@earendil-works/pi-coding-agent"],
};
export type ReleaseInfo = typeof RELEASE;
export const apiMatches = (value: unknown): boolean => value === API_VERSION || value === String(API_VERSION);
export function upgradeMessage(component: string, version?: unknown): string {
	const received = typeof version === "number" || typeof version === "string" ? String(version).slice(0, 24) : "unversioned";
	return `${component} uses API ${received}; this release uses API ${API_VERSION}. Update the app/server and affected computer to compatible Pi Desk releases, then reload the app. Native conversations are retained.`;
}
