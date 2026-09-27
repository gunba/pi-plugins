import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachOwnership, ownership, releaseOwnership, SessionLease, sessionPath } from "./lease.ts";

export default function sessionOwnership(pi: ExtensionAPI): void {
	const ensure = (ctx: ExtensionContext) => {
		const manager = ctx.sessionManager;
		const file = manager.getSessionFile();
		if (!file) return;
		const current = ownership(manager);
		if (current?.lease.file === sessionPath(file)) return;
		const lease = new SessionLease(file);
		releaseOwnership(manager);
		attachOwnership(manager, lease, false);
	};
	pi.on("session_start", (_event, ctx) => {
		try { ensure(ctx); }
		catch (error) { ctx.ui.notify(String(error), "error"); ctx.shutdown(); throw error; }
	});
	pi.on("input", (_event, ctx) => {
		try { ensure(ctx); }
		catch (error) { ctx.ui.notify(String(error), "error"); return { action: "handled" }; }
		return { action: "continue" };
	});
	pi.on("tool_call", (_event, ctx) => {
		try { ensure(ctx); }
		catch (error) { return { block: true, reason: String(error) }; }
	});
	pi.on("session_before_switch", (event, ctx) => {
		if (!event.targetSessionFile) return;
		const current = ctx.sessionManager.getSessionFile();
		if (current && sessionPath(event.targetSessionFile) === sessionPath(current)) return { cancel: true };
		// Desk has already reserved its destination before asking Pi to switch.
		if (ownership(ctx.sessionManager)?.managed) return;
		try { new SessionLease(event.targetSessionFile).close(); }
		catch (error) { ctx.ui.notify(String(error), "error"); return { cancel: true }; }
	});
	pi.on("session_shutdown", (event, ctx) => {
		const manager = ctx.sessionManager;
		if (event.reason === "reload" || ownership(manager)?.managed) return;
		// Later shutdown handlers may still append entries. Release only after the
		// SDK invalidates this context; process exit releases the OS lock as well.
		const finish = () => {
			try { void ctx.mode; }
			catch { releaseOwnership(manager); return; }
			setTimeout(finish, 50).unref();
		};
		setTimeout(finish, 0).unref();
	});
}
