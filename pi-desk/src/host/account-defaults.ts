import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountSelection } from "./account-credentials.ts";

export function accountDefaults(directory: string): AccountSelection {
	let value: unknown;
	try { value = JSON.parse(readFileSync(join(directory, "defaults.json"), "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([provider, id]) =>
		!provider || provider.length > 200 || /[\x00-\x1f]/.test(provider) || typeof id !== "string" || (id !== "pi" && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))))
		throw Error("Saved computer account defaults are invalid.");
	return { ...value as AccountSelection };
}
