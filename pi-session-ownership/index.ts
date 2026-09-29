import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachOwnership, ownership, releaseOwnership, SessionLease, sessionPath } from "./lease.ts";
import { desktopHandoff } from "./handoff.ts";

export default function sessionOwnership(pi: ExtensionAPI): void {
	let handoff: { close(): void } | undefined;
	let revision = 0, transferring = false, switching = false;
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
	pi.on("session_start", async (_event, ctx) => {
		try { ensure(ctx); }
		catch (error) { ctx.ui.notify(String(error), "error"); ctx.shutdown(); throw error; }
		const started = ++revision;
		handoff?.close(); handoff = undefined; transferring = false; switching = false;
		const owner = ownership(ctx.sessionManager);
		if (ctx.mode !== "tui" || !owner || owner.managed) return;
		const current = () => {
			try {
				return started === revision && !switching && ctx.mode === "tui" && ownership(ctx.sessionManager)?.lease === owner.lease
					&& sessionPath(ctx.sessionManager.getSessionFile()!) === owner.lease.file;
			} catch { return false; }
		};
		try {
			const ready = await desktopHandoff(owner.lease, current, () => {
				if (!current()) throw new Error("The desktop session changed.");
				transferring = true;
				return () => {
					if (!current()) return;
					ctx.shutdown(); ctx.abort();
				};
			});
			if (started === revision) handoff = ready; else ready.close();
		} catch (error) { ctx.ui.notify(`Desktop takeover is unavailable: ${String(error)}`, "warning"); }
	});
	pi.on("input", (_event, ctx) => {
		if (transferring) return { action: "handled" };
		switching = false;
		try { ensure(ctx); }
		catch (error) { ctx.ui.notify(String(error), "error"); return { action: "handled" }; }
		return { action: "continue" };
	});
	pi.on("tool_call", (_event, ctx) => {
		if (transferring) return { block: true, reason: "This conversation is moving to Pi Desk." };
		try { ensure(ctx); }
		catch (error) { return { block: true, reason: String(error) }; }
	});
	pi.on("session_before_switch", (event, ctx) => {
		if (transferring) return { cancel: true };
		if (!event.targetSessionFile) { switching = true; return; }
		const current = ctx.sessionManager.getSessionFile();
		if (current && sessionPath(event.targetSessionFile) === sessionPath(current)) return { cancel: true };
		// Desk has already reserved its destination before asking Pi to switch.
		if (ownership(ctx.sessionManager)?.managed) return;
		try { new SessionLease(event.targetSessionFile).close(); }
		catch (error) { ctx.ui.notify(String(error), "error"); return { cancel: true }; }
		switching = true;
	});
	pi.on("session_before_fork", () => {
		if (transferring) return { cancel: true };
		switching = true;
	});
	pi.on("session_shutdown", (event, ctx) => {
		revision++; handoff?.close(); handoff = undefined;
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
