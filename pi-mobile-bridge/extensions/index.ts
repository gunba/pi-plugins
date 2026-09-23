import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureWorkUi } from "../../pi-work-ui/index.ts";
import { isManagedChild } from "../../pi-work-coordination/index.ts";
import { MOBILE_ASK_CLOSE, MOBILE_ASK_REQUEST, type MobileAskRequest } from "../bridge-events.ts";
import { PhoneHub } from "../hub.ts";
import { listSessions } from "../registry.ts";
import { SessionEndpoint } from "../session-endpoint.ts";
import { phoneToken, resetPhoneToken } from "../token.ts";

function phoneUrl(): string {
	try {
		const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], {
			encoding: "utf8", timeout: 2000, maxBuffer: 512_000, stdio: ["ignore", "pipe", "ignore"],
		})) as { Self?: { DNSName?: string } };
		const hostname = status.Self?.DNSName?.replace(/\.$/, "");
		if (hostname && /^[a-z0-9.-]+$/i.test(hostname)) return `https://${hostname}/`;
	} catch { /* Use the local address if Tailscale is not available. */ }
	return "http://127.0.0.1:8911/";
}

/** Every desktop Pi TUI advertises its own session; one process hosts the shared phone page. */
export default function mobileBridge(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_TASK_PATH || isManagedChild(pi)) return;
	const endpoint = new SessionEndpoint(pi, ensureWorkUi(pi));
	const hub = new PhoneHub();
	let ctx: ExtensionContext | undefined;
	let election: ReturnType<typeof setInterval> | undefined;
	let electing = false;

	const elect = async (): Promise<void> => {
		if (!endpoint.running || hub.running || electing) return;
		electing = true;
		try { await hub.start(); }
		catch (error) {
			try { ctx?.ui.notify(`Phone bridge unavailable: ${error instanceof Error ? error.message : String(error)}`, "error"); }
			catch { /* The desktop context may be retiring. */ }
		} finally { electing = false; }
	};

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		if (context.mode !== "tui") return;
		try {
			await endpoint.start(context);
			await elect();
			election = setInterval(() => { void elect(); }, 5000);
			election.unref();
		} catch (error) {
			context.ui.notify(`Phone bridge unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
	pi.on("session_shutdown", async () => {
		if (election) clearInterval(election);
		election = undefined;
		await endpoint.stop();
		await hub.stop();
		ctx = undefined;
	});
	pi.on("session_tree", (_event, context) => { ctx = context; endpoint.setContext(context); });
	pi.on("session_info_changed", () => endpoint.refresh());
	pi.on("agent_start", () => endpoint.refresh());
	pi.on("agent_settled", () => endpoint.settled());
	pi.on("message_update", event => {
		if (event.message.role === "assistant") {
			const text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			endpoint.updateLive(text);
		}
	});
	pi.on("message_end", event => { if (event.message.role === "assistant") endpoint.clearLive(); });
	pi.on("tool_execution_start", event => endpoint.startTool(event.toolCallId, event.toolName));
	pi.on("tool_execution_end", event => endpoint.endTool(event.toolCallId));
	pi.events.on(MOBILE_ASK_REQUEST, value => endpoint.acceptAsk(value as MobileAskRequest));
	pi.events.on(MOBILE_ASK_CLOSE, id => endpoint.closeAsk(id));

	pi.registerCommand("phone-token", {
		description: "Show the private phone URL and the pairing token shared by local Pi terminals.",
		handler: async (_args, context) => {
			try { context.ui.notify(`Open ${phoneUrl()} on your phone. Token: ${phoneToken()}`, "info"); }
			catch (error) { context.ui.notify(`Phone token unavailable: ${error instanceof Error ? error.message : String(error)}`, "error"); }
		},
	});
	pi.registerCommand("phone-status", {
		description: "Show whether this Pi hosts the phone page and how many desktop sessions are available.",
		handler: async (_args, context) => {
			context.ui.notify(`Phone bridge ${endpoint.running ? hub.running ? "hosting" : "connected" : "unavailable"} · ${listSessions().length} desktop Pi terminals`, "info");
		},
	});
	pi.registerCommand("phone-desktop", {
		description: "Return any pending phone question in this Pi terminal to its desktop dialog.",
		handler: async (_args, context) => { endpoint.releasePhone(); context.ui.notify("Pending question returned to this terminal", "info"); },
	});
	pi.registerCommand("phone-reset", {
		description: "Rotate the pairing token for every local Pi terminal.",
		handler: async (_args, context) => {
			if (!await context.ui.confirm("Rotate the phone pairing token?", "The phone will need the new token.")) return;
			context.ui.notify(`New phone token: ${resetPhoneToken()}`, "info");
		},
	});
}
