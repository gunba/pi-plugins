import { resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./local-path.ts";

export function configuredSessionDirectory(cwd: string, agentDir: string, sessionDir?: string): string | undefined {
	const configured = sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR
		?? SettingsManager.create(cwd, agentDir).getSessionDir();
	return configured ? resolve(expandHome(configured)) : undefined;
}
