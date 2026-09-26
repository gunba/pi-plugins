import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerImageTools } from "./image-tools.ts";
import { CODEX_COMPAT_TOOL_NAMES, type ToolActivationState, syncCodexCompatTools } from "./model-tools.ts";
import { registerPatchTools } from "./patch-tools.ts";
import { createExecLifecycle, registerProcessTools } from "./process-tools.ts";

export default function codexCompat(pi: ExtensionAPI): void {
	const ownerFor = createExecLifecycle(pi);
	let activation: ToolActivationState = { enabled: false };
	const syncTools = (model: ExtensionContext["model"], ctx: Pick<ExtensionContext, "modelRegistry">) => {
		const result = syncCodexCompatTools(pi.getActiveTools(), model, activation, {
			imageGenerationAuthenticated: Boolean(model && ctx.modelRegistry.hasConfiguredAuth(model)),
		});
		activation = result.state;
		if (result.activeTools.join("\0") !== pi.getActiveTools().join("\0")) pi.setActiveTools(result.activeTools);
	};
	pi.on("session_start", (_event, ctx) => syncTools(ctx.model, ctx));
	pi.on("model_select", (event, ctx) => syncTools(event.model, ctx));
	pi.on("tool_result", event => {
		if (event.isError || !CODEX_COMPAT_TOOL_NAMES.includes(event.toolName)) return;
		if (!event.details || typeof event.details !== "object") return;
		const details = event.details as { error?: unknown; aborted?: unknown };
		if (typeof details.error === "string" || details.aborted === true) return { isError: true };
	});
	registerPatchTools(pi, ownerFor);
	registerProcessTools(pi, ownerFor);
	registerImageTools(pi);
}
