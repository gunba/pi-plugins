import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Read per request so a key saved by Desk applies to already running conversations. */
export function parallelKey(agentDir = getAgentDir()): string | undefined {
	if (process.env.PARALLEL_API_KEY?.trim()) return process.env.PARALLEL_API_KEY.trim();
	try {
		const key = JSON.parse(readFileSync(join(agentDir, "web-search.json"), "utf8"))?.parallelApiKey;
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch { return undefined; }
}
export function parallelSettings(agentDir = getAgentDir()): { configured: boolean; environment: boolean } {
	return { configured: !!parallelKey(agentDir), environment: !!process.env.PARALLEL_API_KEY?.trim() };
}
export function saveParallelKey(key: string | undefined, agentDir = getAgentDir()): void {
	const file = join(agentDir, "web-search.json");
	if (!key) { rmSync(file, { force: true }); return; }
	if (!/^[\x21-\x7e]{1,2000}$/.test(key)) throw new Error("Paste the Parallel API key without spaces.");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomUUID()}.tmp`;
	try { writeFileSync(temp, `${JSON.stringify({ parallelApiKey: key }, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, file); }
	finally { rmSync(temp, { force: true }); }
}
