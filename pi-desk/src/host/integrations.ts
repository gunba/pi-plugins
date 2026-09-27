import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPresentation, type UiDetails } from "../../../pi-ui/index.ts";

/** The adapter's documented status/v1 channel and public commands; no MCP client/state imports. */
export function installIntegrations(pi: ExtensionAPI): void {
	const presentation = getPresentation(pi);
	if (!presentation?.runCommand) return;
	const run = presentation.runCommand;
	let live = true;
	let servers: { name: string; status: string; toolCount: number; disabled: boolean }[] | undefined;
	const commands = () => new Set(pi.getCommands().map(command => command.name));
	const publish = (browser = false) => {
		if (!live) return;
		const names = commands();
		if (browser && names.has("chrome-devtools")) {
			presentation.publish("desk-browser", { kind: "details", surface: "settings", title: "Chrome",
				data: { summary: "Browser tools operate Chrome on this computer, not the phone. These controls use the installed Chrome DevTools extension's RPC dialogs." },
				actions: [{ id: "settings", label: "Browser settings" }, { id: "tools", label: "Available tools" },
					{ id: "status", label: "Connection details" }, { id: "quickstart", label: "Setup help" }],
			}, Object.fromEntries(["settings", "tools", "status", "quickstart"].map(id => [id, () => run("chrome-devtools", id)])));
		}
		if (!names.has("mcp")) return;
		const actions: Record<string, () => Promise<unknown>> = {};
		const data: UiDetails = {
			summary: "Connection state comes from the installed MCP adapter. Configuration uses Pi's Configuration panel. Secret setup stays on the host. Enable/disable changes apply after Reload resources.",
			items: servers?.map((server, index) => {
				const itemActions = [];
				// The public reconnect command takes one whitespace-delimited name.
				if (!/\s/.test(server.name)) {
					for (const [kind, label, command, args] of [
						["connect", "Connect / refresh", "mcp", `reconnect ${server.name}`],
						["auth", "Sign in", "mcp-auth", server.name],
						["enabled", server.disabled ? "Enable" : "Disable", "mcp", `${server.disabled ? "enable" : "disable"} ${server.name}`],
						["logout", "Sign out", "mcp", `logout ${server.name}`],
					]) {
						if (server.disabled && (kind === "connect" || kind === "auth")) continue;
						const id = `${kind}:${index}`;
						itemActions.push({ id, label, destructive: kind === "logout" });
						actions[id] = async () => {
							if (kind === "logout") {
								const answer = await presentation.request({ kind: "confirm", title: `Sign out of ${server.name}?`,
									message: "Remove this server's saved OAuth credentials and disconnect it. Other sessions may need to reconnect." });
								if (answer?.kind !== "confirm" || !answer.confirmed) return;
							}
							await run(command, args);
						};
					}
				}
				return { id: server.name, title: server.name, status: server.status,
					subtitle: `${server.toolCount} tools`, actions: itemActions };
			}),
			...(!servers ? { summary: "Waiting for the MCP adapter's status. Connect to initialize it. Existing adapter configuration and credential storage remain in use." } : {}),
		};
		presentation.publish("desk-mcp", { kind: "details", surface: "settings", title: "MCP connections", data,
			actions: [{ id: "connect", label: "Connect / refresh all" }, { id: "tools", label: "Tool catalog" }],
		}, { ...actions, connect: () => run("mcp", "reconnect"), tools: () => run("mcp", "tools") });
	};
	const unsubscribe = pi.events.on("pi-mcp-adapter/status/v1", value => {
		const snapshot = value as { version?: unknown; servers?: unknown };
		if (!live || snapshot?.version !== 1 || !Array.isArray(snapshot.servers)) return;
		servers = snapshot.servers.slice(0, 1000).filter(server => typeof server?.name === "string"
			&& typeof server.status === "string" && Number.isFinite(server.toolCount)).map(server => ({
				name: server.name, status: server.status, toolCount: server.toolCount, disabled: server.disabled === true,
			}));
		publish();
	});
	pi.on("session_start", () => publish(true));
	pi.on("session_shutdown", () => { live = false; unsubscribe(); });
}
