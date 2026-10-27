import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Read per request so a key saved by Desk applies to already running conversations. */
export function exaKey(agentDir = getAgentDir()): string | undefined {
	if (process.env.EXA_API_KEY?.trim()) return process.env.EXA_API_KEY.trim();
	try {
		const key = JSON.parse(readFileSync(join(agentDir, "web-search.json"), "utf8"))?.exaApiKey;
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch { return undefined; }
}
export function exaSettings(agentDir = getAgentDir()): { configured: boolean; environment: boolean } {
	return { configured: !!exaKey(agentDir), environment: !!process.env.EXA_API_KEY?.trim() };
}
export function saveExaKey(key: string | undefined, agentDir = getAgentDir()): void {
	const file = join(agentDir, "web-search.json");
	if (!key) { rmSync(file, { force: true }); return; }
	if (!/^[\x21-\x7e]{1,2000}$/.test(key)) throw new Error("Paste the Exa API key without spaces.");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomUUID()}.tmp`;
	try { writeFileSync(temp, `${JSON.stringify({ exaApiKey: key }, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, file); }
	finally { rmSync(temp, { force: true }); }
}
