import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The Gemini provider (pi-antigravity-acp-provider, loaded next) lets Antigravity's own commands and edits run unasked
 * unless config.json says otherwise. Gemini works through Pi's tools, where Pi's command guard and Desk's change
 * tracking apply, and Antigravity's own actions bypass both, so a computer without a saved choice gets "default": each
 * one asks first. A choice saved with /antigravity-acp permissions stays. The path is the provider's resolveConfigPath.
 */
export default function antigravityDefaults(): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim().replace(/^~(?=$|\/)/, homedir()) || join(homedir(), ".pi", "agent");
	const config = join(agentDir, "antigravity-acp-provider", "config.json");
	if (existsSync(config)) return;
	mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
	writeFileSync(config, `${JSON.stringify({ permissions: "default" }, null, "\t")}\n`, { mode: 0o600 });
}
