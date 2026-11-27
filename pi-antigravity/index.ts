import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The Gemini provider (pi-antigravity-acp-provider, loaded next) lets Antigravity's own commands and edits run unasked
 * unless config.json says otherwise. Gemini works through Pi's tools, where Pi's command guard and Desk's change
 * tracking apply, and Antigravity's own actions bypass both, so a computer without a saved choice gets "default": each
 * one asks first. A choice saved with /antigravity-acp permissions stays. The path is the provider's resolveConfigPath.
 */
export default function antigravityDefaults(pi: ExtensionAPI): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim().replace(/^~(?=$|\/)/, homedir()) || join(homedir(), ".pi", "agent");
	const config = join(agentDir, "antigravity-acp-provider", "config.json");
	if (!existsSync(config)) {
		mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
		writeFileSync(config, `${JSON.stringify({ permissions: "default" }, null, "\t")}\n`, { mode: 0o600 });
	}
	// The provider creates its runtime while loading, after this extension.
	pi.on("session_start", () => allowPiTools());
}

interface PermissionRequest {
	toolCall?: { _meta?: { is_mcp_tool_call?: unknown; mcp?: { server?: unknown } } };
	options?: { optionId: string; kind: string }[];
}
interface Binding { writer?: { finished?: boolean }; abortRequested?: boolean }
type Ask = (binding: Binding | undefined, request: PermissionRequest) => Promise<unknown>;
const RUNTIME = Symbol.for("pi-antigravity-acp:runtime"), ALLOWED = Symbol.for("pi-antigravity:pi-tools-allowed");

/**
 * Antigravity asks before every tool call outside "yolo", Pi's tools included: Gemini reaches them through the
 * provider's MCP server "pi-bridge", and each call was a question, or refused where none can be shown. Those calls run
 * as Pi tool calls under Pi's command guard, as Claude's do, so each is allowed once here; Antigravity's own commands
 * and edits still ask. This replaces the shared runtime's requestPermission (provider 0.1.23, src/runtime.ts). If a
 * later version renames it or the request fields, nothing is allowed here and every call asks again.
 */
function allowPiTools(): void {
	const runtime = (globalThis as Record<symbol, { runtime?: Record<string | symbol, unknown> } | undefined>)[RUNTIME]?.runtime;
	if (!runtime || runtime[ALLOWED] || typeof runtime.requestPermission !== "function") return;
	const ask = (runtime.requestPermission as Ask).bind(runtime);
	runtime.requestPermission = (binding: Binding | undefined, request: PermissionRequest) => {
		const meta = request?.toolCall?._meta, allow = request?.options?.find(option => option.kind === "allow_once");
		const piTool = meta?.is_mcp_tool_call === true && meta.mcp?.server === "pi-bridge";
		// A finished or cancelled turn goes to the provider, which refuses it.
		const live = !!binding?.writer && !binding.writer.finished && !binding.abortRequested;
		return piTool && allow && live ? Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } }) : ask(binding, request);
	};
	runtime[ALLOWED] = true;
}
