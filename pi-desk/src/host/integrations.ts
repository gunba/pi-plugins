import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPresentation } from "../../../pi-ui/index.ts";

/** Settings use public native commands; connection/auth state remains owned by Pi. */
export function installIntegrations(pi: ExtensionAPI): void {
	const presentation = getPresentation(pi);
	if (!presentation?.runCommand) return;
	const run = presentation.runCommand;
	pi.on("session_start", () => {
		const names = new Set(pi.getCommands().map(command => command.name));
		if (names.has("chrome-devtools")) {
			presentation.publish("desk-browser", { kind: "details", surface: "settings", title: "Chrome",
				data: { summary: "Browser tools operate Chrome on this computer, not the phone. These controls use the installed Chrome DevTools extension's RPC dialogs." },
				actions: [{ id: "settings", label: "Browser settings" }, { id: "tools", label: "Available tools" },
					{ id: "status", label: "Connection details" }, { id: "quickstart", label: "Setup help" }],
			}, Object.fromEntries(["settings", "tools", "status", "quickstart"].map(id => [id, () => run("chrome-devtools", id)])));
		}
		if (names.has("mcp")) {
			presentation.publish("desk-mcp", { kind: "details", surface: "settings", title: "MCP connections",
				data: { summary: "Pi connects the servers configured on this computer. Codemode calls their tools without adding the entire tool catalog to each prompt. Server status and sign-in use Pi's native /mcp command." },
				actions: [{ id: "status", label: "Server status" }, { id: "command", label: "Manage a server" }],
			}, {
				status: () => run("mcp", ""),
				command: async () => {
					const answer = await presentation.request({ kind: "input", title: "MCP command",
						placeholder: "reconnect gmail, login gmail, or logout gmail" });
					if (answer?.kind === "freeform" && answer.text.trim()) await run("mcp", answer.text.trim());
				},
			});
		}
	});
}
