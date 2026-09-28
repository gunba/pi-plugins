import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export function configuredSessionDirectory(cwd: string, agentDir: string, sessionDir?: string): string | undefined {
	const configured = sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR
		?? SettingsManager.create(cwd, agentDir).getSessionDir();
	return configured ? resolve(configured === "~" ? homedir()
		: /^~[\\/]/.test(configured) ? join(homedir(), configured.slice(2)) : configured) : undefined;
}
